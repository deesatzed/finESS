"""EMA snapshot durability tests.

Verifies that:
  1. _save_ema_snapshot() writes a valid JSON file.
  2. _load_ema_snapshot() restores ema state and observation counts.
  3. A full round-trip (save → reset registry → load) preserves the EMA values
     such that to_beta_priors() returns the same priors before and after.
  4. /outcome calls trigger a snapshot write when ENSEMBLE_SNAPSHOT_PATH is set.
  5. GET /snapshot returns correct metadata.
  6. Missing snapshot is handled gracefully (fresh start, no error).
  7. Corrupt snapshot is skipped gracefully (logged, fresh start).
  8. ENSEMBLE_SNAPSHOT_PATH="" disables persistence (no file written).
  9. Unknown schema_version is skipped gracefully.
 10. Atomic write: temp file is cleaned up on success.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import pytest

# Make sure root is on the path (mirrors conftest.py).
ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# Disable snapshot path for all tests in this file — individual tests that
# want to exercise persistence set the module-level var directly.
os.environ["ENSEMBLE_SNAPSHOT_PATH"] = ""

import services.ensemble.app as sidecar_app
from services.ensemble.app import _load_ema_snapshot, _save_ema_snapshot, registry
from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _reset_registry(snapshot_path: str = "") -> None:
    """Reset the in-process registry and module-level snapshot path."""
    sidecar_app.ENSEMBLE_SNAPSHOT_PATH = snapshot_path
    registry.ensemble = None
    registry.ema = None
    registry.last_train_kwargs = {}
    registry.ema_observation_count = {}


def _make_ema_with_observations(alpha: float = 0.1) -> None:
    """Populate the registry EMA with a synthetic observation so save has data."""
    from ace_hospital.substrate.ema_learner import EMAModelPerformance  # type: ignore

    registry.ema = EMAModelPerformance(alpha=alpha)
    registry.ema.record_performance("Total_Census", "ridge", 5.0)
    registry.ema.record_performance("Total_Census", "ridge", 3.0)
    registry.ema.record_performance("Total_Census", "xgboost", 8.0)
    registry.ema.record_performance("Total_Census", "xgboost", 6.0)
    registry.ema_observation_count["Total_Census"] = 2


pytestmark = pytest.mark.skipif(
    os.environ.get("ENSEMBLE_SKIP_INTEGRATION") == "1",
    reason="ENSEMBLE_SKIP_INTEGRATION=1 set; skipping integration tests",
)


# ---------------------------------------------------------------------------
# 1. _save_ema_snapshot writes a parseable JSON file
# ---------------------------------------------------------------------------


def test_save_writes_valid_json(tmp_path: Path) -> None:
    _reset_registry()
    _make_ema_with_observations()
    snap_path = str(tmp_path / "ema_snapshot.json")
    sidecar_app.ENSEMBLE_SNAPSHOT_PATH = snap_path

    _save_ema_snapshot()

    assert Path(snap_path).exists()
    raw = json.loads(Path(snap_path).read_text())
    assert raw["schema_version"] == 1
    assert "ema" in raw
    assert "observation_count" in raw
    assert raw["observation_count"]["Total_Census"] == 2
    assert "Total_Census" in raw["ema"]
    assert "ridge" in raw["ema"]["Total_Census"]
    assert "xgboost" in raw["ema"]["Total_Census"]


# ---------------------------------------------------------------------------
# 2. _load_ema_snapshot restores state
# ---------------------------------------------------------------------------


def test_load_restores_ema_state(tmp_path: Path) -> None:
    _reset_registry()
    _make_ema_with_observations()
    snap_path = str(tmp_path / "ema_snapshot.json")
    sidecar_app.ENSEMBLE_SNAPSHOT_PATH = snap_path

    # Capture priors before save.
    priors_before = registry.ema.to_beta_priors("Total_Census", concentration=10.0)
    assert priors_before  # Must have data (>= 2 obs per model).

    _save_ema_snapshot()

    # Wipe and reload.
    _reset_registry(snap_path)
    from ace_hospital.substrate.ema_learner import EMAModelPerformance  # type: ignore

    registry.ema = EMAModelPerformance(alpha=0.1)
    _load_ema_snapshot()

    assert registry.ema_observation_count.get("Total_Census") == 2
    priors_after = registry.ema.to_beta_priors("Total_Census", concentration=10.0)
    assert set(priors_after.keys()) == set(priors_before.keys())

    # Priors should be numerically identical (all EMA values restored).
    for model in priors_before:
        before_alpha = priors_before[model]["params"]["alpha"]
        after_alpha = priors_after[model]["params"]["alpha"]
        assert abs(before_alpha - after_alpha) < 1e-6, (
            f"alpha mismatch for {model}: {before_alpha} vs {after_alpha}"
        )


# ---------------------------------------------------------------------------
# 3. Full round-trip: save → hard reset → load → priors match
# ---------------------------------------------------------------------------


def test_full_round_trip(tmp_path: Path) -> None:
    _reset_registry()
    _make_ema_with_observations(alpha=0.2)
    snap_path = str(tmp_path / "snap.json")
    sidecar_app.ENSEMBLE_SNAPSHOT_PATH = snap_path
    _save_ema_snapshot()

    priors_orig = registry.ema.to_beta_priors("Total_Census", concentration=10.0)

    # Hard reset — simulate container restart.
    _reset_registry(snap_path)
    from ace_hospital.substrate.ema_learner import EMAModelPerformance  # type: ignore

    registry.ema = EMAModelPerformance(alpha=0.2)
    _load_ema_snapshot()

    priors_restored = registry.ema.to_beta_priors("Total_Census", concentration=10.0)
    assert set(priors_restored.keys()) == set(priors_orig.keys())
    for model in priors_orig:
        assert abs(
            priors_orig[model]["params"]["alpha"]
            - priors_restored[model]["params"]["alpha"]
        ) < 1e-6


# ---------------------------------------------------------------------------
# 4. /outcome triggers snapshot write
# ---------------------------------------------------------------------------


def test_outcome_triggers_snapshot_write(tmp_path: Path, fixture_rows) -> None:
    snap_path = str(tmp_path / "outcome_snap.json")
    _reset_registry(snap_path)
    from fastapi.testclient import TestClient  # noqa: PLC0415

    client = TestClient(sidecar_app.app)

    # Train first.
    resp = client.post(
        "/train",
        json={
            "csv_rows": fixture_rows,
            "date_column": "DayDate",
            "target_columns": ["Total_Census"],
        },
    )
    assert resp.status_code == 200

    # Predict to get per-model predictions.
    pred_resp = client.post(
        "/predict",
        json={
            "csv_rows": fixture_rows,
            "date_column": "DayDate",
            "target_column": "Total_Census",
            "n_steps": 1,
            "use_latest_priors": False,
        },
    )
    assert pred_resp.status_code == 200
    preds = pred_resp.json()["individual_predictions"]

    assert not Path(snap_path).exists(), "snapshot should not exist before /outcome"

    outcome_resp = client.post(
        "/outcome",
        json={
            "column": "Total_Census",
            "model_predictions": preds,
            "actual": float(fixture_rows[-1]["Total_Census"]),
        },
    )
    assert outcome_resp.status_code == 200
    assert Path(snap_path).exists(), "snapshot must be written after /outcome"

    raw = json.loads(Path(snap_path).read_text())
    assert raw["observation_count"]["Total_Census"] == 1


# ---------------------------------------------------------------------------
# 5. GET /snapshot returns correct metadata
# ---------------------------------------------------------------------------


def test_get_snapshot_endpoint_no_file(tmp_path: Path) -> None:
    snap_path = str(tmp_path / "missing.json")
    _reset_registry(snap_path)
    client = TestClient(sidecar_app.app)
    resp = client.get("/snapshot")
    assert resp.status_code == 200
    body = resp.json()
    assert body["snapshot_exists"] is False
    assert body["columns_persisted"] == 0
    assert body["saved_at"] is None


def test_get_snapshot_endpoint_with_file(tmp_path: Path) -> None:
    _reset_registry()
    _make_ema_with_observations()
    snap_path = str(tmp_path / "snap.json")
    sidecar_app.ENSEMBLE_SNAPSHOT_PATH = snap_path
    _save_ema_snapshot()

    client = TestClient(sidecar_app.app)
    sidecar_app.ENSEMBLE_SNAPSHOT_PATH = snap_path
    resp = client.get("/snapshot")
    assert resp.status_code == 200
    body = resp.json()
    assert body["snapshot_exists"] is True
    assert body["columns_persisted"] == 1
    assert body["saved_at"] is not None
    assert body["observation_count"]["Total_Census"] == 2


# ---------------------------------------------------------------------------
# 6. Missing snapshot → fresh start, no error
# ---------------------------------------------------------------------------


def test_load_missing_snapshot_is_silent(tmp_path: Path) -> None:
    snap_path = str(tmp_path / "nonexistent.json")
    _reset_registry(snap_path)
    from ace_hospital.substrate.ema_learner import EMAModelPerformance  # type: ignore

    registry.ema = EMAModelPerformance(alpha=0.1)
    _load_ema_snapshot()  # must not raise

    assert registry.ema_observation_count == {}
    assert registry.ema.ema == {}


# ---------------------------------------------------------------------------
# 7. Corrupt snapshot → skipped gracefully
# ---------------------------------------------------------------------------


def test_load_corrupt_snapshot_is_silent(tmp_path: Path) -> None:
    snap_path = tmp_path / "corrupt.json"
    snap_path.write_text("this is not json{{{", encoding="utf-8")
    _reset_registry(str(snap_path))
    from ace_hospital.substrate.ema_learner import EMAModelPerformance  # type: ignore

    registry.ema = EMAModelPerformance(alpha=0.1)
    _load_ema_snapshot()  # must not raise

    assert registry.ema_observation_count == {}


# ---------------------------------------------------------------------------
# 8. ENSEMBLE_SNAPSHOT_PATH="" disables persistence
# ---------------------------------------------------------------------------


def test_save_disabled_when_path_empty(tmp_path: Path) -> None:
    _reset_registry("")  # disabled
    _make_ema_with_observations()
    _save_ema_snapshot()  # must not raise and must not write any file
    assert list(tmp_path.iterdir()) == []  # no files written


# ---------------------------------------------------------------------------
# 9. Unknown schema_version is skipped gracefully
# ---------------------------------------------------------------------------


def test_load_unknown_schema_version(tmp_path: Path) -> None:
    snap_path = tmp_path / "future.json"
    snap_path.write_text(
        json.dumps({"schema_version": 99, "ema": {}, "observation_count": {}}),
        encoding="utf-8",
    )
    _reset_registry(str(snap_path))
    from ace_hospital.substrate.ema_learner import EMAModelPerformance  # type: ignore

    registry.ema = EMAModelPerformance(alpha=0.1)
    _load_ema_snapshot()  # must not raise and must not populate ema

    assert registry.ema.ema == {}


# ---------------------------------------------------------------------------
# 10. Atomic write: .tmp file is replaced, leaving only the final file
# ---------------------------------------------------------------------------


def test_save_atomic_write_no_tmp_leftover(tmp_path: Path) -> None:
    _reset_registry()
    _make_ema_with_observations()
    snap_path = tmp_path / "atomic.json"
    tmp_path_tmp = snap_path.with_suffix(".tmp")
    sidecar_app.ENSEMBLE_SNAPSHOT_PATH = str(snap_path)

    _save_ema_snapshot()

    assert snap_path.exists()
    assert not tmp_path_tmp.exists(), ".tmp file must be cleaned up after atomic rename"
