# finESS UX and IT Mitigation Plan

**Date:** 2026-05-16
**Audience:** Codex or equivalent coding agent
**Scope:** Convert the 2026-05-16 UX/workflow and IT readiness review into an implementation backlog.
**Source of truth:** `HANDOFF_LATEST.md`, `docs/plans/2026-05-12-finESS-platform-design.md`, `docs/plans/2026-05-13-finESS-implementation-plan-v2.md`, and live verification from 2026-05-16.

## 1. Executive Remediation Summary

**Risk posture shift:** impressive local prototype -> disciplined single-user beta -> multi-user deployable product.

**Risk delta summary:**
- Reduce immediate runtime failure risk by fixing environment precedence and adding API smoke tests.
- Reduce user abandonment by replacing the empty cockpit first-run state with a guided decision workflow.
- Reduce data exposure risk by making single-user/local mode explicit now and adding auth/tenant boundaries before hosted use.
- Reduce agent redo risk by aligning local dirty state, committed state, and verification state.
- Reduce AI graph correctness risk by closing the `custom` edge-method gap.

**Effort estimate:** 89 story points, roughly 14-22 person-days.
**Assumptions:** one experienced TypeScript/Next.js agent, local SQLite remains acceptable for prototype mode, hosted deployment is blocked until auth and data isolation are implemented.

**Quick-win ROI under 4 hours:**
- Remove empty `DATABASE_URL` from `.env.local` and add a guard test. Unlocks Save/Load and Calibration API use.
- Commit and push the existing Save/Load and Calibration UI. Aligns local state with GitHub and handoff.
- Add a first-run callout that makes the PE instant demo the primary path. Cuts first-use confusion.
- Hide or disable Calibration until an analysis is saved. Removes a dead-end action.
- Remove or reject `custom` combination methods. Prevents silent AI graph mis-execution.
- Add GitHub Actions for `npm test` and `npm run build`. Prevents regressions from passing locally only.

**Systemic themes:**
- Empty-state UX is weaker than the dashboard visualization.
- Persistence exists but is not yet a coherent analysis lifecycle.
- Tests prove engine math, not user workflows or runtime APIs.
- Shared deployment would currently expose all saved analyses to all users.
- Configuration mistakes can pass build/tests but break runtime features.

## 2. Prioritization Matrix

| Effort \ Impact | High (P0/P1) | Medium (P2) | Low (P2) |
|---|---|---|---|
| Easy (<=4h) | UX-01 First-run guided path, IT-01 Env precedence fix, IT-02 Commit local UI, IT-05 Remove `custom` method gap | UX-04 Header action state, IT-08 Error message hygiene | IT-11 Root artifact cleanup |
| Medium (4-16h) | UX-02 Analysis lifecycle strip, UX-03 Save/Calibration workflow, IT-03 API integration tests, IT-04 CI pipeline, IT-06 Schema validation | UX-05 Model selector redesign, UX-06 Responsive layout pass, IT-09 Runtime smoke script | DOC-01 Docs/runbook alignment |
| Hard (>=16h) | IT-07 Auth and tenant isolation, IT-10 E2E workflow suite | UX-07 Export/share-ready analysis object, IT-12 Observability and audit events | PERF-01 Simulation performance guardrails |

## 3. Atomic Mitigation Tasks

### 3.1 Fix Runtime Environment Precedence

**ID:** `IT-01`
**Review Quote:** "Current local runtime has broken persistence and calibration... `.env.local` currently overrides `DATABASE_URL` to empty."
**Why it matters:** Build and unit tests can pass while `/api/analyses` and `/api/calibration` fail at runtime. This blocks Save/Load and Calibration, the two features the handoff says are ready.
**Priority:** P0
**Estimate:** 2h
**Owner Type:** Agent
**Risk if skipped:** High
**Dependencies:** none
**Done When:** `/api/analyses` and `/api/calibration` return valid JSON in local dev with the documented two-file env setup.

#### A) Preconditions and Repo Context
- **Files to inspect:** `.env.example`, `.env.local`, `.env`, `app/api/analyses/route.ts`, `app/api/calibration/route.ts`
- **Commands to run:**
  ```bash
  npm test -- --runInBand
  npm run build
  npm run dev
  curl -sS http://localhost:3000/api/analyses
  curl -sS http://localhost:3000/api/calibration
  ```
- **Expected signals:** tests pass, build passes, API routes do not return Prisma datasource errors.

#### B) Implementation Plan
1. Remove `DATABASE_URL=` from local `.env.local`; keep `DATABASE_URL=file:./dev.db` only in `.env`.
2. Update `.env.example` comments to explicitly warn that `.env.local` must not contain an empty `DATABASE_URL`.
3. Add a preflight helper script `scripts/check-env.mjs` that fails if `DATABASE_URL` is present but empty in `.env.local`.
4. Add `npm run check:env` to `package.json`.
5. Call the script from the final verification suite.

#### C) Tests and Verification
- **Unit:**
  ```bash
  npm test -- --runInBand
  ```
- **Integration:**
  ```bash
  npm run check:env
  npm run dev
  curl -f http://localhost:3000/api/analyses
  curl -f http://localhost:3000/api/calibration
  ```
