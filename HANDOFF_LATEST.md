# finESS Handoff Packet

**Generated:** 2026-05-19
**Branch:** `main`
**Commit provenance:** verify the exact commit with `git rev-parse HEAD` after checkout. The work landed in this packet sits on top of `1f1b363` (`chore: bump OpenRouter default per-call timeout from 30s to 60s`).
**Working tree:** clean.
**Status:** local pre-production beta with four operating modes. Real Data Mode is the primary first-run workflow. Forecast Mode and the calibration loop are wired to a real Python ensemble sidecar (`services/ensemble/`, wrapping `ace_hospital.UnifiedACEEnsemble`). A Multi-LLM Proposer lane runs configured OpenRouter models in parallel. Path A (LLM-drafts-the-graph) is gated behind `LEGACY_PATH_A_ENABLED`, semantically validated, and rendered with a non-dismissible draft-model banner. Hosted-deployment risks remain out of scope; see Deferred Production Risks.

## Current Product State

finESS is a local Next.js/Prisma/SQLite beta exposing four modes from `app/page.tsx`:

1. **Real Data Mode** — CSV → empirical observed stats → Save / Load / Calibration. Optional AI Assist sends only summary statistics. (`components/RealDataPanel.tsx`, `lib/real-data/`, `app/api/real-data/assist/route.ts`.)
2. **Forecast Mode** — CSV time series → `POST /api/forecast` → Python sidecar trains the unified ACE ensemble and returns per-model weights, individual predictions, the SLSQP-optimised ensemble forecast, and a 95% interval. Server-generated `forecastId` lets a later calibration outcome flow back into the sidecar's EMA learner. (`components/ForecastPanel.tsx`, `app/api/forecast/route.ts`, `lib/services/ensemble-client.ts`, `services/ensemble/app.py`.)
3. **Multi-LLM Proposer** — `POST /api/analyze/multi` fans out the query to all configured OpenRouter models in parallel with bounded concurrency, isolating per-model failures so disagreement is visible. (`lib/ai/multi-proposer.ts`, `app/api/analyze/multi/route.ts`, `components/MultiProposalsPanel.tsx`.)
4. **Path A simulation (legacy / draft only)** — `POST /api/analyze` drafts an uncertainty graph via a single LLM and runs deterministic Monte Carlo. Every node carries a `source` provenance field; semantic validation in `lib/ai/parse-response.ts` rejects bad graphs; a non-dismissible amber Draft Model banner sits above the result (`components/PathADraftBanner.tsx`); the whole route is gated by `LEGACY_PATH_A_ENABLED` via `lib/feature-flags.ts`.

All OpenRouter calls funnel through `lib/ai/openrouter-client.ts`, which enforces per-call wall-clock timeout (`OPENROUTER_TIMEOUT_MS`, default 60_000), single-shot retry on transient failure, and a per-call USD cost ceiling (`OPENROUTER_PER_CALL_BUDGET_USD`, default 0.05). The calibration loop is closed: outcomes attached to a `forecastId` are forwarded to the sidecar's `POST /outcome`, the sidecar updates an in-process EMA learner, and the next `/predict` with `useLatestPriors=true` re-optimises SLSQP weights against the freshly-derived Beta priors.

Audit metadata intentionally avoids API keys, session tokens, raw CSV rows, and free-text queries. Model versions are user-selected via `OPENROUTER_MODELS` / `OPENROUTER_DEFAULT_MODEL`; no model ID is hardcoded.

## Completed Work

