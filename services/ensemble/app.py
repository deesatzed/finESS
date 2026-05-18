"""finESS ensemble sidecar.

FastAPI wrapper around `ace_hospital.UnifiedACEEnsemble`. The wrapper does
NOT modify the ensemble; it only translates HTTP requests/responses to/from
the in-process dataclasses defined in
``ace_hospital.core.ace_ensemble_unified``.

Endpoints
---------
GET  /health   - liveness + which optional model deps actually imported.
POST /train    - train the ensemble on a CSV (provided as JSON rows) and
                 return SLSQP weights per target column.
POST /predict  - generate an EnsemblePrediction for a single target column.
POST /outcome  - record an observation pair (model preds + actual) through
                 the EMA learner. Returns the resulting Beta priors so the
                 caller can persist them; wiring the priors back into
                 ``train(weight_priors=...)`` is intentionally deferred to
                 R6-06 (calibration loop) and flagged with a TODO below.

Design notes
------------
* No mocked / placeholder data. Train/predict run the real ensemble.
* No global mutable state on the request path apart from the per-process
  ``EnsembleRegistry`` which holds trained ensembles keyed by their target
  column. The registry is process-local; production deployments should
  pin a single worker (uvicorn --workers 1) or front the service with a
  sticky load balancer until R6-06 introduces persistence.
* Chronos is opt-in via the ``ENSEMBLE_LOAD_CHRONOS`` env var because the
  weights download (~200MB for tiny) is too slow for the CI integration
  test loop.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

# Resolve the upstream ensemble. We import lazily so that an import
# failure surfaces in /health rather than crashing the process at boot
# (this matters for the integration test which boots the container and
# probes /health first).
_ENSEMBLE_IMPORT_ERROR: Optional[str] = None
try:  # pragma: no cover - exercised at runtime, not in unit tests
    from ace_hospital import __version__ as ACE_VERSION
    from ace_hospital.core.ace_ensemble_unified import (
        EnsemblePrediction,
        UnifiedACEEnsemble,
    )
    from ace_hospital.substrate.ema_learner import EMAModelPerformance
except Exception as exc:  # noqa: BLE001 - we surface the message in /health
    ACE_VERSION = "unavailable"
    UnifiedACEEnsemble = None  # type: ignore[assignment]
    EnsemblePrediction = None  # type: ignore[assignment]
    EMAModelPerformance = None  # type: ignore[assignment]
    _ENSEMBLE_IMPORT_ERROR = f"{type(exc).__name__}: {exc}"


logging.basicConfig(
    level=os.environ.get("ENSEMBLE_LOG_LEVEL", "INFO"),
    format="%(asctime)s ensemble-sidecar %(levelname)s %(name)s :: %(message)s",
)
logger = logging.getLogger("ensemble.sidecar")


# ---------------------------------------------------------------------------
# Pydantic schemas (mirror the ace_hospital dataclasses 1:1)
# ---------------------------------------------------------------------------


class TrainRequest(BaseModel):
    csv_rows: List[Dict[str, Any]] = Field(..., min_length=30)
    date_column: str = Field(default="DayDate")
    target_columns: List[str] = Field(..., min_length=1)
    train_fraction: float = Field(default=0.6, gt=0.0, lt=1.0)
    val_fraction: float = Field(default=0.2, gt=0.0, lt=1.0)
    # Optional priors from a prior calibration cycle (R6-06 will populate).
    weight_priors: Optional[Dict[str, Dict[str, Dict[str, Any]]]] = None


class TrainResponse(BaseModel):
    trained_columns: List[str]
    slsqp_weights: Dict[str, Dict[str, float]]
    training_seconds: float
    n_rows: int


class PredictRequest(BaseModel):
    csv_rows: List[Dict[str, Any]] = Field(..., min_length=30)
    date_column: str = Field(default="DayDate")
    target_column: str
    n_steps: int = Field(default=1, ge=1, le=14)
    use_latest_priors: bool = True


class EnsemblePredictionResponse(BaseModel):
    column: str
    prediction: float
    lower_95: float
    upper_95: float
    model_weights: Dict[str, float]
    individual_predictions: Dict[str, float]
    regime_type: str
    rho: float
    mode: str


class OutcomeRequest(BaseModel):
    column: str
    model_predictions: Dict[str, float] = Field(..., min_length=1)
    actual: float


class OutcomeResponse(BaseModel):
    column: str
    updated_priors: Dict[str, Dict[str, Any]]
    observation_count: int
    note: str = (
        "Priors are returned but NOT yet fed back into train(); that is "
        "R6-06's job. Persist these priors and pass them to /train via "
        "weight_priors when the calibration loop ships."
    )


class HealthResponse(BaseModel):
    status: str
    ensemble_version: str
    chronos_enabled: bool
    chronos_size: Optional[str]
    models_available: List[str]
    trained_columns: List[str]
    import_error: Optional[str] = None


# ---------------------------------------------------------------------------
# In-process registry
# ---------------------------------------------------------------------------


class EnsembleRegistry:
    """Thread-safe registry holding the (single) trained ensemble + EMA learner.

    A single ``UnifiedACEEnsemble`` instance can hold trained state for
    multiple columns, so we keep one instance per process. Concurrent
    requests are serialised on ``self._lock`` for the train path only;
    predict is read-only on the trained models and we let it run without
    extra locking (the upstream models are not promised to be thread-safe
    but parallel predict from FastAPI's threadpool is the standard pattern
    and matches how the upstream package is used in its own scripts).
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.ensemble: Optional["UnifiedACEEnsemble"] = None
        self.ema: Optional["EMAModelPerformance"] = None
        self.ema_counts: Dict[str, int] = {}

    def get_or_create(self) -> "UnifiedACEEnsemble":
        if UnifiedACEEnsemble is None:
            raise HTTPException(
                status_code=503,
                detail=f"ace_hospital not importable: {_ENSEMBLE_IMPORT_ERROR}",
            )
        with self._lock:
            if self.ensemble is None:
                self.ensemble = UnifiedACEEnsemble(
                    mode="production",
                    ar1_window=30,
                    learning_rate=0.1,
                    use_stigmergy=False,  # We run the EMA learner ourselves.
                )
                self.ema = EMAModelPerformance(alpha=0.1)
                self.ema_counts = {}
            return self.ensemble

    def trained_columns(self) -> List[str]:
        if self.ensemble is None:
            return []
        return sorted(self.ensemble.models.keys())


