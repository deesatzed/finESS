"""finESS ensemble sidecar.

FastAPI wrapper around `ace_hospital.UnifiedACEEnsemble`. The wrapper does
NOT modify the ensemble; it only translates HTTP requests/responses to/from
the in-process dataclasses defined in
``ace_hospital.core.ace_ensemble_unified``.

Endpoints
---------
GET  /health           - liveness + which optional model deps actually imported.
POST /train            - train the ensemble on a CSV (provided as JSON rows) and
                          return SLSQP weights per target column.
POST /predict          - generate an EnsemblePrediction for a single target column.
                          When ``use_latest_priors=true`` AND the EMA learner has
                          accumulated observations for that column, apply
                          EMA-derived prior modes as ``ace_deltas`` to bias the
                          predict-time weights toward better-performing models.
                          This is the load-bearing half of R6-06's calibration
                          loop: outcomes recorded via /outcome shift the
                          ensemble weights on the next /predict for the same
                          column. See ``_apply_priors_as_deltas`` for the math.
POST /outcome          - record an observation pair (model preds + actual)
                          through the EMA learner. Returns the resulting Beta
                          priors so the caller can inspect them.
GET  /priors/{column}  - read the current EMA-derived priors for a column.
                          Used by the UI to render the "learned from N
                          outcomes" indicator.

Design notes
------------
* No mocked / placeholder data. Train/predict run the real ensemble.
* No global mutable state on the request path apart from the per-process
  ``EnsembleRegistry`` which holds trained ensembles keyed by their target
  column. The registry is process-local; production deployments should
  pin a single worker (uvicorn --workers 1) or front the service with a
  sticky load balancer until full persistence ships.
* Chronos is opt-in via the ``ENSEMBLE_LOAD_CHRONOS`` env var because the
  weights download (~200MB for tiny) is too slow for the CI integration
  test loop.
* The upstream ``ace_hospital`` package is NOT modified by R6-06. We rely
  on two pre-existing upstream APIs:
    1. ``EMAModelPerformance.to_beta_priors`` — converts EMA MAPEs to
       Beta priors over weights.
    2. ``UnifiedACEEnsemble.ace_deltas[column]`` — additive per-model
       weight adjustments applied at predict time, projected to the
       simplex. Setting deltas is enough to shift the predict weights
       toward the prior modes WITHOUT touching the training code.
"""

from __future__ import annotations

import logging
import math
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


# Blend coefficient between the SLSQP-trained weights and the EMA prior
# modes. The predict-time weight for each model is
#     w_predict = (1 - PRIOR_BLEND) * w_slsqp + PRIOR_BLEND * w_prior_mode
# which is then re-projected to the simplex by the upstream
# ``_apply_ace_deltas``. PRIOR_BLEND=0.3 is conservative: it gives the
# calibration loop visible influence over a small number of outcomes
# (>1pp shift after ~5 outcomes on typical fixtures) while never letting
# the learner override the trained weights wholesale. Tuning this knob
# requires re-running the calibration_loop integration test.
PRIOR_BLEND: float = 0.3


# ---------------------------------------------------------------------------
# Pydantic schemas (mirror the ace_hospital dataclasses 1:1)
# ---------------------------------------------------------------------------


class TrainRequest(BaseModel):
    csv_rows: List[Dict[str, Any]] = Field(..., min_length=30)
    date_column: str = Field(default="DayDate")
    target_columns: List[str] = Field(..., min_length=1)
    train_fraction: float = Field(default=0.6, gt=0.0, lt=1.0)
    val_fraction: float = Field(default=0.2, gt=0.0, lt=1.0)
    # Optional priors from a prior calibration cycle. Shape mirrors what
    # `EMAModelPerformance.to_beta_priors` returns:
    #   {column: {model_name: {"type": "beta", "params": {...}}}}
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
    # R6-06: whether the predict-time weights were biased toward EMA prior
    # modes via ace_deltas. False on the very first predict and whenever
    # the EMA learner has < 2 observations for any model on this column
    # (Beta-prior extraction is gated on that lower bound upstream).
    priors_applied: bool = False
    observation_count: int = 0


class OutcomeRequest(BaseModel):
    column: str
    model_predictions: Dict[str, float] = Field(..., min_length=1)
    actual: float


class OutcomeResponse(BaseModel):
    column: str
    updated_priors: Dict[str, Dict[str, Any]]
    observation_count: int