- **Edge cases:**
  - `.env` missing.
  - `.env.local` contains no `DATABASE_URL`.
  - `.env.local` contains `DATABASE_URL=`.
  - `.env.local` contains non-empty `DATABASE_URL`.
- **Pass/Fail criteria:** any empty `DATABASE_URL` causes `npm run check:env` to exit nonzero with a readable message.

#### D) Rollout and Migration
- No data migration.
- Rollback: revert `.env.example`, `package.json`, and `scripts/check-env.mjs`.

#### E) Cleanup and Documentation
- Update `HANDOFF_LATEST.md` after verifying.
- Grep target:
  ```bash
  git grep -n "DATABASE_URL="
  ```

#### F) Success Metrics
- 0 runtime Prisma datasource errors in local smoke tests.
- 100 percent of setup docs describe the two-file env split consistently.

### 3.2 Commit and Push Existing Save/Load and Calibration UI

**ID:** `IT-02`
**Review Quote:** "Local state and GitHub state are not aligned."
**Why it matters:** A future agent or clone will not see the UI that the current handoff says is present. This creates false readiness and redo risk.
**Priority:** P0
**Estimate:** 1h
**Owner Type:** Agent
**Risk if skipped:** High
**Dependencies:** `IT-01` recommended first
**Done When:** `app/page.tsx`, `components/SaveLoadModal.tsx`, and `components/CalibrationModal.tsx` are committed and pushed, and a fresh clone can build.

#### A) Preconditions and Repo Context
- **Files to inspect:** `app/page.tsx`, `components/SaveLoadModal.tsx`, `components/CalibrationModal.tsx`, `HANDOFF_LATEST.md`
- **Commands to run:**
  ```bash
  git status --short
  npm test -- --runInBand
  npm run build
  ```
- **Expected signals:** only intended files are staged; tests and build pass.

#### B) Implementation Plan
1. Review the dirty tree and classify unrelated files:
   - Intended: `app/page.tsx`, `components/SaveLoadModal.tsx`, `components/CalibrationModal.tsx`, docs if updated.
   - Do not stage old prototype HTML/Python files unless explicitly moved in `IT-11`.
2. Stage only intended files.
3. Commit with:
   ```bash
   git commit -m "feat(p0): add save load and calibration UI"
   ```
4. Push current branch:
   ```bash
   git push origin main
   ```
5. Verify remote contains the commit:
   ```bash
   git ls-remote origin main
   ```

#### C) Tests and Verification
- **Unit:** `npm test -- --runInBand`
- **Build:** `npm run build`
- **Manual sanity check:** Run PE demo, open Save/Load, save, load, open Calibration.
- **Pass/Fail criteria:** pushed branch contains the UI files and build passes after a clean checkout.

#### D) Rollout and Migration
- No schema migration beyond existing Prisma schema.
- Rollback: `git revert <commit_sha>` if UI introduces runtime breakage.

#### E) Cleanup and Documentation
- Update `HANDOFF_LATEST.md` to remove "uncommitted" status after push.

#### F) Success Metrics
- 0 discrepancy between handoff and GitHub state.

### 3.3 Build a First-Run Guided Path

**ID:** `UX-01`
**Review Quote:** "First-run success depends on discovering the hidden happy path."
**Why it matters:** The target user is a domain expert without statistical tooling expertise. Opening to six empty panels creates uncertainty about what to do first.
**Priority:** P0
**Estimate:** 6h
**Owner Type:** Agent
**Risk if skipped:** High
**Dependencies:** none
**Done When:** a new user can run the PE demo from an obvious primary action within one click.

#### A) Preconditions and Repo Context
- **Files to inspect:** `app/page.tsx`, `components/InputBar.tsx`, `components/Dashboard.tsx`, `components/NarrationStream.tsx`
- **Commands to run:**
  ```bash
  npm run dev
  ```
- **Expected signals:** first screen currently shows empty panels and bottom input.

#### B) Implementation Plan
1. Add a first-run empty state component, for example `components/FirstRunPanel.tsx`.
2. Render it over or inside the Node Network panel when `graph === null` and `sim.phase === "idle"`.
3. Include a primary button: `Try instant PE demo`.
4. Include one secondary path: focus the input field for custom analysis.
5. Keep text short and product-specific:
   - What finESS does.
   - Why the PE demo is instant.
   - That custom AI queries require model/API setup.
6. Ensure the primary button calls the existing PE demo handler.
7. Ensure the panel disappears once a graph exists.

#### C) Tests and Verification
- **Component/E2E after `IT-10`:**
  ```bash
  npm run test:e2e -- first-run
  ```
- **Manual sanity check:**
  1. Open `http://localhost:3000`.
  2. Confirm the first screen contains a primary PE demo action.
  3. Click it.
  4. Confirm graph, distributions, gauges, and narration populate.
- **Edge cases:**
  - Reload after a graph is running.
  - PE demo clicked twice.
  - No API key present.
  - Narrow viewport.
- **Pass/Fail criteria:** first-run user does not need the Examples dropdown to find the demo.

#### D) Rollout and Migration
- No migration.
- Rollback: remove `FirstRunPanel` and restore current panel rendering.

#### E) Cleanup and Documentation
- Update run instructions in `HANDOFF_LATEST.md`.

#### F) Success Metrics
- First successful demo run requires <=1 click from initial page.

### 3.4 Add an Analysis Lifecycle Status Strip

