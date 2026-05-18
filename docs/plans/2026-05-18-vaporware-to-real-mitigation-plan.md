# Vaporware → Real App Mitigation & Improvement Roadmap

**Generated:** 2026-05-18
**Source critique:** prior conversation turn ("vaporware vs real" audit) and `/legacy:app__mitigen` invocation.
**Brief:** Convert finESS from "single-LLM hallucination dressed in correct statistics" into an app that does what it claims and can use multiple LLM models. Integrates the production ace_hospital ensemble (`/Volumes/WS4TB/WS4TBr/aXc11426/ace_hospital`) as the real ensembling substrate.

---

## 1. Executive Remediation Summary

**Risk posture shift:** "Plausible-looking single-LLM hallucination dressed in statistics" → "Multi-model evidenced ensemble with provenance, calibration-into-model feedback, and honest UI claims" over 4–6 focused work streams. The math engine and Path B already meet the bar; the failure surface is Path A's silent hallucination, the missing ensemble, the open calibration loop, and UI/documentation that overpromises.

**Risk delta summary:**
- **Hallucinated authority eliminated:** every node carries provenance; UI shows it; outputs cannot be reified as "the answer" without source labels.
- **Single-point-of-failure LLM removed:** N-model proposal lane (Path A) and N-forecaster ensemble lane (Path B+Forecast) replace single-model outputs.
- **Calibration loop closed:** outcomes feed Beta priors into next prediction (ace_hospital pattern), not just a journal row.
- **Schema-only validation upgraded to semantic validation:** mean ∈ range, DAG reachability to `outputNodeId`, bayesian_update edge-count rules.
- **Overclaim risk reduced:** UI strings, README, and HANDOFF align with what the engine actually does.

**Effort:** ~25–35 person-days for a single senior eng + an agent pair (per-task estimates below; no time/cost projections in commits or PRs per project rule).

**Quick-win ROI (<4 hours each):**
1. **Hard-wire semantic validation in `parse-response.ts`** (mean ∈ range, output reachability) — eliminates an entire class of garbage Path A outputs today. **Unlocks: every downstream task.**
2. **Add a `source` field to every node** (`literature` | `llm_prior` | `user_override`) — required by every UI honesty fix. **Unlocks: 3.5, 3.7, 3.10.**
3. **UI banner: "Path A is a *draft model*, not a verified analysis. Edit the nodes before trusting the output."** Single component, instant overclaim mitigation while the deeper work lands.
4. **Strip the PE example from the Path A prompt or make it configurable** — biases every output toward medical-test-like structures regardless of question.
5. **Move `lib/engine/` and `app/api/analyze/` behind a `LEGACY_PATH_A_ENABLED` flag default-off** for hosted/demo deploys; default-on for local dev. Prevents shipping vaporware while real ensemble lands.
6. **Add `OPENROUTER_MODELS` validation at boot** — refuse to start if any listed model fails a 1-token ping. Catches typo'd/discontinued models before users do.
7. **Drop the leaked `OPENROUTER_API_KEY` from history rotation checklist into RELEASE_CHECKLIST.md.** No code change; closes a real exposure.

**Systemic themes:**
- **Hallucinated authority:** Path A engine math is correct but operates on LLM-invented inputs with no provenance, no semantic validation, no source labels.
- **Open calibration loop:** outcomes recorded in SQLite go nowhere — no learner, no prior update, no model improvement.
- **Single-model bottleneck:** no ensembling at the LLM layer (Path A) or forecaster layer (Path B), so between-model uncertainty (the biggest source) is invisible.
- **UI/copy overclaim:** product surface implies "AI analyzed your problem"; reality is "AI drafted a JSON skeleton" or "AI narrated your stats."
- **No semantic validation:** `parse-response.ts` checks types and enum values only; mean can exceed range, DAGs can be unreachable, bayesian_update edges can be malformed.
- **Sidecar boundary unowned:** ace_hospital ensemble is Python; finESS is TS. Nothing today defines this contract.

---

## 2. Prioritization Matrix (Impact × Effort)

| Effort \ Impact | **High (P0/P1)** | **Medium (P2)** | **Low (P2)** |
|---|---|---|---|
| **Easy (≤4h)** | **S5-01** Rotate leaked API key · **M8-01** Semantic validation in `parse-response.ts` · **M8-02** Add `source` field on Node · **R6-01** UI honesty banner on Path A | **M8-03** Boot-time model preflight · **M8-04** Remove/configure PE few-shot example | **M8-05** README/HANDOFF align with actual capabilities |
| **Medium (4–16h)** | **S5-02** Path A legacy flag · **R6-02** Multi-LLM proposal lane scaffold · **P7-01** Per-model timeout/retry/cost ceiling | **R6-03** Semantic DAG reachability + bayesian_update edge rules · **M8-06** Test coverage for new validators | **M8-07** Provenance colour-coding in `NodeEditor.tsx` |
| **Hard (≥16h)** | **R6-04** Python sidecar service for ace_hospital ensemble · **R6-05** Path B Forecast Mode wired to ace ensemble · **R6-06** Calibration→Beta-prior feedback loop · **R6-07** N-graph LLM ensemble + node alignment for Path A | **P7-02** Parallel LLM calls with concurrency ceiling · **M8-08** Provenance end-to-end across save/load/calibration | — |

