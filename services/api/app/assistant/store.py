"""PostgreSQL persistence for Claude chat: hard budget / rate reservations, per-account settings, and durable conversations
(stored in the existing `sync_records` table). Every function runs inside `owner_transaction`, so row-level security scopes it to the
verified account; nothing here accepts an account id from request data."""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from uuid import UUID, uuid4

import psycopg
from psycopg.types.json import Jsonb

from ..db.scope import owner_transaction

MAX_MESSAGES_PER_CONVERSATION = 400
CONTEXT_TURNS = 40


class LimitExceeded(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code  # "rate_limited" | "budget_daily" | "budget_monthly"


class ConversationFull(Exception):
    pass


@dataclass(frozen=True)
class Reservation:
    micro: int
    day: str
    month: str


def periods(now: datetime | None = None) -> tuple[str, str]:
    n = now or datetime.now(timezone.utc)
    return f"day:{n:%Y-%m-%d}", f"month:{n:%Y-%m}"


def account_active(conn: psycopg.Connection, account: UUID) -> bool:
    with owner_transaction(conn, account):
        row = conn.execute("SELECT disabled_at IS NULL FROM accounts WHERE id = %s", (account,)).fetchone()
    return bool(row and row[0])


# ── budget & rate ──────────────────────────────────────────────────────────
_RESERVE = """
INSERT INTO ai_usage (account_id, period, reserved_micro, requests) VALUES (%(a)s, %(p)s, %(m)s, 1)
ON CONFLICT (account_id, period) DO UPDATE
   SET reserved_micro = ai_usage.reserved_micro + EXCLUDED.reserved_micro, requests = ai_usage.requests + 1, updated_at = now()
 WHERE ai_usage.spent_micro + ai_usage.reserved_micro + EXCLUDED.reserved_micro <= %(cap)s
RETURNING 1
"""
_RATE = """
INSERT INTO ai_rate (account_id, window_start, count) VALUES (%(a)s, date_trunc('minute', now()), 1)
ON CONFLICT (account_id, window_start) DO UPDATE SET count = ai_rate.count + 1
 WHERE ai_rate.count < %(cap)s
RETURNING 1
"""


def reserve(conn: psycopg.Connection, account: UUID, estimate_micro: int, *, daily_cap: int, monthly_cap: int, per_minute: int) -> Reservation:
    """Atomically take rate + daily + monthly allowance in ONE transaction: all succeed or none is taken. Concurrent callers
    serialise on the row locks, so the caps cannot be overshot by parallel requests."""
    if estimate_micro > daily_cap:
        raise LimitExceeded("budget_daily")
    day, month = periods()
    with owner_transaction(conn, account):
        if conn.execute(_RATE, {"a": account, "cap": per_minute}).fetchone() is None:
            raise LimitExceeded("rate_limited")
        if conn.execute(_RESERVE, {"a": account, "p": day, "m": estimate_micro, "cap": daily_cap}).fetchone() is None:
            raise LimitExceeded("budget_daily")
        if conn.execute(_RESERVE, {"a": account, "p": month, "m": estimate_micro, "cap": monthly_cap}).fetchone() is None:
            raise LimitExceeded("budget_monthly")
    return Reservation(estimate_micro, day, month)


def settle(conn: psycopg.Connection, account: UUID, r: Reservation, actual_micro: int, input_tokens: int, output_tokens: int) -> None:
    """Replace the reservation with what was really consumed (never more than reserved was *checked* — but a real cost above the
    estimate is still recorded so the ledger stays truthful)."""
    with owner_transaction(conn, account):
        for period in (r.day, r.month):
            conn.execute(
                "UPDATE ai_usage SET reserved_micro = GREATEST(reserved_micro - %s, 0), spent_micro = spent_micro + %s, "
                "input_tokens = input_tokens + %s, output_tokens = output_tokens + %s, updated_at = now() WHERE account_id = %s AND period = %s",
                (r.micro, actual_micro, input_tokens, output_tokens, account, period),
            )


def usage(conn: psycopg.Connection, account: UUID) -> dict[str, dict[str, int]]:
    day, month = periods()
    out = {"day": {"spent_micro": 0, "reserved_micro": 0, "requests": 0}, "month": {"spent_micro": 0, "reserved_micro": 0, "requests": 0}}
    with owner_transaction(conn, account):
        for period, spent, reserved, req in conn.execute(
            "SELECT period, spent_micro, reserved_micro, requests FROM ai_usage WHERE period IN (%s, %s)", (day, month)
        ).fetchall():
            out["day" if period.startswith("day:") else "month"] = {"spent_micro": spent, "reserved_micro": reserved, "requests": req}
    return out


# ── settings ───────────────────────────────────────────────────────────────
def get_default_model(conn: psycopg.Connection, account: UUID) -> str | None:
    with owner_transaction(conn, account):
        row = conn.execute("SELECT default_model FROM ai_settings WHERE account_id = %s", (account,)).fetchone()
    return row[0] if row else None


def set_default_model(conn: psycopg.Connection, account: UUID, model: str) -> None:
    with owner_transaction(conn, account):
        conn.execute(
            "INSERT INTO ai_settings (account_id, default_model) VALUES (%s, %s) "
            "ON CONFLICT (account_id) DO UPDATE SET default_model = EXCLUDED.default_model, updated_at = now()",
            (account, model),
        )


# ── conversations (sync_records kinds 'conversation' / 'message') ───────────
def _title(text: str) -> str:
    t = " ".join(text.split())
    return (t[:60] + "…") if len(t) > 60 else (t or "محادثة")


def conversation_exists(conn: psycopg.Connection, account: UUID, cid: UUID) -> bool:
    with owner_transaction(conn, account):
        return conn.execute(
            "SELECT 1 FROM sync_records WHERE kind='conversation' AND id=%s AND deleted_at IS NULL", (cid,)
        ).fetchone() is not None


def append_user_message(conn: psycopg.Connection, account: UUID, cid: UUID, text: str, model: str) -> tuple[list[dict[str, str]], int]:
    """Create the conversation on first use, store the user turn, and return the context to send (last CONTEXT_TURNS turns) and seq."""
    with owner_transaction(conn, account):
        row = conn.execute("SELECT deleted_at FROM sync_records WHERE kind='conversation' AND id=%s FOR UPDATE", (cid,)).fetchone()
        if row is not None and row[0] is not None:
            raise KeyError("deleted")
        if row is None:
            conn.execute(
                "INSERT INTO sync_records (account_id, kind, id, body) VALUES (%s, 'conversation', %s, %s)",
                (account, cid, Jsonb({"title": _title(text), "model": model, "count": 0})),
            )
        n = conn.execute("SELECT count(*) FROM sync_records WHERE kind='message' AND body->>'conversation_id' = %s", (str(cid),)).fetchone()[0]
        if n >= MAX_MESSAGES_PER_CONVERSATION:
            raise ConversationFull()
        _insert_message(conn, account, cid, n + 1, "user", text, None)
        conn.execute(
            "UPDATE sync_records SET body = body || %s, revision = revision + 1, updated_at = now() WHERE kind='conversation' AND id=%s",
            (Jsonb({"count": n + 1, "model": model}), cid),
        )
        rows = conn.execute(
            "SELECT body->>'role', body->>'content' FROM sync_records WHERE kind='message' AND deleted_at IS NULL AND body->>'conversation_id' = %s "
            "ORDER BY (body->>'seq')::int DESC LIMIT %s",
            (str(cid), CONTEXT_TURNS),
        ).fetchall()
    turns = [{"role": r, "content": c} for r, c in reversed(rows)]
    # Anthropic requires alternating roles starting with user: collapse consecutive same-role turns (e.g. after a failed reply).
    merged: list[dict[str, str]] = []
    for t in turns:
        if merged and merged[-1]["role"] == t["role"]:
            merged[-1]["content"] += "\n\n" + t["content"]
        else:
            merged.append(dict(t))
    while merged and merged[0]["role"] != "user":
        merged.pop(0)
    return merged, n + 1


def _insert_message(conn: psycopg.Connection, account: UUID, cid: UUID, seq: int, role: str, content: str, extra: dict | None) -> UUID:
    mid = uuid4()
    body = {"conversation_id": str(cid), "seq": seq, "role": role, "content": content, **(extra or {})}
    conn.execute("INSERT INTO sync_records (account_id, kind, id, body) VALUES (%s, 'message', %s, %s)", (account, mid, Jsonb(body)))
    return mid


def append_assistant_message(conn: psycopg.Connection, account: UUID, cid: UUID, seq: int, text: str, extra: dict) -> UUID:
    with owner_transaction(conn, account):
        mid = _insert_message(conn, account, cid, seq + 1, "assistant", text, extra)
        conn.execute(
            "UPDATE sync_records SET body = body || %s, revision = revision + 1, updated_at = now() WHERE kind='conversation' AND id=%s",
            (Jsonb({"count": seq + 1}), cid),
        )
    return mid


def list_conversations(conn: psycopg.Connection, account: UUID, limit: int = 50) -> list[dict]:
    with owner_transaction(conn, account):
        rows = conn.execute(
            "SELECT id, body->>'title', (body->>'count')::int, body->>'model', updated_at FROM sync_records "
            "WHERE kind='conversation' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT %s", (limit,)
        ).fetchall()
    return [{"id": str(i), "title": t, "count": c, "model": m, "updated": u.isoformat()} for i, t, c, m, u in rows]


def get_conversation(conn: psycopg.Connection, account: UUID, cid: UUID) -> dict | None:
    with owner_transaction(conn, account):
        head = conn.execute(
            "SELECT body->>'title', body->>'model', updated_at FROM sync_records WHERE kind='conversation' AND id=%s AND deleted_at IS NULL", (cid,)
        ).fetchone()
        if head is None:
            return None
        rows = conn.execute(
            "SELECT id, body->>'role', body->>'content', coalesce((body->>'partial')::boolean,false), created FROM ("
            "SELECT id, body, (body->>'seq')::int AS s, updated_at AS created FROM sync_records WHERE kind='message' AND deleted_at IS NULL "
            "AND body->>'conversation_id' = %s) q ORDER BY s", (str(cid),)
        ).fetchall()
    return {
        "id": str(cid), "title": head[0], "model": head[1], "updated": head[2].isoformat(),
        "messages": [{"id": str(i), "role": r, "content": c, "partial": p, "created": cr.isoformat()} for i, r, c, p, cr in rows],
    }


def delete_conversation(conn: psycopg.Connection, account: UUID, cid: UUID) -> bool:
    """Tombstone (the application role has no DELETE grant): the conversation and all its messages disappear from reads."""
    with owner_transaction(conn, account):
        row = conn.execute(
            "UPDATE sync_records SET deleted_at = now(), revision = revision + 1, updated_at = now() WHERE kind='conversation' AND id=%s AND deleted_at IS NULL RETURNING 1",
            (cid,),
        ).fetchone()
        if row:
            conn.execute(
                "UPDATE sync_records SET deleted_at = now(), body = jsonb_build_object('conversation_id', body->>'conversation_id', 'seq', body->'seq', 'role', body->'role', 'content', ''), "
                "revision = revision + 1, updated_at = now() WHERE kind='message' AND deleted_at IS NULL AND body->>'conversation_id' = %s", (str(cid),)
            )
    return row is not None
