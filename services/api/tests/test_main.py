from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"

def test_task_does_not_execute():
    response = client.post("/tasks", json={"instruction": "راجع الفواتير", "permission_mode": "review"})
    assert response.status_code == 202
    assert response.json()["status"] == "not_scheduled"

def test_permission_required():
    response = client.post("/tasks", json={"instruction": "راجع الفواتير"})
    assert response.status_code == 422