registry = EnsembleRegistry()


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(
    title="finESS Ensemble Sidecar",
    version="0.1.0",
    description=(
        "HTTP wrapper around the ace_hospital UnifiedACEEnsemble. "
        "Real models, real CSV input/output, no mocks."
    ),
)


def _coerce_numeric_inplace(df: pd.DataFrame, exclude: List[str]) -> None:
    """Best-effort numeric coercion that does NOT emit pandas FutureWarning.

    Calls ``pd.to_numeric`` per column and silently leaves the column as-is
    if every value fails to parse — matching the previous ``errors="ignore"``
    behaviour without using the deprecated kwarg.
    """
    for col in df.columns:
        if col in exclude:
            continue
        try:
            coerced = pd.to_numeric(df[col], errors="raise")
        except (ValueError, TypeError):
            # Mixed/non-numeric column (e.g. textual flags). Leave as object.
            continue
        df[col] = coerced


def _rows_to_dataframe(rows: List[Dict[str, Any]], date_column: str) -> pd.DataFrame:
    df = pd.DataFrame(rows)
    if date_column not in df.columns:
        raise HTTPException(
            status_code=400,
            detail=f"date_column '{date_column}' not present in csv_rows",
        )
    # The upstream ensemble expects a column literally named 'DayDate' (it is
    # hard-coded in several places, e.g. _create_ml_features). If the caller
    # supplies a different name, rename it here so we don't silently lose
    # day-of-week features.
    if date_column != "DayDate":
        df = df.rename(columns={date_column: "DayDate"})
    df["DayDate"] = pd.to_datetime(df["DayDate"], errors="coerce")
    if df["DayDate"].isna().any():
        bad = df["DayDate"].isna().sum()
        raise HTTPException(
            status_code=400,
            detail=f"date_column contained {bad} unparseable values",
        )
    df = df.sort_values("DayDate").reset_index(drop=True)
    _coerce_numeric_inplace(df, exclude=["DayDate"])
    return df


def _models_available_report() -> List[str]:
    """Return which optional dependencies actually imported.

    This does NOT load Chronos (that's controlled by ENSEMBLE_LOAD_CHRONOS).
    """
    available: List[str] = ["naive", "dow_average"]
    try:
        import statsmodels  # noqa: F401
        available.extend(["arima", "sarimax"])
    except ImportError:
        pass
    try:
        import sklearn  # noqa: F401
        available.append("ridge")
    except ImportError:
        pass
    try:
        import xgboost  # noqa: F401
        available.append("xgboost")
    except ImportError:
        pass
    if os.environ.get("ENSEMBLE_LOAD_CHRONOS") == "1":
        try:
            import chronos  # noqa: F401
            available.append("chronos")
        except ImportError:
            pass
    return available


@app.on_event("startup")
def _startup() -> None:
    """Optionally pre-load Chronos so the first /predict isn't slow."""
    if os.environ.get("ENSEMBLE_LOAD_CHRONOS") != "1":
        logger.info("Chronos loading skipped (set ENSEMBLE_LOAD_CHRONOS=1 to enable)")
        return
    if UnifiedACEEnsemble is None:
        logger.warning("Cannot load Chronos: ace_hospital unavailable (%s)", _ENSEMBLE_IMPORT_ERROR)
        return
    size = os.environ.get("ENSEMBLE_CHRONOS_SIZE", "tiny")
    logger.info("Pre-loading Chronos (size=%s) ...", size)
    UnifiedACEEnsemble.initialize_chronos(model_size=size)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok" if _ENSEMBLE_IMPORT_ERROR is None else "degraded",
        ensemble_version=str(ACE_VERSION),
        chronos_enabled=os.environ.get("ENSEMBLE_LOAD_CHRONOS") == "1",
        chronos_size=os.environ.get("ENSEMBLE_CHRONOS_SIZE", "tiny"),
        models_available=_models_available_report(),
        trained_columns=registry.trained_columns(),
        import_error=_ENSEMBLE_IMPORT_ERROR,
    )