**ID:** `UX-02`
**Review Quote:** "Workflow lacks a durable analysis object mental model."
**Why it matters:** Users need to understand whether the current analysis is unsaved, saved, calibrated, loaded, or stale after edits.
**Priority:** P1
**Estimate:** 8h
**Owner Type:** Agent
**Risk if skipped:** Medium
**Dependencies:** `IT-02`
**Done When:** the header or a compact status strip always shows current query state, saved state, seed, result status, and next action.

#### A) Preconditions and Repo Context
- **Files to inspect:** `app/page.tsx`, `components/SaveLoadModal.tsx`, `components/CalibrationModal.tsx`, `lib/types.ts`
- **Commands to run:** `npm run dev`
- **Expected signals:** page state includes `currentQuery`, `savedAnalysisId`, `graph`, and `sim.result`.

#### B) Implementation Plan
1. Add `components/AnalysisStatusStrip.tsx`.
2. Props:
   - `query`
   - `graph`
   - `result`
   - `savedAnalysisId`
   - `phase`
   - callbacks for save/load/calibration.
3. Display states:
   - Empty: "No analysis yet"
   - Running: "Simulation running"
   - Complete unsaved: "Unsaved analysis"
   - Saved: "Saved analysis: <short id>"
   - Edited after save: "Unsaved changes" after NodeEditor changes.
4. Move Save/Load and Calibration buttons into this strip or bind their disabled states to it.
5. Set `savedAnalysisId` to null when the graph is edited.
6. Keep the header focused on product identity only.

#### C) Tests and Verification
- **Unit:** add React tests after `IT-10` testing states.
- **Manual sanity check:** Run demo -> strip says unsaved -> save -> strip says saved -> edit node -> strip says unsaved changes.
- **Pass/Fail criteria:** user can tell what object they are working with at every point.

#### D) Rollout and Migration
- No DB migration.
- Rollback: revert component and page wiring.

#### E) Cleanup and Documentation
- Update `HANDOFF_LATEST.md` feature matrix.

#### F) Success Metrics
- 0 ambiguous saved/unsaved states in manual walkthrough.

### 3.5 Make Save and Calibration a Guided Workflow

**ID:** `UX-03`
**Review Quote:** "Save/Load and Calibration look available before they are meaningful."
**Why it matters:** Calibration is a core principle, but the current modal can be opened before it can do useful work.
**Priority:** P1
**Estimate:** 8h
**Owner Type:** Agent
**Risk if skipped:** Medium
**Dependencies:** `UX-02`, `IT-01`, `IT-02`
**Done When:** after a completed run, the UI suggests Save first, then Record outcome after save.

#### A) Preconditions and Repo Context
- **Files to inspect:** `app/page.tsx`, `components/SaveLoadModal.tsx`, `components/CalibrationModal.tsx`
- **Commands to run:** `npm run dev`

#### B) Implementation Plan
1. Disable or de-emphasize Calibration until `savedAnalysisId` and `sim.result` are present.
2. In the disabled state, show a tooltip or status text: "Save this analysis before recording outcomes."
3. After Save succeeds, show a next-action button: `Record outcome`.
4. Ensure Save stores enough state for reproducibility: query, graph, result, sensitivity, seed.
5. After Load, set `savedAnalysisId` from the loaded record. If current API response lacks id in the callback, add it.
6. In Calibration, prevent duplicate accidental outcome recording with a confirmation or record-once-per-open state.

#### C) Tests and Verification
- **Integration:**
  ```bash
  curl -f http://localhost:3000/api/analyses
  curl -f http://localhost:3000/api/calibration
  ```
- **Manual sanity check:** Demo -> Calibration disabled/instructive -> Save -> Calibration enabled -> record outcome -> count increments.
- **Edge cases:** loaded saved analysis, edited saved analysis, no predicted probability, failed API save.

#### D) Rollout and Migration
- No schema migration required unless duplicate prevention is enforced server-side.
- Rollback: restore current always-visible buttons.

#### E) Cleanup and Documentation
- Document analysis lifecycle in `HANDOFF_LATEST.md`.

#### F) Success Metrics
- 0 dead-end modal opens in the primary workflow.

### 3.6 Add API Integration Tests

**ID:** `IT-03`
**Review Quote:** "There is no API route test coverage."
**Why it matters:** The live env failure proves unit tests are not enough. API tests must catch persistence, validation, and calibration regressions.
**Priority:** P1
**Estimate:** 12h
**Owner Type:** Agent
**Risk if skipped:** High
**Dependencies:** `IT-01`
**Done When:** Jest integration tests cover `/api/analyses`, `/api/analyses/[id]`, and `/api/calibration` against a test SQLite database.

#### A) Preconditions and Repo Context
- **Files to inspect:** `app/api/analyses/route.ts`, `app/api/analyses/[id]/route.ts`, `app/api/calibration/route.ts`, `prisma/schema.prisma`, `jest.config.ts`
- **Commands to run:**
  ```bash
  npx prisma generate
  npm test -- --runInBand
  ```

#### B) Implementation Plan
1. Add test helper to set `DATABASE_URL=file:./test.db` for API tests.
2. Add setup/teardown that runs `prisma db push --force-reset` against test DB.
3. Test analysis create/list/load/delete.
4. Test calibration not-ready response under 20 outcomes.
5. Test calibration ready response at 20 outcomes.
6. Test error cases: missing fields, nonexistent analysis, invalid probability.
7. Ensure tests do not touch `prisma/dev.db`.

