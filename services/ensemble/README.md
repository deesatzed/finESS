# finESS Ensemble Sidecar

FastAPI process that exposes the `ace_hospital.UnifiedACEEnsemble`
forecaster over HTTP. finESS (Next.js) calls this service via
`lib/services/ensemble-client.ts`. No mocks, no placeholders — all
endpoints train and predict against the real ensemble.

## Source of truth

The ensemble code itself is **not** owned by this directory. It lives in
the sibling repository `aXc11426/` (package name `ace-forecaster`,
module `ace_hospital`). This sidecar imports `UnifiedACEEnsemble` and
`EMAModelPerformance` from there without modification.

Integration path chosen for R6-04: **editable install of the upstream
package** (`pip install -e /Volumes/WS4TB/WS4TBr/aXc11426`). The
upstream package ships a valid `setup.py` and `pyproject.toml`, so no
vendoring was needed.

If you ever need to vendor (e.g. for an air-gapped CI), copy the
following minimum-necessary modules into `services/ensemble/vendored/`:

* `ace_hospital/__init__.py`
* `ace_hospital/core/ace_ensemble_unified.py`
* `ace_hospital/core/ar1_detector.py`
* `ace_hospital/core/strategy_memory.py`
* `ace_hospital/models/baseline_models.py`
* `ace_hospital/models/codon_library.py`
* `ace_hospital/substrate/__init__.py`
* `ace_hospital/substrate/ema_learner.py`
* `ace_hospital/substrate/forecast_patches.py`
* `ace_hospital/features/data_loader.py`
* `ace_hospital/hierarchical/hierarchical_forecaster.py`

…and add a `vendored/README_VENDORED.md` recording the source SHA and
the MIT licence header from `aXc11426/LICENSE`.

## Endpoints

| Method | Path        | Purpose                                                |
| ------ | ----------- | ------------------------------------------------------ |
| GET    | `/health`   | Liveness + which optional model deps imported.         |
| POST   | `/train`    | Train on a CSV (JSON rows). Returns SLSQP weights.     |
| POST   | `/predict`  | Generate a 1-step (or N-step) `EnsemblePrediction`.    |
| POST   | `/outcome`  | Record an observation; returns updated Beta priors.    |

Request/response schemas live in `app.py` as Pydantic models that mirror
the dataclasses in `ace_hospital.core.ace_ensemble_unified`. See the
docstrings on each model for field semantics.

### `/outcome` and the calibration loop (R6-06)

`/outcome` deliberately stops short of closing the loop. It updates the
in-process `EMAModelPerformance` learner and returns the resulting Beta
priors, but it does **not** feed those priors back into the next
`/train` call. That wiring belongs to R6-06; the contract here is just
to expose the priors so the calibration job can persist them.

## Running locally

### Python (fastest dev loop)

```bash
cd services/ensemble
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install -e /Volumes/WS4TB/WS4TBr/aXc11426
pytest tests/ -v
uvicorn services.ensemble.app:app --host 0.0.0.0 --port 8001
```

### Docker compose (production-like)

```bash
# From the finESS repo root:
docker compose up -d ensemble
curl -fsS http://localhost:8001/health
docker compose down
```

The compose file mounts `../aXc11426` read-only at `/opt/ace_hospital`
inside the container and prepends it to `PYTHONPATH`. For preprod /
CI builds, uncomment the `COPY aXc11426 /opt/ace_hospital` lines in
`Dockerfile` and remove the volume from `docker-compose.yml` so the
upstream package is baked in.

## Environment variables

| Variable                  | Default | Purpose                                                    |
| ------------------------- | ------- | ---------------------------------------------------------- |
| `ENSEMBLE_LOAD_CHRONOS`   | `0`     | If `1`, pre-load the Chronos foundation model at startup.  |
| `ENSEMBLE_CHRONOS_SIZE`   | `tiny`  | Chronos checkpoint size: `tiny`, `small`, `base`, `large`. |
| `ENSEMBLE_LOG_LEVEL`      | `INFO`  | Standard Python logging level.                             |
| `ENSEMBLE_SKIP_INTEGRATION` | unset | If `1`, pytest skips the heavy train/predict integration.  |

Chronos is **off by default** because it pulls ~200MB of weights and
needs torch. The other six models (Naive, DOW, ARIMA, SARIMAX, Ridge,
XGBoost) run without Chronos and that is what the integration test
exercises today. The user controls the Chronos size — finESS does not
hardcode any model version.

## Fixture

`fixtures/hospital-census-sample.csv` is a **real** 200-day slice
(2025-06-21 → 2026-01-06) lifted unchanged from
`aXc11426/dailyAdm1726.csv`. It is not synthetic. Regenerate via:

```bash
python3 -c "
import pandas as pd
df = pd.read_csv('/Volumes/WS4TB/WS4TBr/aXc11426/dailyAdm1726.csv')
df['DayDate'] = pd.to_datetime(df['DayDate'])
df = df.sort_values('DayDate').reset_index(drop=True)
df.tail(200).to_csv('services/ensemble/fixtures/hospital-census-sample.csv', index=False)
"
```

## Tests

```bash
cd services/ensemble
pytest tests/                  # runs health + real train/predict
ENSEMBLE_SKIP_INTEGRATION=1 pytest tests/   # skips the slow train test
```

The TypeScript integration test (`__tests__/services/ensemble-client.integration.test.ts`)
is `describe.skip`-gated behind `RUN_ENSEMBLE_INTEGRATION=1` so the
default `npm test` does not need docker.
