"""Shared pytest fixtures for the ensemble sidecar tests."""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Make sure ``services.ensemble.app`` is importable when pytest is invoked
# from any working directory.
ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# Disable EMA snapshot persistence for tests so they don't write to /data and
# don't interfere with each other. Must be set before importing app.
os.environ.setdefault("ENSEMBLE_SNAPSHOT_PATH", "")

import pandas as pd
import pytest
from fastapi.testclient import TestClient

import services.ensemble.app as sidecar_app
from services.ensemble.app import app, registry


FIXTURE_CSV = (
    Path(__file__).resolve().parents[1] / "fixtures" / "hospital-census-sample.csv"
)


@pytest.fixture(scope="session")
def fixture_df() -> pd.DataFrame:
    df = pd.read_csv(FIXTURE_CSV)
    assert "DayDate" in df.columns
    assert "Total_Census" in df.columns
    assert len(df) >= 100, "fixture must carry at least 100 real days"
    return df


@pytest.fixture(scope="session")
def fixture_rows(fixture_df: pd.DataFrame):
    # Cast to plain Python types so Pydantic accepts the payload.
    return fixture_df.astype(object).where(fixture_df.notna(), None).to_dict(orient="records")


@pytest.fixture()
def client() -> TestClient:
    # Reset the registry between tests so /train state is deterministic.
    # R6-06: also clear the cached training metadata and observation counts.
    # EMA durability: also ensure the module-level ENSEMBLE_SNAPSHOT_PATH
    # stays "" so no test accidentally writes a real snapshot.
    sidecar_app.ENSEMBLE_SNAPSHOT_PATH = ""
    registry.ensemble = None
    registry.ema = None
    registry.last_train_kwargs = {}
    registry.ema_observation_count = {}
    return TestClient(app)