#### C) Tests and Verification
- **Unit/Integration:**
  ```bash
  npm test -- --runInBand
  ```
- **Pass/Fail criteria:** API tests fail on missing `DATABASE_URL`, bad schema, invalid save payload, or broken calibration math.

#### D) Rollout and Migration
- Add `.gitignore` entry for test DB if needed.
- Rollback: remove API test files and Jest setup changes.

#### E) Cleanup and Documentation
- Update `HANDOFF_LATEST.md` from "No API route tests" to covered.

#### F) Success Metrics
- API route coverage present for every route listed under `app/api`.

### 3.7 Add CI Pipeline

**ID:** `IT-04`
**Review Quote:** "No GitHub Actions or deployment pipeline."
**Why it matters:** Without CI, future commits can break clone readiness, builds, or tests without detection.
**Priority:** P1
**Estimate:** 4h
**Owner Type:** Agent
**Risk if skipped:** High
**Dependencies:** `IT-01`, `IT-03` recommended
**Done When:** GitHub Actions runs install, env check, Prisma generate, tests, and build on push/PR.

#### A) Preconditions and Repo Context
- **Files to inspect:** `package.json`, `.github/workflows`, `.env.example`
- **Commands to run:** `npm ci && npm test -- --runInBand && npm run build`

#### B) Implementation Plan
1. Add `.github/workflows/ci.yml`.
2. Use Node 20.
3. Install with `npm ci`.
4. Write CI env files:
   ```bash
   echo "DATABASE_URL=file:./dev.db" > .env
   echo "OPENROUTER_API_KEY=" > .env.local
   ```
5. Run:
   ```bash
   npm run check:env
   npx prisma generate
   npx prisma db push
   npm test -- --runInBand
   npm run build
   ```
6. Do not require a real OpenRouter key for CI.

#### C) Tests and Verification
- **CI local equivalent:**
  ```bash
  npm ci
  npm run check:env
  npx prisma generate
  npx prisma db push
  npm test -- --runInBand
  npm run build
  ```
- **Pass/Fail criteria:** workflow is green on GitHub.

#### D) Rollout and Migration
- No migration.
- Rollback: remove workflow file.

#### E) Cleanup and Documentation
- Add CI badge only after first green run.

#### F) Success Metrics
- 100 percent of PRs run build/test checks.

### 3.8 Remove or Implement the `custom` Edge Method

**ID:** `IT-05`
**Review Quote:** "`custom` is a valid edge method in types and parser, but the executor has no custom implementation."
**Why it matters:** AI can produce a graph that validates but executes incorrectly. Silent math errors are more dangerous than explicit rejection.
**Priority:** P1
**Estimate:** 3h
**Owner Type:** Agent
**Risk if skipped:** High
**Dependencies:** none
**Done When:** `custom` is either fully implemented with tests or rejected by parser/types.

#### A) Preconditions and Repo Context
- **Files to inspect:** `lib/types.ts`, `lib/ai/parse-response.ts`, `lib/engine/dag-executor.ts`, `__tests__/ai/parse-response.test.ts`, `__tests__/engine/dag-executor.test.ts`
- **Commands to run:** `npm test -- --runInBand`

#### B) Implementation Plan
1. Prefer removal unless a concrete custom expression schema exists.
2. Remove `"custom"` from `CombinationMethod`.
3. Remove `"custom"` from `VALID_METHODS`.
4. Update prompt if it lists valid methods.
5. Add parser test that custom is rejected.
6. Add executor test ensuring unknown methods cannot silently fall through.

#### C) Tests and Verification
- **Unit:**
  ```bash
  npm test -- --runInBand
  ```
- **Pass/Fail criteria:** an AI response with `"method": "custom"` returns a validation error before simulation.

#### D) Rollout and Migration
- Existing saved analyses using `custom` would fail to load/run. Add a safe error message if any are discovered.
- Rollback: restore type and parser only if implementing real custom semantics.

#### E) Cleanup and Documentation
- Grep target:
  ```bash
  git grep -n '"custom"'
  ```

#### F) Success Metrics
- 0 validated graphs contain unsupported edge methods.

### 3.9 Add Runtime Schema Validation

**ID:** `IT-06`
**Review Quote:** "API validation is too thin for production."
**Why it matters:** The app accepts AI-generated and user-supplied graph JSON. Invalid payloads can cause bad simulations, DB bloat, or unclear failures.
**Priority:** P1
**Estimate:** 12h
**Owner Type:** Agent
**Risk if skipped:** High
**Dependencies:** `IT-05`
**Done When:** all API request bodies are validated with a shared schema and return stable 400/422 errors.

#### A) Preconditions and Repo Context
- **Files to inspect:** `lib/types.ts`, `lib/ai/parse-response.ts`, `app/api/analyze/route.ts`, `app/api/analyses/route.ts`, `app/api/calibration/route.ts`
- **Commands to run:** `npm test -- --runInBand`

#### B) Implementation Plan
1. Add a validation library only if needed; `zod` is recommended for small typed schemas.
2. Create `lib/validation/schemas.ts`.
3. Define schemas for:
   - `UncertaintyNode`
   - `ReasoningEdge`
   - `UncertaintyGraph`
   - analysis save request
   - calibration outcome request
