"""Smoke test for /health.

This intentionally does not require the ensemble to be trained; it only
verifies that the sidecar boots and reports which optional dependencies
imported successfully.
"""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_health_returns_ok(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] in {"ok", "degraded"}
    assert "ensemble_version" in body
    assert isinstance(body["models_available"], list)
    # Naive + dow_average are always available (no optional dep).
    assert "naive" in body["models_available"]
    assert "dow_average" in body["models_available"]
    assert body["trained_columns"] == []


def test_health_reports_chronos_flag(client: TestClient, monkeypatch) -> None:
    # The endpoint should report the env var state without actually loading
    # the model.
    monkeypatch.setenv("ENSEMBLE_LOAD_CHRONOS", "0")
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["chronos_enabled"] is False
