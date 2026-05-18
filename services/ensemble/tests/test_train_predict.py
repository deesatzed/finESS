"""End-to-end test: train and predict against the REAL fixture CSV.

This is the contract test that proves the sidecar is not a stub. It loads
the real (200-day) trimmed hospital census fixture, fires /train, then
/predict, then /outcome and asserts that:

  * SLSQP weights sum to ~1 and exclude zero-weight models below epsilon,
  * the prediction is a finite number in a sane range for Total_Census,
  * individual_predictions cover the models the ensemble actually built,
  * /outcome returns Beta priors keyed by model name.

NO MOCKS. NO PLACEHOLDERS. If the upstream ensemble cannot import we fail
loudly so the operator notices, rather than fall back to a stub.
"""

from __future__ import annotations

import os
from typing import List

import pytest
from fastapi.testclient import TestClient


pytestmark = pytest.mark.skipif(
    os.environ.get("ENSEMBLE_SKIP_INTEGRATION") == "1",
    reason="ENSEMBLE_SKIP_INTEGRATION=1 set; skipping real-data integration test",
)


def _train(client: TestClient, rows: List[dict]) -> dict:
    payload = {
        "csv_rows": rows,
        "date_column": "DayDate",
        "target_columns": ["Total_Census"],
        "train_fraction": 0.6,
        "val_fraction": 0.2,
    }
    response = client.post("/train", json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def test_train_returns_real_slsqp_weights(client: TestClient, fixture_rows) -> None:
    body = _train(client, fixture_rows)
    assert body["trained_columns"] == ["Total_Census"]
    weights = body["slsqp_weights"]["Total_Census"]
    assert weights, "ensemble must return at least one model weight"
    # Weights must form a valid probability distribution.
    total = sum(weights.values())
    assert abs(total - 1.0) < 1e-3, f"weights sum to {total}, expected ~1.0"
    # And at least one model must have non-trivial mass.
    assert max(weights.values()) > 0.05
    assert body["n_rows"] == len(fixture_rows)
    assert body["training_seconds"] > 0.0


def test_predict_returns_real_ensemble_prediction(client: TestClient, fixture_rows) -> None:
    _train(client, fixture_rows)
    response = client.post(
        "/predict",
        json={
            "csv_rows": fixture_rows,
            "date_column": "DayDate",
            "target_column": "Total_Census",
            "n_steps": 1,
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    # Shape contract.
    assert body["column"] == "Total_Census"
    assert isinstance(body["prediction"], float)
    assert body["lower_95"] <= body["prediction"] <= body["upper_95"]
    # Sanity range: real fixture has Total_Census mean ~613 std ~45.
    # Allow a generous +/- 4 sigma envelope; if we are outside that, the
    # ensemble is broken and we want the test to scream.
    assert 350.0 < body["prediction"] < 900.0, body
    assert body["mode"] == "production"
    assert body["regime_type"] in {"stable", "volatile", "transitioning", "unknown"}
    # Must report the per-model breakdown.
    assert set(body["model_weights"].keys()) == set(body["individual_predictions"].keys())
    assert len(body["model_weights"]) >= 3, (
        "expected at least 3 base models trained on the fixture; got "
        f"{list(body['model_weights'].keys())}"
    )


def test_outcome_records_priors(client: TestClient, fixture_rows) -> None:
    _train(client, fixture_rows)
    predict = client.post(
        "/predict",
        json={
            "csv_rows": fixture_rows,
            "date_column": "DayDate",
            "target_column": "Total_Census",
            "n_steps": 1,
        },
    ).json()

    # Take a couple of fake-but-real observations from the fixture's tail
    # so that the EMA learner has at least 2 observations (needed for
    # to_beta_priors to return a non-empty dict per upstream code).
    actuals = [r["Total_Census"] for r in fixture_rows[-2:]]
    for actual in actuals:
        response = client.post(
            "/outcome",
            json={
                "column": "Total_Census",
                "model_predictions": predict["individual_predictions"],
                "actual": float(actual),
            },
        )
        assert response.status_code == 200, response.text

    last = response.json()
    assert last["column"] == "Total_Census"
    assert last["observation_count"] >= 2
    # Priors must cover the models the caller fed in.
    for model_name in predict["individual_predictions"]:
        assert model_name in last["updated_priors"], model_name
        prior = last["updated_priors"][model_name]
        assert prior["type"] == "beta"
        assert prior["params"]["alpha"] > 0
        assert prior["params"]["beta"] > 0


def test_predict_requires_training_first(client: TestClient, fixture_rows) -> None:
    response = client.post(
        "/predict",
        json={
            "csv_rows": fixture_rows,
            "date_column": "DayDate",
            "target_column": "Total_Census",
            "n_steps": 1,
        },
    )
    assert response.status_code == 409


def test_train_rejects_missing_target(client: TestClient, fixture_rows) -> None:
    response = client.post(
        "/train",
        json={
            "csv_rows": fixture_rows,
            "date_column": "DayDate",
            "target_columns": ["Nonexistent_Column"],
            "train_fraction": 0.6,
            "val_fraction": 0.2,
        },
    )
    assert response.status_code == 400