4. Replace ad hoc checks in API routes with schema validation.
5. Keep `parseAIResponse` strict and reuse the graph schema.
6. Add request size guard for save payloads, with conservative limit documented.

#### C) Tests and Verification
- **Unit:** schema tests for valid/invalid graphs.
- **Integration:** API route tests from `IT-03`.
- **Pass/Fail criteria:** invalid body never reaches Prisma write calls.

#### D) Rollout and Migration
- No DB migration.
- Backward compatibility: saved legacy records may still parse if schema-compatible.

#### E) Cleanup and Documentation
- Update `.env.example` only if request-size env config is added.

#### F) Success Metrics
- 100 percent of API writes pass through shared schema validation.

### 3.10 Redesign Model Selection for Nontechnical Users

**ID:** `UX-05`
**Review Quote:** "The model selector is technically correct but user-hostile."
**Why it matters:** The target user should not need to know model IDs before seeing product value.
**Priority:** P2
**Estimate:** 6h
**Owner Type:** Agent
**Risk if skipped:** Medium
**Dependencies:** `UX-01`
**Done When:** first-run demo needs no model choice, and custom AI generation explains model/API requirements clearly.

#### A) Preconditions and Repo Context
- **Files to inspect:** `components/ModelSelector.tsx`, `components/InputBar.tsx`, `app/page.tsx`

#### B) Implementation Plan
1. Keep no-default-model behavior for custom AI queries.
2. Move model selector into an "AI setup" compact control or collapsible settings area.
3. When user submits a custom query without a model, show an inline action, not only a header error.
4. Validate stale suggested model IDs before release; if unverifiable, label them examples and keep custom entry.
5. Persist last selected model in `localStorage` if this remains local-only.

#### C) Tests and Verification
- Manual: PE demo works with no model; custom query without model shows clear setup prompt.

#### D) Rollout and Migration
- No migration.

#### E) Cleanup and Documentation
- Update README/handoff once UI changes.

#### F) Success Metrics
- PE demo completion path has 0 model-selection steps.

### 3.11 Add Responsive Layout and Accessibility Pass

**ID:** `UX-06`
**Review Quote:** "The six-panel grid is fixed at 12 columns and 6 rows."
**Why it matters:** A domain expert may open this on laptop, tablet, or split-screen. Current fixed dashboard risks unusable panels and inaccessible canvas-only information.
**Priority:** P2
**Estimate:** 12h
**Owner Type:** Agent
**Risk if skipped:** Medium
**Dependencies:** `UX-01`
**Done When:** dashboard is usable at desktop, tablet, and mobile widths, and key canvas results have text equivalents.

#### A) Preconditions and Repo Context
- **Files to inspect:** `components/Dashboard.tsx`, `app/globals.css`, `components/panels/*.tsx`, `components/NarrationStream.tsx`

#### B) Implementation Plan
1. Add responsive dashboard variants:
   - desktop: current 12-column grid.
   - tablet: 2-column stacked panels.
   - mobile: single-column panels with the input always reachable.
2. Add text summaries for canvas panels where possible.
3. Add accessible labels to interactive controls.
4. Ensure modal focus handling and Escape close are consistent.
5. Avoid hidden hover-only destructive controls for touch users.

#### C) Tests and Verification
- Add Playwright screenshots at 1440x900, 1024x768, 390x844 after `IT-10`.
- Pass/Fail: no overlapping text, input reachable, primary actions visible.

#### D) Rollout and Migration
- No migration.

#### E) Cleanup and Documentation
- Document supported viewport expectations.

#### F) Success Metrics
- 0 critical layout overlaps in screenshot checks.

### 3.12 Add Auth and Tenant Isolation Before Hosted Deployment

**ID:** `IT-07`
**Review Quote:** "There is no auth, tenant isolation, or access control."
**Why it matters:** Saved analyses may contain sensitive clinical, financial, legal, or engineering context. Shared deployment without isolation exposes user data.
**Priority:** P0 for hosted deployment; P2 for local-only prototype
**Estimate:** 21h
**Owner Type:** Mixed
**Risk if skipped:** High
**Dependencies:** product decision on local-only vs hosted
**Done When:** hosted mode requires authentication, all saved records are scoped by user/workspace, and unauthenticated requests cannot read/write analyses.

#### A) Preconditions and Repo Context
- **Files to inspect:** `app/api/analyses/route.ts`, `app/api/analyses/[id]/route.ts`, `app/api/calibration/route.ts`, `prisma/schema.prisma`

#### B) Implementation Plan
1. Decide deployment mode:
   - local-only single-user: add explicit banner and block public deploy claims.
   - hosted: implement auth before deployment.
2. For hosted mode, add auth provider or NextAuth/Auth.js.
3. Add `User` or `Workspace` model and `userId`/`workspaceId` on `Analysis`.
4. Scope all Prisma queries by authenticated principal.
5. Add migration and backfill path for existing local records.
6. Add tests for cross-user denial.
7. Add privacy docs warning users not to paste PHI/secrets unless compliance posture is finalized.

#### C) Tests and Verification
- Integration: unauthenticated GET/POST returns 401 in hosted mode.
- Integration: user A cannot fetch/delete user B analysis.
- Pass/Fail: every analysis and calibration query includes user/workspace predicate.