@app.post("/train", response_model=TrainResponse)
def train(req: TrainRequest) -> TrainResponse:
    df = _rows_to_dataframe(req.csv_rows, req.date_column)
    missing = [c for c in req.target_columns if c not in df.columns]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"target_columns missing from csv_rows: {missing}",
        )
    if req.train_fraction + req.val_fraction >= 1.0:
        raise HTTPException(
            status_code=400,
            detail="train_fraction + val_fraction must leave room for the test split",
        )

    ensemble = registry.get_or_create()

    started = time.perf_counter()
    try:
        ensemble.train(
            df=df,
            columns=req.target_columns,
            train_fraction=req.train_fraction,
            val_fraction=req.val_fraction,
            weight_priors=req.weight_priors,
        )
    except Exception as exc:  # noqa: BLE001 - surface a clean 500
        logger.exception("Training failed")
        raise HTTPException(status_code=500, detail=f"training failed: {exc}") from exc
    elapsed = time.perf_counter() - started

    weights_out: Dict[str, Dict[str, float]] = {}
    for col in req.target_columns:
        col_weights = ensemble.slsqp_weights.get(col, {})
        weights_out[col] = {k: float(v) for k, v in col_weights.items()}

    return TrainResponse(
        trained_columns=sorted(weights_out.keys()),
        slsqp_weights=weights_out,
        training_seconds=elapsed,
        n_rows=len(df),
    )


@app.post("/predict", response_model=EnsemblePredictionResponse)
def predict(req: PredictRequest) -> EnsemblePredictionResponse:
    if registry.ensemble is None:
        raise HTTPException(
            status_code=409,
            detail="No trained ensemble. Call /train first.",
        )
    if req.target_column not in registry.ensemble.models:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Column '{req.target_column}' has no trained models. "
                f"Trained columns: {registry.trained_columns()}"
            ),
        )
    df = _rows_to_dataframe(req.csv_rows, req.date_column)
    if req.target_column not in df.columns:
        raise HTTPException(
            status_code=400,
            detail=f"target_column '{req.target_column}' not in csv_rows",
        )

    try:
        result: "EnsemblePrediction" = registry.ensemble.predict(
            df=df,
            column=req.target_column,
            n_steps=req.n_steps,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Prediction failed")
        raise HTTPException(status_code=500, detail=f"prediction failed: {exc}") from exc

    return EnsemblePredictionResponse(
        column=result.column,
        prediction=float(result.prediction),
        lower_95=float(result.lower_95),
        upper_95=float(result.upper_95),
        model_weights={k: float(v) for k, v in result.model_weights.items()},
        individual_predictions={
            k: float(v) for k, v in result.individual_predictions.items()
        },
        regime_type=str(result.regime_type),
        rho=float(result.rho),
        mode=str(result.mode),
    )


@app.post("/outcome", response_model=OutcomeResponse)
def outcome(req: OutcomeRequest) -> OutcomeResponse:
    """Record an observed (prediction, actual) pair and update Beta priors.

    R6-04 ships only the recording side: priors are computed via
    ``EMAModelPerformance.to_beta_priors`` and returned to the caller.
    R6-06 will wire them back into the next ``/train`` call.
    """
    if registry.ema is None:
        # Lazily create the EMA learner even if /train has not been called.
        registry.get_or_create()
    assert registry.ema is not None  # noqa: S101 - for type narrowing

    if not np.isfinite(req.actual):
        raise HTTPException(status_code=400, detail="actual must be finite")

    epsilon = 1e-10
    denom = max(abs(req.actual), epsilon)
    for model_name, pred in req.model_predictions.items():
        if not np.isfinite(pred):
            raise HTTPException(
                status_code=400,
                detail=f"model_predictions['{model_name}'] is not finite",
            )
        mape = abs(req.actual - pred) / denom * 100.0
        registry.ema.record_performance(
            column=req.column,
            model=model_name,
            mape=mape,
        )
        registry.ema_counts[req.column] = registry.ema_counts.get(req.column, 0) + 1

    priors = registry.ema.to_beta_priors(req.column, concentration=10.0)
    return OutcomeResponse(
        column=req.column,
        updated_priors=priors,
        observation_count=registry.ema.get_observation_count(
            req.column, next(iter(req.model_predictions))
        ),
    )


# TODO(R6-06): the calibration loop should:
#   1. accumulate /outcome calls over a window,
#   2. extract priors via /outcome's response,
#   3. POST them back to /train via weight_priors,
#   4. compare new SLSQP weights vs old and surface the drift in the UI.
