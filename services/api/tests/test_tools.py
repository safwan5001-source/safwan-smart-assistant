from app.audit import AuditLog
from app.permissions import PermissionMode as M, Risk
from app.tools import ToolRegistry, ToolSpec, execute_tool


def make():
    calls = []
    reg = ToolRegistry()
    reg.register(ToolSpec("t.read", "r", "", Risk.read, lambda a: {"ok": True}))
    reg.register(ToolSpec("t.write", "w", "", Risk.write, lambda a: calls.append("w") or {"ok": True}))
    reg.register(ToolSpec("t.sensitive", "s", "", Risk.sensitive, lambda a: calls.append("s") or {"ok": True}))
    reg.register(ToolSpec("t.boom", "b", "", Risk.read, lambda a: 1 / 0))
    reg.register(ToolSpec("t.planned", "p", "", Risk.read, None))
    return reg, calls, AuditLog()


def run(reg, log, tool, mode, args=None):
    return execute_tool(reg, tool, args or {}, mode, actor="tester", log=log)


def test_read_runs_in_every_mode():
    reg, _, log = make()
    assert all(run(reg, log, "t.read", m).status == "executed" for m in M)


def test_review_mode_blocks_writes_without_running_handler():
    reg, calls, log = make()
    assert run(reg, log, "t.write", M.review).status == "denied"
    assert calls == []


def test_approve_mode_holds_writes():
    reg, calls, log = make()
    assert run(reg, log, "t.write", M.approve).status == "approval_required"
    assert calls == []


def test_execute_mode_runs_writes_but_holds_sensitive():
    reg, calls, log = make()
    assert run(reg, log, "t.write", M.execute).status == "executed"
    assert run(reg, log, "t.sensitive", M.execute).status == "approval_required"
    assert calls == ["w"]


def test_unimplemented_and_unknown_tools_never_run():
    reg, _, log = make()
    assert run(reg, log, "t.planned", M.execute).status == "not_implemented"
    assert run(reg, log, "nope", M.execute).status == "unknown_tool"


def test_handler_error_is_contained():
    reg, _, log = make()
    result = run(reg, log, "t.boom", M.execute)
    assert result.status == "failed" and result.output is None


def test_audit_records_decisions_but_not_argument_values():
    reg, _, log = make()
    run(reg, log, "t.write", M.review, {"secret": "hunter2"})
    entry = log.recent()[0]
    assert entry["status"] == "denied" and entry["argument_keys"] == ["secret"]
    assert "hunter2" not in str(entry)


def test_duplicate_registration_rejected():
    reg, _, _ = make()
    try:
        reg.register(ToolSpec("t.read", "again", "", Risk.read))
    except ValueError:
        return
    raise AssertionError("expected ValueError")