#### D) Rollout and Migration
- DB migration required.
- Backfill existing local data to a default local user only for dev.
- Rollback: disable hosted mode and return to local-only branch.

#### E) Cleanup and Documentation
- Update `.env.example` with auth env vars only after provider selection.
- Update runbook with local vs hosted mode.

#### F) Success Metrics
- 0 unscoped analysis reads/writes in API routes.

### 3.13 Add Safer API Error Handling and Rate Limits

**ID:** `IT-08`
**Review Quote:** "API validation is too thin... safer error messages."
**Why it matters:** Current errors can expose upstream details or become noisy user-facing failures. OpenRouter calls also need cost/rate control.
**Priority:** P2
**Estimate:** 6h
**Owner Type:** Agent
**Risk if skipped:** Medium
**Dependencies:** `IT-06`
**Done When:** API routes return stable error codes/messages and custom query route has basic rate limiting.

#### A) Preconditions and Repo Context
- **Files to inspect:** `app/api/analyze/route.ts`, `app/page.tsx`

#### B) Implementation Plan
1. Normalize API error response shape:
   ```ts
   { error: { code: string, message: string } }
   ```
2. Avoid returning full OpenRouter error body to the browser in production.
3. Add basic in-memory dev rate limit for `/api/analyze`; use a production adapter before hosted mode.
4. Add frontend handling for structured errors.

#### C) Tests and Verification
- API tests assert status codes and error code strings.
- Manual: missing key shows user-safe setup message.

#### D) Rollout and Migration
- No DB migration.

#### E) Cleanup and Documentation
- Document error codes in handoff.

#### F) Success Metrics
- 0 raw upstream error bodies exposed in production mode.

### 3.14 Add E2E Workflow Suite

**ID:** `IT-10`
**Review Quote:** "Tests prove engine math, not user workflows or runtime APIs."
**Why it matters:** The core product is an interactive workflow. Build and unit tests do not prove users can run, save, load, and calibrate.
**Priority:** P1
**Estimate:** 18h
**Owner Type:** Agent
**Risk if skipped:** High
**Dependencies:** `IT-01`, `UX-01`, `UX-03`
**Done When:** Playwright covers PE demo, save/load, calibration, empty states, and env failure messaging.

#### A) Preconditions and Repo Context
- **Files to inspect:** `package.json`, `app/page.tsx`, `components/*`

#### B) Implementation Plan
1. Add Playwright as dev dependency.
2. Add `playwright.config.ts`.
3. Add `npm run test:e2e`.
4. Seed/reset SQLite before E2E.
5. Add tests:
   - first-run PE demo.
   - save analysis.
   - load analysis.
   - record calibration outcome.
   - custom query missing model.
   - API key missing path for custom AI.
6. Capture screenshots on failure only.

#### C) Tests and Verification
```bash
npm run test:e2e
```
- Pass/Fail: all critical workflows pass headless in CI.

#### D) Rollout and Migration
- No migration.

#### E) Cleanup and Documentation
- Add E2E command to handoff and CI.

#### F) Success Metrics
- 100 percent of P0/P1 UX workflows are covered by E2E.

### 3.15 Create a Master Verification Script

**ID:** `IT-09`
**Review Quote:** "tests pass is insufficient; prove a real task-completion path."
**Why it matters:** Agents need one command that verifies the app the way a user and operator care about it.
**Priority:** P1
**Estimate:** 6h
**Owner Type:** Agent
**Risk if skipped:** Medium
**Dependencies:** `IT-01`, `IT-03`, `IT-04`, `IT-10`
**Done When:** `scripts/verify-mitigations.sh` runs preflight, env check, Prisma, tests, build, API smoke, and E2E.

#### A) Preconditions and Repo Context
- **Files to inspect:** `package.json`, `scripts/`, `.env.example`

#### B) Implementation Plan
Create `scripts/verify-mitigations.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

cleanup() {
  if [[ -n "${DEV_SERVER_PID:-}" ]]; then
    kill "$DEV_SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "== Preflight =="
node --version
npm --version
test -f package.json
test -f .env.example

echo "== Install Check =="
npm ci

echo "== Environment Check =="
npm run check:env

echo "== Prisma =="
npx prisma generate
npx prisma db push

echo "== Unit and Integration Tests =="
npm test -- --runInBand

echo "== Build =="
npm run build

echo "== Runtime Smoke =="
npm run dev > /tmp/finess-dev.log 2>&1 &
DEV_SERVER_PID=$!
sleep 5
curl -f http://localhost:3000 >/dev/null
curl -f http://localhost:3000/api/analyses >/dev/null
curl -f http://localhost:3000/api/calibration >/dev/null

if npm run | grep -q "test:e2e"; then
  echo "== E2E =="
  npm run test:e2e
fi

echo "ALL MITIGATIONS VERIFIED"
```

#### C) Tests and Verification
```bash
chmod +x scripts/verify-mitigations.sh
./scripts/verify-mitigations.sh
```
- Pass/Fail: exits 0 and prints `ALL MITIGATIONS VERIFIED`.

#### D) Rollout and Migration
- No migration.

#### E) Cleanup and Documentation
- Add to `HANDOFF_LATEST.md` and CI.

