"""Server-side model catalogue and limits. Pricing is operator-supplied (never guessed in code): a model with no price is unusable,
because a hard budget cannot be enforced without one."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from uuid import UUID


@dataclass(frozen=True)
class ModelInfo:
    id: str
    label: str
    input_per_mtok: Decimal   # USD per million input tokens
    output_per_mtok: Decimal  # USD per million output tokens
    max_output: int

    def cost_micro(self, input_tokens: int, output_tokens: int) -> int:
        """USD/MTok == micro-USD/token, so this is exact; always rounded UP."""
        total = Decimal(input_tokens) * self.input_per_mtok + Decimal(output_tokens) * self.output_per_mtok
        return int(total.to_integral_value(rounding="ROUND_CEILING"))


@dataclass(frozen=True)
class Limits:
    daily_micro: int
    monthly_micro: int
    per_minute: int
    max_output_tokens: int


def _usd_to_micro(raw: str) -> int | None:
    try:
        value = Decimal(raw.strip())
    except (InvalidOperation, AttributeError):
        return None
    if not value.is_finite() or value <= 0 or value > 100000:
        return None
    return int((value * 1_000_000).to_integral_value(rounding="ROUND_FLOOR"))


def load_models(env: dict[str, str] | None = None) -> dict[str, ModelInfo]:
    env = os.environ if env is None else env
    try:
        raw = json.loads(env.get("ANTHROPIC_MODELS", "") or "[]")
    except ValueError:
        return {}
    out: dict[str, ModelInfo] = {}
    if not isinstance(raw, list) or len(raw) > 12:
        return {}
    for item in raw:
        try:
            mid = str(item["id"]).strip()
            ip, op = Decimal(str(item["input_per_mtok"])), Decimal(str(item["output_per_mtok"]))
            mx = int(item.get("max_output", 4096))
        except (KeyError, TypeError, ValueError, InvalidOperation):
            return {}  # a malformed catalogue disables the feature rather than half-working
        if not (1 <= len(mid) <= 100) or not ip.is_finite() or not op.is_finite() or ip <= 0 or op <= 0 or not 1 <= mx <= 64000:
            return {}
        out[mid] = ModelInfo(mid, str(item.get("label") or mid)[:60], ip, op, mx)
    return out


def default_model_id(models: dict[str, ModelInfo], env: dict[str, str] | None = None) -> str | None:
    env = os.environ if env is None else env
    want = (env.get("ANTHROPIC_DEFAULT_MODEL") or "").strip()
    if want in models:
        return want
    return next(iter(models), None)


def load_limits(env: dict[str, str] | None = None) -> Limits | None:
    """None (=> the feature stays off) unless BOTH a daily and a monthly dollar cap are set. There is no 'unlimited' default."""
    env = os.environ if env is None else env
    day, month = _usd_to_micro(env.get("AI_DAILY_BUDGET_USD", "")), _usd_to_micro(env.get("AI_MONTHLY_BUDGET_USD", ""))
    if day is None or month is None or day > month:
        return None
    try:
        rpm = int(env.get("AI_REQUESTS_PER_MINUTE", "10"))
        out = int(env.get("ANTHROPIC_MAX_OUTPUT_TOKENS", "1024"))
    except ValueError:
        return None
    if not 1 <= rpm <= 600 or not 1 <= out <= 16000:
        return None
    return Limits(day, month, rpm, out)


def allowed_accounts(env: dict[str, str] | None = None) -> frozenset[UUID]:
    """API-side allow-list (defence in depth): even a validly signed call may only act for these accounts."""
    env = os.environ if env is None else env
    ids: set[UUID] = set()
    for part in (env.get("AI_ALLOWED_ACCOUNT_IDS") or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            u = UUID(part)
        except ValueError:
            return frozenset()
        if u.int == 0:
            return frozenset()
        ids.add(u)
    return frozenset(ids)
