"""Endpoints reachable only through the BFF with a valid service signature (never public)."""
import json
import logging
import time
from collections.abc import AsyncIterator, Iterator
from contextlib import contextmanager
from uuid import UUID

import anyio
import psycopg
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .assistant import AssistantUnavailable, get_provider, is_configured, store
from .assistant.models import allowed_accounts, default_model_id, load_limits, load_models
from .assistant.provider import SYSTEM_PROMPT
from .db.connection import DatabaseUnavailable, connect_runtime
from .db.scope import owner_transaction

from .config import Settings, get_settings
from .service_auth import ServiceCall, require_service_call
from .status import health_payload

router = APIRouter(prefix="/internal/v1", include_in_schema=False)


@router.get("/ping")
def ping(settings: Settings = Depends(get_settings), _: ServiceCall = Depends(require_service_call)):
    """Proves the BFF -> API hop end to end: signature, freshness, replay protection, shared nonce store."""
    return health_payload(settings)


# ── Claude chat (CHAT-AI-1) ───────────────────────────────────────────────────────────────────────────────────────
# Every route below needs (1) a valid service signature, (2) an acting account, (3) that account on the API-side allow-list
# AI_ALLOWED_ACCOUNT_IDS and active in the database. Spending is bounded by a durable, atomic reservation (see assistant/store.py).
log = logging.getLogger("safwan.assistant")
_probe_cache: dict[str, tuple[float, bool]] = {}
_PROBE_TTL_S = 60.0


def _ai_account(settings: Settings, call: ServiceCall) -> UUID:
    if not is_configured(settings) or not settings.database_url:
        raise HTTPException(status_code=503, detail={"code": "assistant_unavailable"})
    if call.account_id is None or call.account_id not in allowed_accounts():
        raise HTTPException(status_code=403, detail={"code": "forbidden"})
    return call.account_id


def _db(settings: Settings):
    try:
        return connect_runtime(settings.database_url, production=settings.is_production, application_name="safwan-assistant")
    except DatabaseUnavailable:
        raise HTTPException(status_code=503, detail={"code": "assistant_unavailable"}) from None


def _guard(conn, account: UUID) -> None:
    try:
        ok = store.account_active(conn, account)
    except psycopg.Error:
        conn.close()
        raise HTTPException(status_code=503, detail={"code": "assistant_unavailable"}) from None
    if not ok:
        conn.close()
        raise HTTPException(status_code=403, detail={"code": "forbidden"})


@contextmanager
def _session(settings: Settings, call: ServiceCall) -> Iterator[tuple[object, UUID]]:
    account = _ai_account(settings, call)
    conn = _db(settings)
    try:
        _guard(conn, account)
        yield conn, account
    except psycopg.Error:
        log.warning("assistant db error")
        raise HTTPException(status_code=503, detail={"code": "assistant_unavailable"}) from None
    finally:
        conn.close()


def _usd(micro: int) -> float:
    return round(micro / 1_000_000, 6)


@router.get("/assistant/state")
def assistant_state(settings: Settings = Depends(get_settings), call: ServiceCall = Depends(require_service_call)):
    """Configuration + budget snapshot for the settings screen. Contains no secret and no key material."""
    models, limits = load_models(), load_limits()
    with _session(settings, call) as (conn, account):
        chosen = store.get_default_model(conn, account)
        used = store.usage(conn, account)
    assert limits is not None
    default = chosen if chosen in models else default_model_id(models)
    return {
        "provider": "anthropic",
        "models": [{"id": m.id, "label": m.label} for m in models.values()],
        "default_model": default,
        "limits": {"daily_usd": _usd(limits.daily_micro), "monthly_usd": _usd(limits.monthly_micro), "per_minute": limits.per_minute},
        "usage": {k: {"spent_usd": _usd(v["spent_micro"] + v["reserved_micro"]), "requests": v["requests"]} for k, v in used.items()},
    }


class ModelChoice(BaseModel):
    model: str = Field(min_length=1, max_length=100)


@router.post("/assistant/settings")
def assistant_set_model(body: ModelChoice, settings: Settings = Depends(get_settings), call: ServiceCall = Depends(require_service_call)):
    if body.model not in load_models():
        raise HTTPException(status_code=422, detail={"code": "unknown_model"})
    with _session(settings, call) as (conn, account):
        store.set_default_model(conn, account, body.model)
    return {"default_model": body.model}


@router.post("/assistant/probe")
def assistant_probe(settings: Settings = Depends(get_settings), call: ServiceCall = Depends(require_service_call)):
    """Real, free provider liveness check (GET /v1/models/{id}); cached 60 s so it cannot be used to hammer the provider."""
    with _session(settings, call) as (conn, account):
        model = store.get_default_model(conn, account)
    models = load_models()
    model = model if model in models else default_model_id(models)
    assert model is not None
    now = time.monotonic()
    hit = _probe_cache.get(model)
    if hit and now - hit[0] < _PROBE_TTL_S:
        return {"model": model, "reachable": hit[1], "cached": True}
    ok = get_provider(settings).probe(model)
    _probe_cache[model] = (now, ok)
    return {"model": model, "reachable": ok, "cached": False}


@router.get("/assistant/conversations")
def assistant_conversations(settings: Settings = Depends(get_settings), call: ServiceCall = Depends(require_service_call)):
    with _session(settings, call) as (conn, account):
        return {"conversations": store.list_conversations(conn, account)}


@router.get("/assistant/conversations/{conversation_id}")
def assistant_conversation(conversation_id: UUID, settings: Settings = Depends(get_settings), call: ServiceCall = Depends(require_service_call)):
    with _session(settings, call) as (conn, account):
        found = store.get_conversation(conn, account, conversation_id)
    if found is None:
        raise HTTPException(status_code=404, detail={"code": "not_found"})  # another account's id is indistinguishable from a missing one
    return found