#### F) Success Metrics
- 1 command verifies clone readiness and workflow health.

### 3.16 Clean Up Prototype Artifacts and Repo Root

**ID:** `IT-11`
**Review Quote:** "Untracked reference files... should be moved to docs/reference or gitignored."
**Why it matters:** Dirty roots confuse agents and increase accidental staging risk.
**Priority:** P2
**Estimate:** 3h
**Owner Type:** Agent
**Risk if skipped:** Low
**Dependencies:** none
**Done When:** repo root contains only active app files and intentional docs.

#### A) Preconditions and Repo Context
- **Files to inspect:** `distribclin_*.py`, `*.html`, `.gitignore`, `docs/`

#### B) Implementation Plan
1. Create `docs/reference/`.
2. Move pre-existing prototype HTML/Python files there if they are useful references.
3. Or add explicit ignore rules if they are local scratch only.
4. Do not delete files unless the user explicitly approves.
5. Stage only intended moves/ignore edits.

#### C) Tests and Verification
```bash
git status --short
npm test -- --runInBand
npm run build
```
- Pass/Fail: no unrelated untracked prototype files remain in root.

#### D) Rollout and Migration
- No app migration.

#### E) Cleanup and Documentation
- Update handoff project tree.

#### F) Success Metrics
- Clean root, scoped status output.

### 3.17 Add Export-Ready Analysis Object

**ID:** `UX-07`
**Review Quote:** "Users need to know: this query produced this graph, this result, this seed, this calibration status, and these next checks."
**Why it matters:** Domain experts need an artifact they can revisit, discuss, or attach to a decision record.
**Priority:** P2
**Estimate:** 18h
**Owner Type:** Mixed
**Risk if skipped:** Medium
**Dependencies:** `UX-02`, `IT-07` if public sharing is desired
**Done When:** users can export a saved analysis as JSON and a readable report without exposing other users' data.

#### A) Preconditions and Repo Context
- **Files to inspect:** `components/SaveLoadModal.tsx`, `app/api/analyses/[id]/route.ts`, `lib/types.ts`

#### B) Implementation Plan
1. Define `AnalysisExport` type.
2. Add local JSON export button for saved analyses.
3. Add plain-language report view:
   - query
   - model if available
   - seed
   - posterior mean/CI
   - sensitivity recommendation
   - graph assumptions
4. Do not add public share URLs until `IT-07` is complete.

#### C) Tests and Verification
- Unit: export serialization test.
- Manual: save PE analysis, export JSON, reload JSON in a validation test.

#### D) Rollout and Migration
- No DB migration unless storing model metadata.

#### E) Cleanup and Documentation
- Document export privacy limits.

#### F) Success Metrics
- Exported analysis can reproduce the same simulation with saved seed.

### 3.18 Add Observability and Audit Events

**ID:** `IT-12`
**Review Quote:** "No observability, error handling, or workflow audit surface beyond local UI state."
**Why it matters:** Operators and agents need to diagnose failures in AI generation, simulation, persistence, and calibration without reading browser state.
**Priority:** P2
**Estimate:** 12h
**Owner Type:** Agent
**Risk if skipped:** Medium
**Dependencies:** `IT-06`
**Done When:** key API and workflow events emit structured logs without secrets or sensitive payloads.

#### A) Preconditions and Repo Context
- **Files to inspect:** API routes, `lib/db.ts`, `lib/engine/use-simulation.ts`

#### B) Implementation Plan
1. Add `lib/server/log.ts` with structured JSON logging helper.
2. Log event names only, not full queries or graph payloads by default.
3. Events:
   - `analysis.create`
   - `analysis.load`
   - `analysis.delete`
   - `calibration.record`
   - `ai.analyze.start`
   - `ai.analyze.error`
4. Include request IDs for server routes.
5. Add tests or manual smoke to verify no API keys are logged.

#### C) Tests and Verification
- API tests assert no secret values appear in errors/log mocks.

#### D) Rollout and Migration
- No DB migration.

#### E) Cleanup and Documentation
- Add logging notes to runbook.

#### F) Success Metrics
- Every API route has structured success/error logging.

### 3.19 Add Simulation Performance Guardrails

**ID:** `PERF-01`
**Review Quote:** "The dashboard is dense and simulations are interactive; performance has no regression gate."
**Why it matters:** Web Worker simulation protects the UI, but rendering and sample size can still create browser slowdowns.
**Priority:** P2
**Estimate:** 8h
**Owner Type:** Agent
**Risk if skipped:** Low-Medium
**Dependencies:** `IT-10`
**Done When:** E2E or benchmark test asserts PE simulation completes within an agreed local threshold.

#### A) Preconditions and Repo Context
- **Files to inspect:** `lib/engine/use-simulation.ts`, `lib/engine/monte-carlo.ts`, canvas panels.

#### B) Implementation Plan
1. Add a deterministic benchmark for the PE graph in Node if feasible.
2. Add E2E timing for PE demo completion.
3. Gate only on broad thresholds to avoid flaky CI.
4. Consider adaptive sample counts for low-powered devices only after baseline measurement.

#### C) Tests and Verification
```bash
npm run test:perf
```
- Pass/Fail: PE demo completes under threshold on CI runner after warmup.

#### D) Rollout and Migration
- No migration.