class PriorsResponse(BaseModel):
    column: str
    priors: Dict[str, Dict[str, Any]]
    observation_count: int
    ema_mape: Dict[str, float]


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
    """Thread-safe registry holding the trained ensemble + EMA learner.

    A single ``UnifiedACEEnsemble`` instance can hold trained state for
    multiple columns, so we keep one instance per process. Concurrent
    requests are serialised on ``self._lock`` for the train path only;
    predict is read-only on the trained models and we let it run without
    extra locking (the upstream models are not promised to be thread-safe
    but parallel predict from FastAPI's threadpool is the standard pattern
    and matches how the upstream package is used in its own scripts).

    R6-06 additions:
      * ``last_train_kwargs[column]`` remembers the train/val split fractions
        the column was originally trained with — kept for future debugging
        and possible re-training pathways even though the calibration loop
        no longer triggers a re-train.
      * ``ema_observation_count[column]`` is a single integer because every
        /outcome call updates all models for that column simultaneously and
        we want a single "learned from N outcomes" number for the UI.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.ensemble: Optional["UnifiedACEEnsemble"] = None
        self.ema: Optional["EMAModelPerformance"] = None
        self.last_train_kwargs: Dict[str, Dict[str, float]] = {}
        self.ema_observation_count: Dict[str, int] = {}

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
                # Production default alpha=0.1 (slow adaptation, 10% new /
                # 90% old). Tests that need faster adaptation construct
                # their own EMA via the test fixture rather than mutating
                # this default.
                self.ema = EMAModelPerformance(alpha=0.1)
                self.last_train_kwargs = {}
                self.ema_observation_count = {}
            return self.ensemble

    def trained_columns(self) -> List[str]:
        if self.ensemble is None:
            return []
        return sorted(self.ensemble.models.keys())


# Backwards-compat alias kept because conftest.py used to clear
# ``last_train_df``. The registry no longer caches the DataFrame because
# the calibration loop uses ace_deltas, not re-training. Tests that
# previously touched the attribute now do nothing — which is safe.
registry = EnsembleRegistry()


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(
    title="finESS Ensemble Sidecar",
    version="0.2.0",
    description=(
        "HTTP wrapper around the ace_hospital UnifiedACEEnsemble. "
        "Real models, real CSV input/output, no mocks. R6-06 closes the "
        "calibration loop: /outcome updates an EMA learner whose priors "
        "are translated into ace_deltas applied on the next /predict."
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


def _column_priors(column: str) -> Dict[str, Dict[str, Any]]:
    """Return the EMA-derived Beta priors for ``column`` or {} if not enough data.

    Returning {} is the upstream contract: ``to_beta_priors`` requires at
    least 2 observations per model before it emits a prior. Callers should
    interpret an empty dict as "no priors yet, use the default SLSQP init".
    """
    if registry.ema is None:
        return {}
    return registry.ema.to_beta_priors(column, concentration=10.0)


def _beta_mode(params: Dict[str, Any]) -> Optional[float]:
    """Return the mode of a Beta(alpha, beta) prior or None if undefined.

    Matches the upstream ``_extract_prior_modes`` fallback semantics
    (use mean when alpha/beta <= 1) so the deltas we compute line up with
    what training-side prior consumers would have done.
    """
    alpha = float(params.get("alpha", 1.0))
    beta = float(params.get("beta", 1.0))
    if alpha <= 0 or beta <= 0:
        return None
    if alpha > 1 and beta > 1:
        return (alpha - 1) / (alpha + beta - 2)
    return alpha / (alpha + beta)


def _apply_priors_as_deltas(
    column: str, priors: Dict[str, Dict[str, Any]]
) -> bool:
    """Bias the next /predict's weights toward the EMA prior modes.

    The upstream ``UnifiedACEEnsemble.predict`` already applies
    ``ace_deltas`` additively to the SLSQP weights and projects the
    result to the probability simplex. We use that hook here instead of
    re-training, because:

      1. The SLSQP objective is pure validation-MAPE; warm-starting it
         from prior modes never moves the optimum (the upstream's own
         logs make this clear — "Iterations: 12 (with aXc priors)" reaches
         the same weights as without priors). Warm-starting only saves
         iterations.
      2. ``ace_deltas`` directly modifies the predict-time weights, which
         is what the user means by "the system learned from outcomes".

    Algorithm:

      For each model present in both the trained weights and the priors:

          target_weight = (1 - PRIOR_BLEND) * slsqp_weight
                          + PRIOR_BLEND * normalised_prior_mode

      Where ``normalised_prior_mode`` is each model's Beta mode divided
      by the sum of modes (so they sum to 1 across models, comparable to
      the SLSQP weights).

      The delta to set is then ``target_weight - slsqp_weight``. The
      upstream simplex projection in ``_apply_ace_deltas`` re-normalises.

    Returns True iff the deltas were updated. Returns False (and does
    NOT mutate the registry) when:
      * the ensemble has not trained the column yet, or
      * no priors have a defined mode (the EMA learner returned {}, or
        every alpha/beta pair was degenerate).
    """
    if not priors:
        return False
    if registry.ensemble is None:
        return False
    slsqp_weights = registry.ensemble.slsqp_weights.get(column)
    if not slsqp_weights:
        return False

    # Normalise prior modes across the models that the ensemble actually
    # trained for this column (priors may include models that have since
    # been pruned, or omit models with < 2 observations).
    mode_by_model: Dict[str, float] = {}
    for model_name in slsqp_weights:
        prior = priors.get(model_name)
        if not prior:
            continue
        params = prior.get("params") if isinstance(prior, dict) else None
        if not isinstance(params, dict):
            continue
        mode = _beta_mode(params)
        if mode is None or not math.isfinite(mode):
            continue
        mode_by_model[model_name] = max(mode, 0.0)

    if not mode_by_model:
        return False

    mode_total = sum(mode_by_model.values())
    if mode_total <= 0:
        return False

    normalised_modes: Dict[str, float] = {
        m: v / mode_total for m, v in mode_by_model.items()
    }

    deltas: Dict[str, float] = {}
    for model_name, slsqp_weight in slsqp_weights.items():
        prior_mode = normalised_modes.get(model_name)
        if prior_mode is None:
            # No usable prior for this model; leave its delta at zero so
            # the simplex projection redistributes proportionally.
            deltas[model_name] = 0.0
            continue
        target = (1.0 - PRIOR_BLEND) * slsqp_weight + PRIOR_BLEND * prior_mode
        deltas[model_name] = target - slsqp_weight

    logger.info(
        "Applying %d EMA-derived deltas for %s (observation_count=%d): %s",
        len(deltas),
        column,
        registry.ema_observation_count.get(column, 0),
        {k: round(v, 4) for k, v in deltas.items()},
    )
    registry.ensemble.ace_deltas[column] = deltas
    return True


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
        registry.last_train_kwargs[col] = {
            "train_fraction": req.train_fraction,
            "val_fraction": req.val_fraction,
        }
        # Re-training resets the calibration loop's bias. The user is
        # asking for fresh weights — keep the EMA but zero the deltas
        # for this column so /predict doesn't inherit stale adjustments.
        ensemble.ace_deltas[col] = {m: 0.0 for m in col_weights}

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

    priors_applied = False
    if req.use_latest_priors:
        priors = _column_priors(req.target_column)
        if priors:
            try:
                priors_applied = _apply_priors_as_deltas(req.target_column, priors)
            except Exception:  # noqa: BLE001
                # Don't break the prediction path if delta computation
                # fails; the full traceback is in the server log and the
                # predict falls through with whatever deltas are already
                # in place (zero by default).
                logger.exception(
                    "Prior-aware delta computation failed for %s; predicting with "
                    "existing deltas",
                    req.target_column,
                )
                priors_applied = False
    else:
        # The caller explicitly opted out of priors for this predict.
        # Zero the deltas so the response reflects the pure SLSQP weights.
        if registry.ensemble.slsqp_weights.get(req.target_column):
            registry.ensemble.ace_deltas[req.target_column] = {
                m: 0.0
                for m in registry.ensemble.slsqp_weights[req.target_column]
            }

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
        priors_applied=priors_applied,
        observation_count=registry.ema_observation_count.get(req.target_column, 0),
    )


@app.post("/outcome", response_model=OutcomeResponse)
def outcome(req: OutcomeRequest) -> OutcomeResponse:
    """Record an observed (prediction, actual) pair and update Beta priors.

    Each call:
      1. Computes per-model MAPE = |actual - pred| / max(|actual|, 1e-10) * 100.
      2. Updates the EMA learner for every (column, model) pair in the request.
      3. Increments the column-level observation counter (one per /outcome
         call regardless of how many models are in the payload — this is what
         the UI's "learned from N outcomes" indicator displays).
      4. Returns the freshly-extracted Beta priors. The next /predict on the
         same column with ``use_latest_priors=true`` will convert these priors
         into ace_deltas via ``_apply_priors_as_deltas``.
    """
    if registry.ema is None:
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

    # One observation per /outcome call, regardless of model count. This
    # matches the UX claim "learned from N outcomes" (each outcome is one
    # real-world observation, not n_models bookkeeping events).
    registry.ema_observation_count[req.column] = (
        registry.ema_observation_count.get(req.column, 0) + 1
    )

    priors = registry.ema.to_beta_priors(req.column, concentration=10.0)
    return OutcomeResponse(
        column=req.column,
        updated_priors=priors,
        observation_count=registry.ema_observation_count[req.column],
    )


@app.get("/priors/{column}", response_model=PriorsResponse)
def get_priors(column: str) -> PriorsResponse:
    """Inspect the current EMA-derived Beta priors for a column.

    Used by the UI to render the "learned from N outcomes for `<column>`"
    indicator without polling /predict. The response is informational only —
    it never updates the EMA state.
    """
    if registry.ema is None:
        return PriorsResponse(
            column=column,
            priors={},
            observation_count=0,
            ema_mape={},
        )
    priors = registry.ema.to_beta_priors(column, concentration=10.0)
    ema_mape = {
        model: registry.ema.get_ema_mape(column, model)
        for model in registry.ema.ema.get(column, {})
    }
    return PriorsResponse(
        column=column,
        priors=priors,
        observation_count=registry.ema_observation_count.get(column, 0),
        ema_mape=ema_mape,
    )
