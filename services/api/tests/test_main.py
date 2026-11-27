def test_health(client):
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["features"] == {"assistant": False, "connected_integrations": 0, "task_execution": False, "basht": "unconfigured", "basht_chat": False, "owner_auth": False, "passkeys": False}


def test_task_does_not_execute(client):
    response = client.post("/tasks", json={"instruction": "راجع الفواتير", "permission_mode": "review"})
    assert response.status_code == 202
    assert response.json()["status"] == "not_scheduled"


def test_permission_required(client):
    response = client.post("/tasks", json={"instruction": "راجع الفواتير"})
    assert response.status_code == 422
