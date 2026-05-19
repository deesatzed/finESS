# finESS

finESS is a local Next.js + Prisma/SQLite uncertainty workbench. It lets a single operator on their own machine load a CSV, compute observed statistics, train an empirical forecast ensemble, and (optionally) consult one or more LLMs for narration or for draft probabilistic graphs. It is a pre-production local beta. It is not a hosted multi-tenant service, it does not give advice in any regulated domain, and Path A outputs are LLM drafts, not verified analyses.

## What this app does (real)

### Path B — Real Data Mode (primary)

User pastes or uploads a CSV, picks a measured target column, and optionally sets a threshold. The app computes empirical observed-data statistics locally (mean, empirical interval, exceedance probability) with no network call. Save/Load persists the observed result; the Calibration modal records outcomes against a saved observed result. Optional AI Assist (`POST /api/real-data/assist`) sends only the computed summary statistics to OpenRouter for narration — never the raw rows. Code: `components/RealDataPanel.tsx`, `lib/real-data/`, `app/api/real-data/assist/`.

### Forecast Mode (real ensemble)

`POST /api/forecast` validates a time-series CSV, then calls the Python sidecar in `services/ensemble/` (which wraps `ace_hospital.UnifiedACEEnsemble`) to train and predict against the user's actual data. The response surfaces per-model weights, individual model predictions, the SLSQP-optimised ensemble prediction, and a 95% interval. A server-generated `forecastId` lets the client attach a later `CalibrationOutcome`. There is no mock fallback: if the sidecar is unreachable the route returns 502 with an actionable message. Code: `components/ForecastPanel.tsx`, `app/api/forecast/route.ts`, `lib/services/ensemble-client.ts`, `services/ensemble/app.py`.

### Multi-LLM Proposer

`POST /api/analyze/multi` fans out the same query to every configured OpenRouter model in parallel (bounded concurrency via `OPENROUTER_PROPOSER_CONCURRENCY`, default 3). Per-model failures are isolated into the response — they never abort sibling calls. The UI (`components/MultiProposalsPanel.tsx`) renders each model's proposal side-by-side so between-model disagreement is visible to the operator instead of hidden. Code: `lib/ai/multi-proposer.ts`, `app/api/analyze/multi/route.ts`. Every call goes through the shared wrapper `lib/ai/openrouter-client.ts`, which enforces per-call timeout (`OPENROUTER_TIMEOUT_MS`), single-shot retry on transient failure, and a per-call USD cost ceiling (`OPENROUTER_PER_CALL_BUDGET_USD`).

### Calibration loop (closed against the sidecar)

`POST /api/calibration` records an outcome against a saved observed analysis or a `forecastId`. When a `forecastId` is supplied, the route also calls the ensemble sidecar's `POST /outcome`, which updates an in-process EMA learner and returns updated Beta priors. The next `POST /predict` on that column with `useLatestPriors=true` re-optimises the SLSQP weights against the new priors. The integration test `__tests__/integration/calibration-loop.integration.test.ts` proves the favoured model's weight rises after biased outcomes. Caveat: the sidecar's EMA state is in-process memory only — restarting the sidecar resets the priors.

### Path A — Simulation (legacy / draft only)

`POST /api/analyze` asks an LLM to draft a probabilistic graph from a natural-language prompt, then runs deterministic Monte Carlo over that graph. The math engine is correct; the inputs are LLM priors. Every Path A response carries a `source` provenance field per node (`literature` | `llm_prior` | `user_override`) and the UI renders a non-dismissible amber Draft Model banner (`components/PathADraftBanner.tsx`) above the result. Semantic validation in `lib/ai/parse-response.ts` rejects graphs where node mean is outside its range, where the output node is unreachable, or where bayesian_update edge-count rules are violated. The whole route is gated behind `LEGACY_PATH_A_ENABLED` (default `true` for local dev; set `false` to disable for hosted/demo deploys); when disabled the route returns 404 `PATH_A_DISABLED`. Code: `app/api/analyze/route.ts`, `lib/feature-flags.ts`, `lib/ai/parse-response.ts`.

## What this app does NOT do

- Does not give clinical, legal, financial, engineering, or policy advice. finESS is domain-agnostic and ships no advisory content.
- Does not persist API keys on disk. `OPENROUTER_API_KEY` lives only in `.env.local` (gitignored); the UI supports a session-only override that is never written to storage.
- Does not run as a hosted multi-tenant service. There is no production auth provider, no HTTPS-only cookie policy, no production secret management, no compliance review. See `HANDOFF_LATEST.md` "Deferred Production Risks".
- Path A outputs are NOT verified analyses. The Monte Carlo math is rigorous, but the priors it operates on are an LLM's best guess based on its training data. Edit every node before trusting any output. R6-07 (N-graph LLM ensemble with node alignment) is not landed.
- Does not cache, mock, or simulate provider responses. If OpenRouter is down or the sidecar is unreachable, the relevant route returns an error — there is no fallback path that fabricates data.
- Does not currently persist the calibration loop's Beta priors across sidecar restarts.

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment (two files — see .env.example for the full guide)
cp .env.example .env          # Prisma reads DATABASE_URL from here
cp .env.example .env.local    # Next.js reads OPENROUTER_* from here at runtime

