"""Tool registry and the single execution gate.

UI and chat never call tool handlers directly: they ask `execute_tool`, which
checks existence, implementation status and the permission policy, and audits
the outcome. A tool declared but not implemented is listed honestly as such and
can never run.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from ..audit import AuditLog, audit_log
from ..permissions import PermissionMode, Risk, Verdict, evaluate

Handler = Callable[[dict[str, Any]], dict[str, Any]]


@dataclass(frozen=True)
class ToolSpec:
    id: str
    title: str
    description: str
    risk: Risk
    handler: Handler | None = None
    integration: str | None = None  # id of the integration this tool depends on

    @property
    def implemented(self) -> bool:
        return self.handler is not None

    def public(self) -> dict[str, Any]:
        return {"id": self.id, "title": self.title, "description": self.description, "risk": self.risk.value,
                "implemented": self.implemented, "integration": self.integration}


@dataclass
class ToolRegistry:
    _tools: dict[str, ToolSpec] = field(default_factory=dict)

    def register(self, spec: ToolSpec) -> ToolSpec:
        if spec.id in self._tools:
            raise ValueError(f"duplicate tool id: {spec.id}")
        self._tools[spec.id] = spec
        return spec

    def get(self, tool_id: str) -> ToolSpec | None:
        return self._tools.get(tool_id)

    def all(self) -> list[ToolSpec]:
        return list(self._tools.values())


@dataclass(frozen=True)
class ExecutionResult:
    status: str  # executed | denied | approval_required | not_implemented | unknown_tool | failed
    tool: str
    mode: PermissionMode
    risk: str | None = None
    reason_code: str | None = None
    output: dict[str, Any] | None = None

    def public(self) -> dict[str, Any]:
        return {"status": self.status, "tool": self.tool, "mode": self.mode.value, "risk": self.risk,
                "reason_code": self.reason_code, "output": self.output}


def execute_tool(reg: ToolRegistry, tool_id: str, arguments: dict[str, Any], mode: PermissionMode,
                 *, actor: str = "unknown", log: AuditLog | None = None) -> ExecutionResult:
    log = log or audit_log
    spec = reg.get(tool_id)

    def done(result: ExecutionResult) -> ExecutionResult:
        log.record("tool.execute", actor=actor, tool=tool_id, mode=mode.value, risk=result.risk,
                   status=result.status, reason_code=result.reason_code, argument_keys=sorted(arguments))
        return result

    if spec is None:
        return done(ExecutionResult("unknown_tool", tool_id, mode, reason_code="unknown_tool"))
    if not spec.implemented:
        return done(ExecutionResult("not_implemented", tool_id, mode, spec.risk.value, "tool_not_implemented"))
    decision = evaluate(mode, spec.risk)
    if decision.verdict is Verdict.deny:
        return done(ExecutionResult("denied", tool_id, mode, spec.risk.value, decision.reason_code))
    if decision.verdict is Verdict.require_approval:
        # No approval channel exists yet, so the operation is held, never executed.
        return done(ExecutionResult("approval_required", tool_id, mode, spec.risk.value, decision.reason_code))
    try:
        assert spec.handler is not None
        output = spec.handler(arguments)
    except Exception:  # noqa: BLE001 - never leak internals to the caller
        return done(ExecutionResult("failed", tool_id, mode, spec.risk.value, "handler_error"))
    return done(ExecutionResult("executed", tool_id, mode, spec.risk.value, decision.reason_code, output))


registry = ToolRegistry()