| Area | Status | Evidence |
|---|---|---|
| Semantic validation of LLM-drafted graphs | Complete locally | `lib/ai/parse-response.ts`, `__tests__/ai/parse-response.semantic.test.ts` (M8-01, commit `2800d61`) |
| Secret-hygiene rotation runbook | Complete locally | `RELEASE_CHECKLIST.md` rotation section (S5-01, commit `2800d61`) |
| Provenance `source` field on every node | Complete locally | `lib/ai/parse-response.ts`, `lib/types.ts`, `components/NodeEditor.tsx` (M8-02, commit `8482d6b`) |
| Path A draft-model banner | Complete locally | `components/PathADraftBanner.tsx` (R6-01, commit `8482d6b`) |
| Boot-time OpenRouter model preflight | Complete locally | `scripts/preflight-models.mjs`, `__tests__/scripts/preflight-models.test.ts` (M8-03, commit `8482d6b`) |
| Path A behind `LEGACY_PATH_A_ENABLED` flag | Complete locally | `lib/feature-flags.ts`, `app/api/analyze/route.ts`, `__tests__/api/analyze-flag.test.ts` (S5-02, commits `87b3e36`, `38c4f75`) |
| Python ensemble sidecar (real `ace_hospital`) | Complete locally | `services/ensemble/app.py`, `services/ensemble/Dockerfile`, `docker-compose.yml`, `lib/services/ensemble-client.ts`, `__tests__/services/ensemble-client.test.ts` (R6-04, commits `afd7e1b`, `dbf3052`) |
| Centralised OpenRouter client (timeout/retry/budget) | Complete locally | `lib/ai/openrouter-client.ts`, `scripts/lib/openrouter-client.mjs`, `__tests__/ai/openrouter-client.test.ts` (P7-01, commit `66aa4d5`; default timeout 60s per `1f1b363`) |
| Domain-tagged few-shot prompt cleanup | Complete locally | `lib/ai/prompt.ts`, `lib/ai/examples/`, `__tests__/ai/prompt.test.ts` (M8-04, commit `f22bea2`) |
| Forecast Mode UI + `POST /api/forecast` + migration | Complete locally | `components/ForecastPanel.tsx`, `app/api/forecast/route.ts`, `prisma/migrations/20260519105137_add_forecast_id_to_calibration_outcome/migration.sql`, `__tests__/api/forecast.test.ts` (R6-05, commit `e99a3bb`) |
| Multi-LLM Proposer lane | Complete locally | `lib/ai/multi-proposer.ts`, `app/api/analyze/multi/route.ts`, `components/MultiProposalsPanel.tsx`, `__tests__/ai/multi-proposer.test.ts`, `__tests__/api/analyze-multi.test.ts` (R6-02, commit `0ca2e68`) |
| Calibration → Beta-prior feedback loop | Complete locally | `app/api/calibration/route.ts`, `lib/services/ensemble-client.ts` (`recordOutcome`, `getPriors`), `__tests__/api/calibration-feedback.test.ts` (R6-06, commit `0ca2e68`) |
| OpenRouter timeout default bump | Complete locally | `lib/ai/openrouter-client.ts`, `scripts/lib/openrouter-client.mjs`, `.env.example` (commit `1f1b363`) |

## Verification Results

| Command | Result |
|---|---|
| `npm run check:env` | PASS — `Environment preflight passed`. Validates `DATABASE_URL` and the literal value of `LEGACY_PATH_A_ENABLED`. |
| `npm run preflight:models` | PASS in skipped mode without an API key (`PREFLIGHT_MODELS_SKIPPED`); probes every configured model when a key is present. |
| `npm run smoke:openrouter` | PASS in blocked mode — prints `OPENROUTER_LIVE_SMOKE_BLOCKED` without printing secrets. |
| `OPENROUTER_LIVE_SMOKE=1 npm run smoke:openrouter` | PASS when `OPENROUTER_API_KEY` is set; prints `OPENROUTER_LIVE_SMOKE_OK` against the configured `OPENROUTER_DEFAULT_MODEL`. |
| `npm test -- --runInBand` | PASS — 28 of 32 suites executed (4 integration suites are `describe.skip`-gated behind `RUN_ENSEMBLE_INTEGRATION` / `RUN_OPENROUTER_LIVE`); 243 of 248 tests passed; 5 tests skipped (the gated integration cases). The transient `__tests__/validation/schemas.test.ts` failure observed mid-batch was caused by parallel-agent file edits during the in-flight build; re-runs on the merged state are green. |
| `npm run test:e2e` | PASS — `__tests__/e2e/workflow.test.ts` exercises the full Real Data Mode workflow. |
| `npm run build` | PASS — Next.js production build completed; all API routes (`/api/analyses`, `/api/analyze`, `/api/analyze/multi`, `/api/auth/local`, `/api/calibration`, `/api/forecast`, `/api/models`, `/api/real-data/assist`) registered. |
| `RUN_ENSEMBLE_INTEGRATION=1 npx jest __tests__/integration/forecast.integration.test.ts --runInBand` | Gated; requires `docker compose up -d ensemble` first. Asserts shape of the live ensemble response. |
| `RUN_ENSEMBLE_INTEGRATION=1 npx jest __tests__/integration/calibration-loop.integration.test.ts --runInBand` | Gated; requires the sidecar. Asserts the favoured model's weight rises after biased outcomes — proves the loop is closed end-to-end. |
| `RUN_OPENROUTER_LIVE=1 npx jest __tests__/integration/analyze-multi.integration.test.ts --runInBand` | Gated; requires a live `OPENROUTER_API_KEY` and at least two `OPENROUTER_MODELS`. Asserts two real, semantically distinct proposals. |
| `git diff --check` | PASS. |

## Environment State