# 3. Set OPENROUTER_API_KEY in .env.local (optional — only needed for Path A,
#    Multi-LLM Proposer, and AI Assist). Configure OPENROUTER_MODELS and
#    OPENROUTER_DEFAULT_MODEL using the model IDs you want to expose; see
#    https://openrouter.ai/models for current IDs. Do not hardcode model
#    versions in code — the user selects them.

# 4. Initialise the database
npx prisma generate
npx prisma migrate deploy   # or `npx prisma db push` for the SQLite dev file

# 5. (Optional, required for Forecast Mode) bring up the Python ensemble sidecar
docker compose up -d ensemble
curl -fsS http://localhost:8001/health
```

## Running

- Dev server: `npm run dev -- -H 127.0.0.1 -p 3100`
- Forecast Mode + calibration loop also requires: `docker compose up -d ensemble`
- After any change to `OPENROUTER_MODELS` or the API key: `npm run preflight:models`

## Verification

| Command | Expected outcome |
|---|---|
| `npm run check:env` | Prints `Environment preflight passed`. Fails if `DATABASE_URL` is unset or `LEGACY_PATH_A_ENABLED` is not exactly `true` or `false`. |
| `npm run preflight:models` | With no `OPENROUTER_API_KEY`: prints `PREFLIGHT_MODELS_SKIPPED`. With a key: probes every entry of `OPENROUTER_MODELS` and fails on any 4xx/5xx. |
| `npm run smoke:openrouter` | Blocked-mode (no `OPENROUTER_LIVE_SMOKE=1`): prints `OPENROUTER_LIVE_SMOKE_BLOCKED` and exits 0 without printing secrets. |
| `OPENROUTER_LIVE_SMOKE=1 npm run smoke:openrouter` | Live mode: prints `OPENROUTER_LIVE_SMOKE_OK` against the configured `OPENROUTER_DEFAULT_MODEL`. Requires a valid `OPENROUTER_API_KEY` in `.env.local`. |
| `npm run smoke:multi-proposer` | Local probe of `lib/ai/multi-proposer.ts` against the configured model list. |
| `npm test -- --runInBand` | Unit + e2e Jest suites. Sidecar-dependent integration suites are `describe.skip` unless `RUN_ENSEMBLE_INTEGRATION=1`. |
| `npm run test:e2e` | Runs the workflow e2e suite. |
| `npm run test:coverage` | Jest coverage report. |
| `npm run build` | Next.js production build. Must exit 0. |
| `RUN_ENSEMBLE_INTEGRATION=1 npx jest __tests__/integration/forecast.integration.test.ts --runInBand` | Live forecast against the sidecar. Requires `docker compose up -d ensemble` first. |
| `RUN_ENSEMBLE_INTEGRATION=1 npx jest __tests__/integration/calibration-loop.integration.test.ts --runInBand` | Live closed-loop calibration test against the sidecar. |
| `RUN_OPENROUTER_LIVE=1 npx jest __tests__/integration/analyze-multi.integration.test.ts --runInBand` | Live multi-proposer test against real OpenRouter calls. Requires `OPENROUTER_API_KEY` and at least two entries in `OPENROUTER_MODELS`. |

## Architecture

- Next.js App Router (`app/`) with server-side API routes under `app/api/*`. No external auth provider; `/api/auth/local` issues a local HTTP-only session cookie.
- Prisma ORM (`prisma/schema.prisma`) backed by SQLite (`prisma/dev.db`) for local dev. Models: `User`, `Workspace`, `LocalSession`, `Analysis`, `CalibrationOutcome` (with `forecastId`), `AuditEvent`.
- Python ensemble sidecar (`services/ensemble/`, FastAPI + `ace_hospital.UnifiedACEEnsemble`) run via `docker compose up -d ensemble` on port 8001. The TypeScript client (`lib/services/ensemble-client.ts`) speaks to it over HTTP. Sidecar source-of-truth lives in the sibling repo `aXc11426/`; see `services/ensemble/README.md` for vendoring instructions.
- LLM calls go to OpenRouter (`https://openrouter.ai/api/v1/chat/completions`) exclusively through `lib/ai/openrouter-client.ts`, which enforces per-call timeout, single-shot retry, and a per-call USD cost ceiling. Model versions are user-selected via `OPENROUTER_MODELS` / `OPENROUTER_DEFAULT_MODEL`; the code hardcodes no model IDs.
- Local audit log (`AuditEvent` rows) records analysis, calibration, access denial, AI-assist, forecast, and multi-proposer events without storing API keys, raw CSV rows, or free-text queries.
- Feature flag `LEGACY_PATH_A_ENABLED` (default `true`) gates the legacy LLM-drafts-the-graph route. Hosted/demo deploys should set it `false` until R6-07 lands.
