# Semantic Mode Realignment — Implementation Plan

**Generated:** 2026-05-19
**Companion to:** `2026-05-19-semantic-mode-realignment.md` (gap analysis)
**Phase order (user-confirmed):** C → A → B → D, with existing modes plugged INTO the semantic pipeline as research mechanisms.
**Reference baselines:** `lib/engine/distributions.ts`, `lib/engine/dag-executor.ts`, `lib/engine/monte-carlo.ts`, `lib/types.ts`, `hometier-app2.html` lines 2180-2410, `distribclin_app.py` Principles 4 & 5.

This plan has commit-sized work units. No agents spin up until the user signs off on the sequence.

---

## Operating principles for this plan

1. **No mock data, no simulated responses.** Every new mechanism that consumes data hits a real source (real LLM, real search provider, real RAG corpus, real CSV).
2. **Every step has a verification gate.** Build + tests + (where applicable) live integration check before the next step.
3. **No breaking changes to existing modes.** Real Data Mode, Forecast Mode, Multi-Proposer, Path A simulation stay working at every checkpoint.
4. **Provenance is non-negotiable.** Any new value that lands on a node must carry its source — even partial mechanisms must label their contributions.
5. **The user must always see what the system did and why.** Every research result is inspectable; every clarifying answer is editable.
6. **Validate after every commit:** `npm run build`, `npm test`, and the relevant live integration test (if any) must all pass before moving on.

---

## Phase C — Engine extensions (foundation first)

Goal: extend the engine so the semantic pipeline has full distribution + simulation expressiveness to write into. Land before the semantic UI so the UI never has to apologize for a missing capability.

### C1. Triangular distribution
**Commit boundary:** one commit.
**Files:** `lib/engine/distributions.ts`, `lib/types.ts`, `__tests__/engine/distributions.test.ts` (new if missing).
**Spec:**
- Extend `DistributionType` union with `"triangular"`.
- Extend `UncertaintyNode` with optional `mode?: number`, `min?: number`, `max?: number` — used only when `distribution === "triangular"`. Document in JSDoc that for triangular, `range` is ignored; `min`/`mode`/`max` are the source of truth.
- Add `sampleTriangular(rand, min, mode, max)` using inverse-CDF transform (canonical implementation; reference `hometier-app2.html:2491` for the formula).
- Update `sampleDistribution` switch to handle `"triangular"` — must read from `node.min/mode/max`, not from `mean/sd`. Throw a clear error if those are missing.
- Update `lib/ai/parse-response.ts` and `lib/validation/schemas.ts` to validate that triangular nodes carry `min ≤ mode ≤ max` and reject otherwise.
- 8+ tests: happy path, mode at min, mode at max, mode below min (rejected), mean over many samples ≈ (min+mode+max)/3.

**Verification:** `npm test`, `npm run build`. No live call needed.

### C2. Bernoulli mixture (probabilistic event gating)
**Commit boundary:** one commit.
**Files:** `lib/types.ts` (new `MixtureGate` interface), `lib/engine/distributions.ts` or new `lib/engine/mixtures.ts`, `lib/engine/dag-executor.ts`, `lib/ai/parse-response.ts`, `lib/validation/schemas.ts`, tests.
**Spec:**
- Add optional field to `UncertaintyNode`: `gate?: { probability: number }`. When present, on each Monte Carlo iteration: with probability `p` the node fires and is sampled normally; with probability `1-p` the node returns `0` (or a configurable inactive value).
- This composes with any distribution (so a "major home repair surprise" node is Lognormal(14500, 9800) firing with probability 0.12).
- Engine integration: the gating happens in `sampleLeafNodes` so all downstream edge composition sees the gated value.
- Validation rejects `gate.probability` outside [0, 1].
- 6+ tests: probability 1 → always fires, probability 0 → never fires, observed fire rate over 10k samples ≈ p, gate composes with each distribution type.

**Verification:** `npm test`. Update `hometier`-style fixture to use a gated node and assert downstream behavior.