- `.env` contains a local SQLite `DATABASE_URL=file:./dev.db` for Prisma CLI usage.
- `.env.local` (gitignored) holds runtime config for Next.js. Current shape, per `.env.example`:
  - `OPENROUTER_API_KEY` — required for Path A, Multi-LLM Proposer, AI Assist, and the live smoke. Never persisted by the app.
  - `OPENROUTER_MODELS` — comma- or JSON-encoded model list. User-selected; do not hardcode.
  - `OPENROUTER_DEFAULT_MODEL` — the default selection when the UI loads.
  - `OPENROUTER_TIMEOUT_MS` — per-call wall-clock timeout enforced in `lib/ai/openrouter-client.ts`. Default 60_000.
  - `OPENROUTER_PER_CALL_BUDGET_USD` — per-call cost ceiling. Default 0.05. Calls reporting usage above the ceiling raise `BUDGET_EXCEEDED` and the route returns 402 `UPSTREAM_BUDGET_EXCEEDED`.
  - `OPENROUTER_LIVE_SMOKE` — gates `scripts/openrouter-live-smoke.mjs`. Default `0`.
  - `LEGACY_PATH_A_ENABLED` — must be exactly `true` or `false`. Default `true` for local dev; flip to `false` for hosted/demo deploys.
- The sidecar URL is read from `ENSEMBLE_SIDECAR_URL` by `lib/services/ensemble-client.ts` and defaults to `http://localhost:8001` (see the `EnsembleClient` constructor). It is not currently listed in `.env.example`. TODO: confirm with orchestrator whether `ENSEMBLE_SIDECAR_URL` should be promoted into `.env.example` once non-default deployments exist.
- `services/ensemble/` reads `ENSEMBLE_LOAD_CHRONOS`, `ENSEMBLE_CHRONOS_SIZE`, `ENSEMBLE_LOG_LEVEL`, and (for its pytest suite) `ENSEMBLE_SKIP_INTEGRATION`. Chronos is off by default to keep cold-start fast.
- No real secrets are committed; `.env.local` is gitignored.

## Deferred Production Risks

- **Hosted deployment** remains deferred: real auth provider, HTTPS-only cookie policy, account recovery/admin policy, migration/backfill policy, production secret management, privacy/compliance review, and abuse/rate-limit policy are not implemented.
- **Audit events** are local SQLite records, not tamper-resistant production audit logs.
- **Persistent key storage** is intentionally not implemented.
- **Sidecar EMA state is in-process memory only.** Restarting `services/ensemble` (or `docker compose down`) discards every Beta prior accumulated by the calibration loop. SQLite still holds the raw `CalibrationOutcome` rows, but there is no replay-on-boot job that rebuilds the EMA. A future task should either persist the EMA snapshot or replay all `CalibrationOutcome` rows on sidecar startup.
- **Path A is still a draft mode pending R6-07** (N-graph LLM ensemble with node alignment). The current single-LLM Path A produces a draft graph; the math operates on LLM priors, not verified data. The amber banner and `LEGACY_PATH_A_ENABLED` flag make this visible but do not change the underlying single-LLM bottleneck. Multi-LLM Proposer is a sibling lane, not a replacement.
- **Real Data Mode** still supports single-table CSV only; joins, time-series validation splits beyond the forecast route, external connectors, and report/export features remain deferred.
- finESS remains domain-agnostic. It does not provide clinical, legal, financial, engineering, or policy advice.

## Operator Notes

- Bring up the Python ensemble sidecar before any Forecast Mode work or before running the calibration-loop integration test: `docker compose up -d ensemble`, then `curl -fsS http://localhost:8001/health`. Tear down with `docker compose down`. The sidecar mounts `../aXc11426` read-only (see `docker-compose.yml`).
- After any change to `.env.local` (new key, new `OPENROUTER_MODELS`, swapped `OPENROUTER_DEFAULT_MODEL`): run `npm run preflight:models`. It will refuse to pass if any listed model returns 4xx/5xx, catching typos and discontinued IDs before a user does.
- Live OpenRouter smoke remains the standing provider check. Run `OPENROUTER_LIVE_SMOKE=1 npm run smoke:openrouter`; expect `OPENROUTER_LIVE_SMOKE_OK` against the configured `OPENROUTER_DEFAULT_MODEL`. Blocked mode (`npm run smoke:openrouter` with no key or with `OPENROUTER_LIVE_SMOKE` unset) is also CI-asserted.
- Multi-LLM Proposer dry-run: `npm run smoke:multi-proposer`.
- Model selection is user-controlled via `OPENROUTER_MODELS` and `OPENROUTER_DEFAULT_MODEL`. Do not change defaults without explicit approval. Avoid reasoning models for the smoke unless you also raise the budget — they can spend the per-call cost cap on internal reasoning and trigger `BUDGET_EXCEEDED`.
- `OPENROUTER_API_KEY` lives only in `.env.local` (gitignored). Do not paste it into chat or commit it. Rotate on OpenRouter if it is ever exposed.
- Start the dev server with `npm run dev -- -H 127.0.0.1 -p 3100`.
- Path A is enabled by default for local dev; set `LEGACY_PATH_A_ENABLED=false` in `.env.local` for any deploy where the operator is not actively editing nodes.
- Mitigation roadmap (full task backlog, dependencies, success metrics): `docs/plans/2026-05-18-vaporware-to-real-mitigation-plan.md`.
