# finESS Real Data Mode Design

## Purpose

finESS must support real local inputs and real empirical results, not only simulated uncertainty models. The first implementation is a domain-agnostic CSV workflow: the user supplies observed rows, selects the measured target column, and finESS computes summary results directly from those rows.

## Scope

- Local CSV paste or upload in the first-run experience.
- Numeric and binary target columns.
- Empirical mean, median, 2.5th percentile, 97.5th percentile, and optional threshold exceedance.
- Save/Load persistence for observed analyses.
- Calibration records tied to saved observed analyses.
- OpenRouter model selection from local env/config.
- Session-only OpenRouter API-key entry for local runs.
- AI-assisted interpretation that uses computed summary statistics only.
- No hosted auth, external data transfer, domain-specific advice, or clinical/legal/financial decision rules.

## Architecture

- `lib/real-data/csv.ts` parses local CSV text with quoted-cell support and row/cell size limits.
- `lib/real-data/analyze.ts` converts observed rows into an empirical analysis result.
- Observed analyses use `UncertaintyGraph.analysisMode = "observed"` so UI and persistence can distinguish them from legacy simulation graphs.
- `components/RealDataPanel.tsx` is the first-run entry point and makes CSV-first analysis the default path.
- `app/page.tsx` keeps observed results in page state and does not call the simulation worker for observed analyses.
- `components/SaveLoadModal.tsx` preserves observed samples because they are source observations, while simulation saves continue to compact bulky generated sample arrays.
- `lib/ai/model-config.ts` parses configured OpenRouter model options from `OPENROUTER_MODELS`, `OPENROUTER_DEFAULT_MODEL`, or `OPENROUTER_MODEL`.
- `app/api/models/route.ts` exposes configured model metadata and whether a server-side env key is present, without returning the key.
- `app/api/real-data/assist/route.ts` calls OpenRouter only after explicit user action and sends observed summary statistics, not the raw CSV rows.

## Data Flow

1. User pastes or uploads CSV locally.
2. User parses columns and selects the target column.
3. finESS computes empirical results from observed values only.
4. The dashboard renders the observed distribution and narration.
5. Optional AI Assist sends the computed summary, missingness count, threshold, and selected model to OpenRouter for JSON interpretation.
6. Save/Load stores and restores `analysisMode: "observed"` plus observed result values.
7. Calibration can record outcomes against the saved observed analysis.

## Guardrails

- CSV parsing and analysis stay client-local.
- AI Assist is opt-in per click and does not receive raw CSV text.
- Runtime API keys are held in browser memory only and are not saved to tracked files or returned by API responses.
- Non-numeric, non-binary target values are rejected.
- Empty CSV, missing target column, duplicate headers, and malformed rows are rejected.
- Observed-result narration uses empirical language and avoids simulation claims.
- OpenRouter output is parsed as JSON and rendered separately from local empirical statistics.
- Existing simulation functionality remains only as a labeled legacy demo/custom-model path.

## Verification

- `__tests__/real-data/csv.test.ts`
- `__tests__/real-data/analyze.test.ts`
- `__tests__/ui/compact-result.test.ts`
- `__tests__/ai/model-config.test.ts`
- `__tests__/real-data/assist.test.ts`
- `__tests__/e2e/workflow.test.ts`
- Browser smoke: Safari at `http://127.0.0.1:3100`, use sample CSV, select target/threshold, analyze observed data, verify model/key setup, save, load, open calibration, record outcome.