### C3. Path-dependent multi-year simulation
**Commit boundary:** two commits — (C3a) state-carryover sampler core, (C3b) UI/types for declaring a longitudinal model.
**Files:** `lib/engine/longitudinal.ts` (new), `lib/types.ts`, `lib/engine/monte-carlo.ts`, tests.
**Spec:**
- New simulation mode "longitudinal" alongside existing single-shot. Driven by a per-step recurrence — each year, sample nodes, apply user-defined state transition, accumulate / propagate. Reference: hometier's 30-year drawdown loop at `hometier-app2.html:2400-2480`.
- New `LongitudinalGraph` type extending `UncertaintyGraph` with `horizonSteps: number` and `stateTransition: { initialState: Record<string, number>, recurrence: TransitionRecurrence }`.
- `TransitionRecurrence` is a typed AST (NOT eval'd strings) describing how state variables update each step from sampled node values and prior state. Start with a small expression language: addition, multiplication, conditional, accumulator. Document the grammar; reject anything else.
- Sampler runs `numSamples × horizonSteps` total node samples; output is the final state at horizon plus optional intermediate-step traces.
- Result type extends `SimulationResult` with `pathTraces?: Array<{stateVar, perStepMean, perStepCi}>`.
- 10+ tests covering: 1-step (must equal single-shot), N-step deterministic (no sampling) round trip, depletion semantics (e.g. portfolio dropping below 0 — define behavior), invalid recurrence rejected at validation time.

**Verification:** `npm test`. Construct a 5-step hometier-style fixture and verify the expected end-state distribution shape.

### C4. Node `impact` metadata
**Commit boundary:** one commit.
**Files:** `lib/types.ts`, `lib/ai/parse-response.ts`, `lib/validation/schemas.ts`, `components/NodeEditor.tsx`, `lib/ui/source-style.ts` (extend to also style by impact), tests.
**Spec:**
- Add optional `impact?: "low" | "medium" | "high" | "critical"` to `UncertaintyNode`.
- Validators preserve through save/load (M8-08 pattern).
- NodeEditor shows impact as a second pill next to source pill.
- The sensitivity analysis (`lib/engine/sensitivity.ts`) optionally cross-references impact: if the user labels a node "critical" but sensitivity ranks it low, surface that discrepancy as a callout — "you flagged this as critical but it only drives N% of output variance."
- 4+ tests covering save/load round trip and the discrepancy callout logic.

### C5. Reliability diagram + Brier score
**Commit boundary:** two commits — (C5a) computation, (C5b) UI.
**Files:** `lib/calibration/reliability.ts` (new), `lib/calibration/brier.ts` (new), `components/ReliabilityDiagram.tsx` (new), wire into `CalibrationModal.tsx`, tests.
**Spec:**
- `computeReliability(outcomes: CalibrationOutcome[], binCount=10)` returns `{bins: [{lowerBin, upperBin, count, predictedMean, observedFrequency}], totalCount, isReliable}`. Empty bins are NOT silently filled — they are returned as `count: 0` so the UI can render them transparently per Principle 6 ("a wide interval is useful honesty" → honest absence of data).
- `computeBrierScore(outcomes)` returns the standard formula `mean((predicted - actual)^2)`. Document that lower is better; perfect = 0.
- `ReliabilityDiagram` renders the diagonal "perfect calibration" line + the observed dots. Reference: `distribclin_app.py:288-331` Plotly version. Re-implement in pure React/SVG (no Plotly dep).
- Calibration modal shows Brier score next to the count of recorded outcomes; opens a separate panel with the reliability diagram.
- 8+ tests covering known calibration scenarios (perfectly calibrated synthetic outcomes → Brier = expected, over-confident outcomes → diagram tilts above diagonal).

**Verification:** `npm test`. Seed test database with synthetic outcomes; render diagram via component test.

### Phase C exit criteria
- All five sub-phases committed and on `main`.
- Tests counts increased proportionally (~40+ new tests across C).
- `npm run test:coverage` per-file gates updated for `distributions.ts`, `longitudinal.ts`, `reliability.ts`, `brier.ts`.
- README updated with the new distribution types and simulation modes.
- No existing mode regression.

---

## Phase A — Semantic conversation surface

Goal: deliver the multi-turn UI that decomposes a question into components, with the user in the loop at every gate. Built on top of the Phase C engine so it can produce any distribution / mixture / longitudinal model the user needs.

### A1. Conversation state machine
**Commit boundary:** one commit.
**Files:** `lib/semantic/state-machine.ts` (new), `lib/semantic/types.ts` (new), tests.
**Spec:**
- Define states: `IDLE | CLARIFYING | AWAITING_ANSWERS | PROPOSING_COMPONENTS | REVIEWING_COMPONENTS | RESEARCHING | REVIEWING_RESEARCH | MODELING | COMPLETE | ERROR`.
- Define events: `start(query) | answerClarification(qId, answer) | acceptComponents() | editComponent(...) | startResearch(componentId, mechanism) | acceptResearch(componentId) | runModel() | reset() | back()`.
- Each state knows its valid transitions; invalid event → typed error.
- The machine is pure — no I/O. State + reducer.
- 15+ tests covering all transitions and rejection of invalid events.

### A2. Conversation persistence
**Commit boundary:** one commit.
**Files:** Prisma migration adds `SemanticConversation` table (`id`, `userId`, `workspaceId`, `query`, `state`, `stateJson`, `createdAt`, `updatedAt`). New `lib/semantic/persistence.ts`. New `/api/semantic` routes (GET/POST/PATCH). Tests.
**Spec:**
- Save/load every state transition so the user can resume a session.
- M8-08 pattern: validators carry all fields through round trip; provenance preserved.
- One conversation per row, full state machine snapshot in `stateJson`.
- 8+ tests covering save/load round trip, ownership guards, validation rejection.

### A3. Clarifying-questions step
**Commit boundary:** one commit.
**Files:** `lib/semantic/clarify.ts` (new), `lib/ai/prompt.ts` (new clarifier prompt section), tests.
**Spec:**
- `requestClarifications(query, llm)` returns `Array<{id, question, defaultAnswer?, why?}>`. The LLM is prompted to ask 2-5 questions, each tagged with WHY it matters and an optional default the user can accept.
- The LLM call goes through `lib/ai/openrouter-client.ts` (P7-01 budget/timeout enforced).
- Validation rejects malformed responses (use the M8-01 pattern).
- Tests using labeled fetch fakes for shape; integration test (gated) against real OpenRouter.

### A4. Component-identification step
**Commit boundary:** one commit.
**Files:** `lib/semantic/propose-components.ts` (new), prompt updates, tests.
**Spec:**
- Given the query + clarifying Q&A, ask the LLM to propose a list of components (NOT a full graph). Each component: `{id, name, description, suggestedDistribution, why, dependsOn?: string[]}`. No mean/SD yet — that comes from research.
- Validation: every dependsOn must reference another component id; suggestedDistribution must be one of the engine's supported types (including triangular and mixture-gated).
- 8+ tests.

### A5. Per-component review UI
**Commit boundary:** two commits — (A5a) panel skeleton + state wiring, (A5b) interaction polish.
**Files:** `components/SemanticPanel.tsx` (new, mounted as 5th mode tab in `app/page.tsx`), `components/semantic/*.tsx` sub-components (ClarificationStep, ComponentReviewStep, ResearchStep, ModelStep), tests.
**Spec:**
- Chat-style scrolling history of: user query → clarifying Q&A pairs → component list → per-component research bundles → final model.
- Each phase blocks until user explicitly advances (no auto-continue).
- "Back" button at every step.
- Honesty banner at the top: same pattern as Path A's amber banner, text per the realignment doc.
- Component test verifies render + step transitions.

### Phase A exit criteria
- Semantic tab appears in mode toggle.
- A user can start a query, answer clarifications, accept a component list, skip research (use LLM-prior defaults only), run model, see result.
- Conversation saves and resumes.
- ~30+ new tests.

---

## Phase B — Research mechanisms (plug in existing modes per user choice)

Goal: each component can be researched via any of four mechanisms. The user picks per component (or accepts a default).

### B1. LLM-prior research with explicit reasoning
**Commit boundary:** one commit.
**Files:** `lib/semantic/research/llm-prior.ts` (new), prompt updates, tests.
**Spec:**
- Per component, call the LLM with explicit instructions: "propose distribution + mean + sd (or min/mode/max for triangular). Explain in 2-3 sentences WHY this distribution, WHY this central value, WHY this spread. Cite any general knowledge sources (textbooks, well-known datasets) by name if applicable."
- Response is validated and stored as `ResearchBundle{mechanism: "llm_prior", proposedDistribution, proposedParams, reasoning, citations: []}`.
- Tests with labeled fakes + gated live test.

### B2. Web search research
**Commit boundary:** two commits — (B2a) provider abstraction + Tavily integration (recommended; cheap, predictable, good for citations), (B2b) wire into semantic flow.
**Files:** `lib/search/provider.ts` (new abstraction), `lib/search/tavily.ts` (new implementation), `lib/semantic/research/web.ts` (new), `.env.example` (`TAVILY_API_KEY`), tests, gated integration test.
**Spec:**
- Abstraction so we can swap providers later (Brave, Bing).
- Per-component query: combine component name + description into a search query, request 3-5 snippets, ask LLM to extract distribution params from the snippets WITH explicit citations (URL + snippet).
- Cost ceiling per component using the same pattern as P7-01.
- `ResearchBundle{mechanism: "web_search", proposedDistribution, proposedParams, reasoning, citations: [{url, snippet, title}]}`.
- If web is unreachable, route returns a structured error (no fallback to fake data).

### B3. RAG over user-uploaded documents
**Commit boundary:** two commits — (B3a) upload + chunking + embedding into local vector store, (B3b) per-component retrieval and synthesis.
**Files:** `lib/rag/store.ts` (LanceDB or `@lancedb/lancedb` per workspace CLAUDE.md vector-store preference), `lib/rag/embed.ts`, `lib/rag/chunker.ts`, `app/api/semantic/documents/route.ts` (upload), `lib/semantic/research/rag.ts`, prisma migration for `SemanticDocument` table, UI for document management, tests.
**Spec:**
- User uploads PDF / Markdown / CSV / text. Documents are chunked, embedded with `BAAI/bge-small-en-v1.5` (per workspace CLAUDE.md), stored locally per workspace.
- Per component: query the workspace's documents for top-K passages, ask LLM to extract distribution params with citations to source-document + chunk-id (NOT a URL — these are local).
- Documents are gitignored and never leave the machine.
- `ResearchBundle{mechanism: "rag_document", proposedDistribution, proposedParams, reasoning, citations: [{documentId, chunkText, page?}]}`.

### B4. Multi-LLM consensus per component
**Commit boundary:** one commit.
**Files:** `lib/semantic/research/consensus.ts` (new, reuses `lib/ai/multi-proposer.ts` patterns), tests.
**Spec:**
- Per component, fan out to all configured LLMs in parallel (concurrency-bounded via R6-02's existing pool).
- Each LLM returns its proposed distribution + params + reasoning.
- Consensus output: report all N independent proposals AND a synthesized "consensus distribution" computed by widening to envelope (min of mins, max of maxes, mean of means, max of SDs). The synthesized version is itself labeled as `mechanism: "multi_llm_consensus"`.
- Disagreement metric: report the spread between proposals so the user can see it.
- `ResearchBundle{mechanism: "multi_llm_consensus", proposedDistribution, proposedParams, reasoning, perModelProposals: [...], disagreementScore: number}`.

### B5. Wire existing modes as research mechanisms
**Commit boundary:** two commits — (B5a) Forecast Mode as time-series node-fill, (B5b) Real Data Mode as empirical-observation node-fill.
**Files:** `lib/semantic/research/forecast.ts`, `lib/semantic/research/empirical.ts`, UI hooks in the component-review step, tests.
**Spec:**
- B5a: when a component represents a future numeric quantity over time, user can launch Forecast Mode for it. The forecast result (point + CI + per-model weights) translates into a Normal distribution centered on the forecast with SD = `(ci_high - ci_low) / 3.92` (95% to SD). `ResearchBundle{mechanism: "ensemble_forecast", ...}` carries the per-model weight breakdown as citations.
- B5b: when a component represents a measured quantity from a CSV, user can launch Real Data Mode for it. The empirical observed result fills the component's distribution params. `ResearchBundle{mechanism: "empirical_observation", ...}`.
- Existing Forecast and Real Data Mode tabs continue to work standalone.

### B6. Research-mechanism picker UI
**Commit boundary:** one commit.
**Files:** UI updates to `components/semantic/ResearchStep.tsx`, tests.
**Spec:**
- For each component, the user picks a research mechanism (default: LLM-prior). Optional "run multiple mechanisms" toggle to surface disagreement across mechanisms.
- The chosen mechanism's `ResearchBundle` is shown with all reasoning + citations visible by default (not hidden behind a click).
- User can accept, edit (flip to `user_override`), or rerun with a different mechanism.

### Phase B exit criteria
- Semantic mode can run any component through any of 6 research mechanisms.
- Forecast Mode and Real Data Mode are now both standalone AND wired in as research sources — no duplication of UI code.
- Live integration tests pass for each mechanism (Tavily, real OpenRouter consensus, real sidecar forecast, real CSV empirical).
- ~50+ new tests across B (unit + integration).

---

## Phase D — Provenance hardening

Goal: every value the model touches carries a complete audit trail. The user can defend any output by clicking through to its source.

### D1. Richer NodeSource model
**Commit boundary:** one commit.
**Files:** `lib/types.ts`, `lib/ai/parse-response.ts`, `lib/validation/schemas.ts`, `lib/ui/source-style.ts`, all UI consumers, tests.
**Spec:**
- Replace `NodeSource` string union with `interface NodeProvenance { primary: ProvenanceMechanism; citations: Citation[]; confidence?: number; researchedAt?: string; researchedByModel?: string }`.
- `ProvenanceMechanism` enum: `literature | llm_prior | web_search | rag_document | multi_llm_consensus | ensemble_forecast | empirical_observation | user_override`.
- Backward-compat: legacy `source: string` field on persisted graphs is migrated on load — `"literature"` → `{primary: "literature", citations: []}`, etc. No data loss.
- All UI consumers (`NodeEditor`, `MultiProposalsPanel`, `SemanticPanel`) updated to render the richer provenance.

### D2. Audit-event types for each research step
**Commit boundary:** one commit.
**Files:** `lib/audit/events.ts`, all research mechanism modules, tests.
**Spec:**
- New event types: `semantic_session_started`, `semantic_clarify_requested`, `semantic_components_proposed`, `semantic_research_invoked` (with `mechanism`), `semantic_model_run`, `semantic_session_resumed`.
- Metadata captures the mechanism + cost + latency + outcome. No PII, no document chunk content (just chunk IDs).

### D3. Full conversation export
**Commit boundary:** one commit.
**Files:** `lib/semantic/export.ts` (new), `app/api/semantic/[id]/export/route.ts`, UI button in SemanticPanel.
**Spec:**
- One-button export of a full conversation: query → clarifying Q&A → components → per-component research bundles (with citations expanded inline) → final model + result.
- Output as Markdown (text) and optionally as a JSON bundle for re-import.
- The Markdown is the "defensibility document" — a stakeholder can read it and understand every number.

### Phase D exit criteria
- Every node in every saved graph carries full provenance.
- Every research step is in the audit log.
- A user can export any conversation as a self-contained Markdown report.

---

## Cross-cutting commitments throughout all phases

- **No `--no-verify` git commits, ever** — pre-commit hooks must pass.
- **No mock product data** — any test that needs LLM responses uses the gated live integration pattern from R6-02/R6-06.
- **Per-call cost ceilings** stay enforced via `lib/ai/openrouter-client.ts`. Semantic mode's per-question multi-mechanism flow can easily blow past current $0.05 default — Phase A1 should introduce a per-session cumulative budget UI so the user is never surprised.
- **No model versions hardcoded** — all LLM calls go through configured models per CLAUDE.md.
- **Every commit:** `npm run build`, `npm test`, `git diff --check`, then push (if the user has approved push for that batch).
- **Local-only / single-user posture preserved** (per `IMPLEMENTATION_PACKET.md`, `2026-05-16-true-preprod-goal.md`, UX/IT IT-07). Every new Prisma table the semantic flow introduces carries `userId` / `workspaceId`. Every new API route enforces the same ownership-guard pattern used in `app/api/analyses/[id]/route.ts`. No hosted multi-tenant assumptions.
- **Audit events: no PII, no raw CSV rows, no LLM response bodies, no API keys, no user query free-text.** Reuse `lib/audit/events.ts` and (where applicable) `lib/server/log.ts`. Every new audit-event type added in D2 ships with a test that asserts secret-free metadata, per the established preprod constraint.
- **Method / distribution / mechanism allowlist stays clean.** UX/IT IT-05 removed `"custom"` from `CombinationMethod` and CI grep-gates it (`git grep -n '"custom"' -- lib app components __tests__`). C1, C2, C3 introduce new distribution / simulation types through the same allowlist pattern — validator rejects unrecognized strings; CI grep gate stays green.
- **Honest-uncertainty language commitment (Principle 6).** All semantic-mode narration, banners, and inline copy must articulate disagreement and wide-CI as useful honesty, never flatten ranges to a single point estimate in the UI. The C5 reliability diagram must render an explicit empty state ("not enough recorded outcomes; calibration requires ≥20 — current: N") rather than a misleading sparse diagram below the threshold.
- **Target user is non-statistical** (design doc line 25, success criteria line 177). Every numeric / statistical control surfaced by the semantic UI must carry a plain-language label + a "what does this mean?" tooltip. Distribution params (alpha/beta/SD/mode) live behind a Details disclosure; the primary chat surface reads in domain language.

---

## v2 Addendum — items recovered from older docs audit (2026-05-19)

A doc audit across `docs/plans/2026-05-12-*` through `docs/plans/2026-05-16-*` and `HANDOFF_2026-05-13.md` surfaced 20 items the v1 plan above did not address. Items 13, 14, 20 were already covered. Items 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 16, 17, 18, 19 are folded into the plan as follows. None of these reorder phases; they tighten existing sub-phase specs.

### Critical adds (must land for the plan to be coherent)

**Add to A1 (state machine):** Insert a `SETTING_THRESHOLD` state between `REVIEWING_COMPONENTS` and `RESEARCHING`. The user picks the output-node decision threshold and a `thresholdLabel` ("high risk", "go / no-go", domain-specific). The final result reports `p_above_threshold`. Without this, the semantic flow produces a distribution but no decision-actionable answer. Reference: v1 plan lines 144-145, 405-407; design doc Principle 6; existing `UncertaintyGraph.threshold` field.

**Add as a new top-level Cross-cutting bullet (already merged above):** Local-only / single-user posture preservation + ownership guards on `SemanticConversation` + audit-event PII rules. This must be restated explicitly in A2's Prisma migration spec and in D2's audit-event spec.

### Important adds (each closes a real gap)

**Add to A5 (semantic panel) — cockpit handoff:** When `runModel()` completes (`COMPLETE` state), Semantic Mode hands off to the existing 6-panel Dashboard (`NodeNetwork`, `LiveDistribution`, `SensitivityRadar`, `GaugePanel`, `SpectrumBars`, `NarrationStream`) rendered in place. The semantic chat history collapses to a left-rail summary. The user gets the existing "watch the brain think" animations from the original design doc lines 39-93. Mode tab labelling makes this clear ("Semantic ▸ Result").

**Add to A1 / A5 — sensitivity-driven "verify next" loop:** After `runModel()`, the top sensitivity result is offered back into the conversation as: "<component X> is driving <N>% of your output uncertainty. Want me to run another research pass on it, or accept the current uncertainty?" New A-phase state `REVIEWING_RESULT` lets the user accept-or-loop. Closes the loop between Phase B research and Phase A conversation per design doc Principle 5 + line 85.

**Add to A3 and A4 — mandatory worked example in prompts:** Every clarifying-question prompt and every component-proposal prompt MUST embed at least one rich worked example (PE 6-node clinical + hometier 10-node retirement). v2 plan change-row 6 documented empirically that removing the few-shot regressed AI output to flat 3-node graphs. New regression test: canonical PE query produces 5-8 components; canonical hometier-style query produces 8-12 components.

**Add to D3 (export):** Export produces TWO artifacts, not one: (a) human-readable Markdown defensibility doc (already in plan), (b) machine-readable JSON conforming to the existing `AnalysisExport` shape extended with the full semantic conversation, the threshold, the seed, and per-component research bundles. Reproducibility test: re-importing the JSON with the same seed produces an identical model run. Reference: UX/IT UX-07.

**Add to C3 (longitudinal) + A2 (persistence):** Seed propagation. C3's longitudinal sampler accepts a seed and produces identical traces for identical seed + recurrence + node samples. A2's persisted `SemanticConversation` state stores the seed used for the last model run so D3 exports are reproducible. Reference: v2 plan change-row 5; preprod proof item referencing seed=42.

**Add a new B7 — "Expert Panel" research mechanism:** User types 2-N point estimates per component; the system computes the distribution from disagreement (mean → distribution centre, spread → variance). Operationalizes Principle 2 properly. `ResearchBundle{mechanism: "expert_panel", proposedDistribution, proposedParams, reasoning, expertEstimates: [number, ...]}`. ProvenanceMechanism gains `"expert_panel"` in D1. Reference: v2 plan line 137.

**Add to A1 — plain-language narration events:** Every state transition emits a narration event to the existing `NarrationStream` component so the user sees "Identifying key factors...", "Asked 3 clarifying questions...", "Running research on D-dimer specificity...", "Found N=2000 study citing 35-42% range...", "Re-running propagation..." in real time. The narration channel was a load-bearing UX element in the original design doc lines 79-86; the v1 plan only had Markdown export.

**Add to A5 (per-component review UI) — non-statistical UX:** No bare `mean`, `sd`, `alpha`, `beta`, `mode` in the primary chat surface. Plain-language wrappers: "central estimate", "spread / uncertainty", "most-likely value". Stats vocabulary appears only behind a "Show distribution details" disclosure. Tooltips on every numeric control. Reference: design doc target-user line 25.

**Add to D2 — reuse existing log infrastructure + secret-free assertion:** New `semantic_*` audit-event types reuse `lib/audit/events.ts` (and `lib/server/log.ts` for structured logs). Every new event type ships with a unit test asserting that emitted metadata contains no LLM response body, no API key, no user query free-text, no RAG chunk content (chunk IDs only), no PII. Reference: UX/IT IT-12.

**Add to C3 — performance budget:** Longitudinal simulation cost scales as `numSamples × horizonSteps`. At 15,000 samples × 30 steps = 450k node samples per node — easily 30x current cost. C3 spec adds a benchmark test: the canonical hometier-style 10-node × 30-step model must complete in under a documented budget on the reference machine; CI gates regressions. Reference: UX/IT PERF-01.

**Add to A5 (per-component review UI) — live drag-to-edit re-propagation:** After research lands a `ResearchBundle` on a component, the user can drag the component's distribution (widen/narrow, shift centre) in the UI and watch the cockpit re-propagate in real time without re-running the full pipeline. The existing engine supports this via the Web Worker pattern (`lib/engine/worker.ts`). Reference: design doc line 92; v1 plan Task 13; v2 plan Task 13.

**Add to Phase A exit criteria — multi-domain coverage proof:** Semantic mode must be exercised end-to-end on at least one canonical example from each of: clinical (PE), financial (hometier retirement), and one non-clinical-non-financial example (engineering OR policy OR legal — pick one). Guards against the AI over-fitting to PE through repeated training on the same few-shot. Reference: design doc lines 122-146.

### Nice-to-have items (defer unless trivial when adjacent code is touched)

- **(8)** Calibration as a fourth analog gauge in the cockpit, in addition to C5's reliability diagram. Polish; the diagram + Brier satisfy Principle 4.

### Cross-cutting language commitment (already merged into Cross-cutting above)

- **(18)** Honest-uncertainty language commitment is now in Cross-cutting (paragraph 6).
- **(20)** Empty-state for reliability diagram below outcome threshold is now in Cross-cutting (paragraph 6).

### v2 Addendum exit criteria delta

Each phase's "exit criteria" section in the v1 spec is amended:

- **Phase C exit:** also passes C3 longitudinal perf budget; also passes C5 explicit empty-state render below threshold.
- **Phase A exit:** also includes threshold-setting state; also passes multi-domain coverage proof; also passes worked-example regression test; also emits live narration events through every state transition; also performs cockpit handoff on `runModel()`.
- **Phase B exit:** also includes B7 Expert Panel mechanism (now 7 research mechanisms, not 6); also includes "verify-next" loop wired to A5.
- **Phase D exit:** also produces dual export (Markdown + AnalysisExport JSON with seed reproducibility); also gates new audit events with secret-free unit tests.

### What did NOT make it into v2 and why

- **#13 gated live smoke pattern, #14 standalone mode tabs, #20 no-mock-data with reliability empty-state** — already covered in v1 (verified in audit). No change.
- **Hosted-deployment items** (real auth provider, abuse rate limits, tamper-resistant audit) — explicitly out of scope per all preprod docs. Remain deferred.

### Plan revision discipline

This v2 addendum is appended rather than rewriting v1 so the review trail is intact. When this plan is approved and execution begins, the addendum items will be cited by their item number ("v2 add #5 threshold") in commit messages so traceability is preserved.

---

## Pre-flight risks the user should know about before approval

1. **Phase C3 (path-dependent simulation)** is the most architecturally risky item. The DAG executor is single-shot today; adding multi-step state carryover is a substantive engine change. Suggest doing C3 in a worktree first to keep `main` clean if it goes wrong.
2. **Phase B2 (web search)** introduces a new external API dependency (Tavily). Need a Tavily account + API key in `.env.local` for the gated live test. Cost is roughly $0.005-$0.02 per search; cheap, but a new cost vector.
3. **Phase B3 (RAG)** introduces a vector store (LanceDB) and an embedding model dependency. Local-only, no cost, but adds disk footprint per workspace. Embedding model size ≈ 130MB cached on first use.
4. **Phase D1's NodeProvenance migration** must handle every persisted graph in the user's local DB. A bad migration would corrupt local data — script must be idempotent and tested against a real `dev.db` snapshot first.
5. **None of this is small.** Realistic scope: each Phase letter is roughly the size of the entire mitigation batch you saw recently (R6-04 through M8-06). Four phases = four iterations of similar magnitude. Honest expectation up front.

---

## What I will NOT do without your confirmation

- Spin up agents.
- Touch any source file.
- Make commits.
- Start Phase C until you confirm this plan reflects your intent.

Once you approve, I will start with **C1 (Triangular distribution)** because it is the smallest dependency-free starting point and proves the per-commit verification loop works for this kind of engine change.
