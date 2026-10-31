from fastapi.testclient import TestClient

from app.main import app


def test_tools_listing_marks_planned_tools_honestly(client):
    tools = {t["id"]: t for t in client.get("/tools").json()["tools"]}
    assert tools["system.time"]["implemented"] is True
    assert tools["email.send"]["implemented"] is False and tools["email.send"]["risk"] == "sensitive"
    assert tools["payments.transfer"]["risk"] == "sensitive"


def test_execute_read_tool(client):
    r = client.post("/tools/execute", json={"tool": "system.time", "permission_mode": "review"})
    assert r.status_code == 200 and r.json()["status"] == "executed" and "utc" in r.json()["output"]


def test_execute_sensitive_tool_is_not_run(client):
    r = client.post("/tools/execute", json={"tool": "email.send", "permission_mode": "execute"})
    assert r.status_code == 200 and r.json()["status"] == "not_implemented"


def test_execute_unknown_tool_404(client):
    r = client.post("/tools/execute", json={"tool": "x.y", "permission_mode": "execute"})
    assert r.status_code == 404


def test_execute_requires_permission_mode(client):
    assert client.post("/tools/execute", json={"tool": "system.time"}).status_code == 422


def test_audit_trail_after_execution(client):
    client.post("/tools/execute", json={"tool": "system.time", "permission_mode": "review"})
    entries = client.get("/audit").json()["entries"]
    assert entries[0]["tool"] == "system.time" and entries[0]["status"] == "executed"


def test_integrations_all_planned_and_no_secrets(client):
    body = client.get("/integrations").json()["integrations"]
    assert body and all(i["status"] == "planned" for i in body)
    assert client.get("/integrations/github").json()["id"] == "github"
    assert client.get("/integrations/none").status_code == 404
    assert client.get("/capabilities").json()["integrations"]["connected"] == 0


def test_assistant_reports_unavailable_instead_of_inventing_a_reply(client):
    r = client.post("/assistant/respond", json={"messages": [{"role": "user", "content": "مرحبا"}]})
    assert r.status_code == 503 and r.json()["detail"]["code"] == "assistant_not_configured"
    assert client.get("/capabilities").json()["assistant"]["configured"] is False


def test_assistant_unknown_provider_is_still_unavailable(client, monkeypatch):
    monkeypatch.setenv("ASSISTANT_PROVIDER", "openai")
    r = client.post("/assistant/respond", json={"messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 503


def test_policy_endpoint(client):
    body = client.get("/permissions/policy").json()
    assert len(body["matrix"]) == 9


def test_openapi_is_valid():
    assert TestClient(app).get("/openapi.json").status_code == 200
