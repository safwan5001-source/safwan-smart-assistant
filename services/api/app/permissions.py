"""Permission policy: how a task's mode and an action's risk combine.

Modes (chosen by the user per task):
  review  - read only, nothing is modified
  execute - reads and writes inside the delegated scope
  approve - prepare, then wait for explicit approval before saving/sending

Risks (declared by each tool):
  read      - no side effects
  write     - changes data in a reversible/ordinary way
  sensitive - money movement, mass deletion, outbound messages, anything hard to undo

`sensitive` is never auto-allowed: it always needs a specific approval for that
operation, regardless of mode.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class PermissionMode(str, Enum):
    review = "review"
    execute = "execute"
    approve = "approve"


class Risk(str, Enum):
    read = "read"
    write = "write"
    sensitive = "sensitive"


class Verdict(str, Enum):
    allow = "allow"
    require_approval = "require_approval"
    deny = "deny"


@dataclass(frozen=True)
class Decision:
    verdict: Verdict
    reason_code: str


_POLICY: dict[tuple[PermissionMode, Risk], Decision] = {
    (PermissionMode.review, Risk.read): Decision(Verdict.allow, "read_allowed"),
    (PermissionMode.review, Risk.write): Decision(Verdict.deny, "review_mode_blocks_writes"),
    (PermissionMode.review, Risk.sensitive): Decision(Verdict.deny, "review_mode_blocks_sensitive"),
    (PermissionMode.execute, Risk.read): Decision(Verdict.allow, "read_allowed"),
    (PermissionMode.execute, Risk.write): Decision(Verdict.allow, "write_allowed_in_execute_mode"),
    (PermissionMode.execute, Risk.sensitive): Decision(Verdict.require_approval, "sensitive_needs_explicit_approval"),
    (PermissionMode.approve, Risk.read): Decision(Verdict.allow, "read_allowed"),
    (PermissionMode.approve, Risk.write): Decision(Verdict.require_approval, "approve_mode_needs_approval"),
    (PermissionMode.approve, Risk.sensitive): Decision(Verdict.require_approval, "sensitive_needs_explicit_approval"),
}


def evaluate(mode: PermissionMode, risk: Risk) -> Decision:
    return _POLICY[(mode, risk)]


def policy_matrix() -> list[dict[str, str]]:
    return [
        {"mode": m.value, "risk": r.value, "verdict": d.verdict.value, "reason_code": d.reason_code}
        for (m, r), d in _POLICY.items()
    ]