@router.post("/assistant/conversations/{conversation_id}/delete")
def assistant_delete_conversation(conversation_id: UUID, settings: Settings = Depends(get_settings), call: ServiceCall = Depends(require_service_call)):
    with _session(settings, call) as (conn, account):
        gone = store.delete_conversation(conn, account, conversation_id)
    if not gone:
        raise HTTPException(status_code=404, detail={"code": "not_found"})
    return {"deleted": True}


class ChatRequest(BaseModel):
    conversation_id: UUID
    message: str = Field(min_length=1, max_length=8000)
    model: str | None = Field(default=None, max_length=100)


def _line(obj: dict) -> bytes:
    return (json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


async def _pump(it: Iterator[bytes]) -> AsyncIterator[bytes]:
    """Drive the blocking generator in a worker thread and ALWAYS close it, so a client that goes away (Stop, lost signal, closed app)
    deterministically tears down the upstream request and settles the spend instead of waiting for garbage collection."""
    try:
        while True:
            chunk = await anyio.to_thread.run_sync(next, it, None)
            if chunk is None:
                break
            yield chunk
    finally:
        with anyio.CancelScope(shield=True):
            await anyio.to_thread.run_sync(it.close)


@router.post("/assistant/chat")
def assistant_chat(body: ChatRequest, settings: Settings = Depends(get_settings), call: ServiceCall = Depends(require_service_call)):
    """Streams one Claude answer as NDJSON. Order of operations is deliberate:
    1) authorise  2) pick model  3) RESERVE budget+rate (atomic; refusal = plain JSON error, nothing sent to Claude)
    4) persist the user turn  5) stream  6) persist the answer (even a stopped/partial one) and SETTLE the real cost."""
    if not body.message.strip():
        raise HTTPException(status_code=422, detail={"code": "empty_message"})
    account = _ai_account(settings, call)
    models, limits = load_models(), load_limits()
    assert limits is not None
    conn = _db(settings)
    reservation = None
    try:
        _guard(conn, account)
        chosen = body.model or store.get_default_model(conn, account)
        model = models.get(chosen or "") or models[default_model_id(models) or ""]
        if body.model and body.model not in models:
            raise HTTPException(status_code=422, detail={"code": "unknown_model"})
        try:
            # One transaction: if the rate/budget reservation is refused, the user turn is rolled back too (a refused request leaves no trace).
            with owner_transaction(conn, account):
                turns, seq = store.append_user_message(conn, account, body.conversation_id, body.message, model.id)
                max_out = min(limits.max_output_tokens, model.max_output)
                est_in = sum(len(t["content"]) for t in turns) + len(SYSTEM_PROMPT) + 64  # 1 token/char is an upper bound for this text
                reservation = store.reserve(conn, account, model.cost_micro(est_in, max_out), daily_cap=limits.daily_micro, monthly_cap=limits.monthly_micro, per_minute=limits.per_minute)
        except KeyError:
            raise HTTPException(status_code=404, detail={"code": "not_found"}) from None
        except store.ConversationFull:
            raise HTTPException(status_code=409, detail={"code": "conversation_full"}) from None
        except store.LimitExceeded as e:
            raise HTTPException(status_code=429, detail={"code": e.code}) from None
    except HTTPException:
        conn.close()
        raise
    except psycopg.Error:
        conn.close()
        raise HTTPException(status_code=503, detail={"code": "assistant_unavailable"}) from None
    provider = get_provider(settings)

    def run() -> Iterator[bytes]:
        text: list[str] = []
        in_tok = out_tok = 0
        started = failed = False
        code = ""
        completed = False
        stream = None
        try:
            yield _line({"type": "start", "conversation_id": str(body.conversation_id), "model": model.id})
            stream = provider.stream(model=model.id, turns=turns, max_tokens=max_out)
            for ev in stream:
                started = True
                if ev.kind == "delta":
                    text.append(ev.text)
                    yield _line({"type": "delta", "text": ev.text})
                else:
                    in_tok, out_tok = ev.input_tokens or in_tok, ev.output_tokens or out_tok
                    completed = completed or ev.kind == "stop"
        except AssistantUnavailable as e:
            failed, code = True, e.code
        except GeneratorExit:
            failed, code = True, "client_stopped"
            raise
        except Exception:  # noqa: BLE001 - never leak provider/driver details
            log.exception("assistant stream failed")
            failed, code = True, "assistant_unavailable"
        finally:
            if stream is not None:
                stream.close()  # drops the upstream HTTP connection immediately (Stop / disconnect)
            answer = "".join(text)
            # Billing is conservative when we did not see the final usage: charge the estimated input and 1 token per streamed char.
            if completed:
                spend_in, spend_out = in_tok, out_tok
            elif started:
                spend_in, spend_out = in_tok or est_in, max(out_tok, len(answer))
            else:
                spend_in = spend_out = 0
            actual = model.cost_micro(spend_in, spend_out)
            try:
                if answer:
                    store.append_assistant_message(conn, account, body.conversation_id, seq, answer, {"model": model.id, "partial": not completed, "input_tokens": spend_in, "output_tokens": spend_out})
            except psycopg.Error:
                log.warning("assistant persist failed")
            try:
                store.settle(conn, account, reservation, actual, spend_in, spend_out)
            except psycopg.Error:
                log.warning("assistant settle failed")
            conn.close()
        if failed:
            yield _line({"type": "error", "code": code})
        else:
            yield _line({"type": "done", "usage": {"input_tokens": spend_in, "output_tokens": spend_out, "cost_usd": _usd(actual)}})

    return StreamingResponse(_pump(run()), media_type="application/x-ndjson", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff"})