---

## 3. Atomic Mitigation Tasks (full backlog)

> The full per-task plan with file paths, exact diffs, test commands, rollout, and success metrics is preserved in the conversation that generated this document. Each task carries an ID; agents working a task should reference the ID in the branch name (`remediate/<id>-<slug>`) and in commit messages (`fix(p0): <id> <summary>`).

### Task index

| ID | Title | Priority | Effort | Dependencies |
|---|---|---|---|---|
| S5-01 | Rotate leaked OpenRouter API key + rotation runbook | P0 | 1h | — |
| M8-01 | Semantic validation in `parse-response.ts` | P0 | 4h | — |
| M8-02 | Add `source` provenance field on every node | P0 | 3h | — |
| R6-01 | UI honesty banner on Path A | P0 | 2h | — |
| S5-02 | Path A behind `LEGACY_PATH_A_ENABLED` flag | P0 | 5h | M8-01, R6-01 |
| M8-03 | Boot-time OpenRouter model preflight | P1 | 2h | — |
| M8-04 | Strip / parameterize PE few-shot in Path A prompt | P2 | 3h | M8-01, M8-02 |
| M8-05 | README/HANDOFF align with actual capabilities | P2 | 2h | R6-01, M8-02 |
| P7-01 | Per-model timeout, retry, cost ceiling | P1 | 6h | — |
| R6-02 | Multi-LLM proposal lane scaffold (Path A → N graphs) | P1 | 10h | M8-01, M8-02, P7-01 |
| R6-03 | Semantic DAG reachability runtime guards | P2 | 4h | M8-01 |
| M8-06 | Test coverage uplift for new validators and provenance | P2 | 5h | M8-01, M8-02, R6-03 |
| M8-07 | Provenance colour-coding in `NodeEditor.tsx` | P2 | 3h | M8-02 |
| R6-04 | Python sidecar service for ace_hospital ensemble | P1 | 16h | — |
| R6-05 | Path B Forecast Mode wired to ace ensemble | P1 | 14h | R6-04 |
| R6-06 | Calibration → Beta-prior feedback loop | P1 | 14h | R6-04, R6-05 |
| R6-07 | N-graph LLM ensemble + node alignment (Path A) | P1 | 20h | R6-02, R6-06 |
| P7-02 | Parallel LLM calls with concurrency ceiling | P2 | 3h | R6-02, P7-01 |
| M8-08 | Provenance end-to-end across save/load/calibration | P2 | 4h | M8-02 |

See conversation transcript dated 2026-05-18 for the full per-task implementation plan (file paths, diffs, test commands, rollout, success metrics).

---

## 4. Master Verification Suite

A single adaptive shell script, `verify-mitigations.sh`, runs at the end of each task PR. Steps it performs (skip gracefully if the relevant artifact does not yet exist):

1. Preflight (Node, npm, repo root check)
2. `npm run check:env`
3. `node scripts/preflight-models.mjs` (when M8-03 lands)
4. `npx tsc --noEmit`
5. `npm test -- --runInBand`
6. Coverage gate (when M8-06 lands)
7. `npm run test:e2e`
8. `npm run build`
9. `OPENROUTER_API_KEY="" npm run smoke:openrouter` (blocked-mode)
10. `OPENROUTER_LIVE_SMOKE=1 npm run smoke:openrouter` (live, when key present)
11. Ensemble service `/health` (when R6-04 lands and docker available)
12. Secret hygiene: grep for `sk-or-v1-` in tracked files; fail on match
13. Path A flag gating check (warn if S5-02 not yet landed)
14. `git diff --check`
15. Print `✅ ALL MITIGATIONS VERIFIED`

The script is committed alongside the first task that needs it.

---

## 5. GitOps Workflow

- **Branch naming:** `remediate/<task-id>-<slug>`
- **Commit convention:** `fix(p0): <task-id> <summary>`, `feat(p1): <task-id> <summary>`, `refactor(p2): <task-id> <summary>`
- **One task per branch.** A PR closes exactly one task ID unless dependencies must land together.
- **Honor CLAUDE.md:** no mock data without explicit approval; no time/cost estimates in PRs/commits; model versions are user-selected.
- **Run `bash verify-mitigations.sh` before opening a PR.** Paste the last 30 lines into the PR body.

[SAFE ASSUMPTION] ace_hospital at `/Volumes/WS4TB/WS4TBr/aXc11426/ace_hospital` is installable as a local Python package; licence permits internal use. If not, switch R6-04 to "copy the relevant modules with attribution" and re-estimate.

[SAFE ASSUMPTION] Hosted deployment remains out of scope (HANDOFF_LATEST.md line 70). Flag defaults assume local-dev posture.