#### E) Cleanup and Documentation
- Record baseline numbers in `HANDOFF_LATEST.md`.

#### F) Success Metrics
- p95 PE demo completion time remains below defined threshold.

### 3.20 Align Documentation and Handoff

**ID:** `DOC-01`
**Review Quote:** "Handoff claims and live state diverge when local runtime or Git state changes."
**Why it matters:** Future Codex runs rely on Markdown artifacts as project memory. Stale handoffs cause repeated investigation and wrong claims.
**Priority:** P2
**Estimate:** 4h
**Owner Type:** Agent
**Risk if skipped:** Medium
**Dependencies:** all completed tasks as applicable
**Done When:** `HANDOFF_LATEST.md` reflects actual verified state, commands, blockers, and next steps.

#### A) Preconditions and Repo Context
- **Files to inspect:** `HANDOFF_LATEST.md`, docs/plans, `.env.example`, `package.json`

#### B) Implementation Plan
1. After each mitigation task, update handoff deltas only.
2. Include:
   - branch/commit
   - uncommitted changes
   - tests/build result
   - runtime smoke result
   - remaining blockers
3. Do not claim pushed unless remote state is checked.

#### C) Tests and Verification
```bash
git status --short
git log -1 --oneline
git ls-remote origin main
```
- Pass/Fail: handoff matches actual git/test/runtime state.

#### D) Rollout and Migration
- No migration.

#### E) Cleanup and Documentation
- Keep older handoffs immutable; update `HANDOFF_LATEST.md`.

#### F) Success Metrics
- 0 stale completion claims in handoff.

## 4. Master Verification Suite

Codex should add and maintain `scripts/verify-mitigations.sh` as described in `IT-09`. Until that script exists, use this manual equivalent:

```bash
npm ci
npm run check:env
npx prisma generate
npx prisma db push
npm test -- --runInBand
npm run build
npm run dev
curl -f http://localhost:3000
curl -f http://localhost:3000/api/analyses
curl -f http://localhost:3000/api/calibration
```

If E2E tests exist:

```bash
npm run test:e2e
```

Final pass condition:

```text
ALL MITIGATIONS VERIFIED
```

## 5. GitOps Workflow

**Branch naming:** `codex/remediate-<task-id>-<short-slug>`
Example: `codex/remediate-it-01-env-precedence`

**Commit convention:**
- `fix(p0): repair runtime env handling`
- `feat(p1): add analysis lifecycle strip`
- `test(p1): cover analysis api routes`
- `ci(p1): add build and test workflow`
- `docs(p2): refresh handoff after mitigation`

**PR template:**

```markdown
## Task IDs
- IT-01
- UX-01

## Summary
Briefly describe what changed.

## Verification
Paste output from:

```bash
./scripts/verify-mitigations.sh
```

## Security and Privacy Notes
- Data touched:
- Secrets touched:
- Auth/tenant impact:

## Rollback
Exact rollback command or deployment rollback step.

## Open Assumptions
- [ASSUMPTION: ...]
```

**Agent execution protocol:**
1. Work one task ID per branch unless tasks are explicitly dependent and small.
2. Start with `git status --short`; do not stage unrelated files.
3. Read `HANDOFF_LATEST.md` and this plan before editing.
4. Make the smallest safe change that closes the task.
5. Add or update tests before claiming the task is done.
6. Run the task-specific verification and the master verification subset.
7. Update `HANDOFF_LATEST.md` only with verified facts.
8. Commit only intentional files.
9. Push and verify remote state before saying "pushed."
10. Stop and flag `[ASSUMPTION: ...]` only when continuing would risk destructive action, credentials, sensitive data, or material product-scope change.

## 6. Recommended Execution Order

1. `IT-01` Fix runtime environment precedence.
2. `IT-02` Commit and push existing Save/Load and Calibration UI.
3. `IT-05` Remove or implement `custom` edge method.
4. `UX-01` Build first-run guided path.
5. `UX-02` Add analysis lifecycle status strip.
6. `UX-03` Make Save and Calibration a guided workflow.
7. `IT-03` Add API integration tests.
8. `IT-04` Add CI pipeline.
9. `IT-09` Add master verification script.
10. `IT-10` Add E2E workflow suite.
11. `IT-06` Add runtime schema validation.
12. `IT-08` Add safer API errors and rate limits.
13. `UX-05` Redesign model selection.
14. `UX-06` Add responsive/accessibility pass.
15. `IT-11` Clean up prototype artifacts.
16. `DOC-01` Align handoff after each completed group.
17. `IT-07` Add auth and tenant isolation before hosted deployment.
18. `UX-07` Add export-ready analysis object.
19. `IT-12` Add observability and audit events.
20. `PERF-01` Add simulation performance guardrails.

## 7. Stop Rules for Codex

Stop and ask the user before:
- Deploying to any public host.
- Adding auth provider accounts, billing, or external services.
- Deleting prototype/reference files instead of moving or ignoring them.
- Changing the product from local-only to hosted multi-user mode.
- Handling real PHI, legal confidential data, financial secrets, credentials, or private keys.
- Rewriting major architecture outside the task ID scope.

Do not stop for:
- Missing minor UI copy.
- A stale model suggestion, if a safe custom-model path remains.
- Routine dependency installation for tests or CI.
- Local-only docs updates needed to keep handoff accurate.
