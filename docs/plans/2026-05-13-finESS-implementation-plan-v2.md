# finESS Platform Implementation Plan v2

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Next.js web application where users describe decisions in natural language, AI builds probabilistic uncertainty models, and users watch live Monte Carlo simulations through an immersive 6-panel animated dashboard.

**Architecture:** Next.js 14 App Router with a TypeScript DAG-walking Monte Carlo engine running in Web Workers for real-time browser-side simulation. AI (via OpenRouter, user-selected model) parses natural language into node graphs with per-edge computation methods. Canvas 2D handles the animated dashboard panels. PostgreSQL + Prisma stores saved analyses and calibration outcomes.

**Tech Stack:** Next.js 14, TypeScript, Tailwind CSS, Canvas API, Web Workers, OpenRouter API, PostgreSQL, Prisma

**Reference implementations:** `distribclin_app.py` (v0.1) and `distribclin_expert_system2.py` (v0.2) in the project root are golden references for mathematical correctness.

---

## Change Log (from DistribClin thread review)

| # | Change | Rationale |
|---|---|---|
| 1 | Replaced `computeFn` enum with DAG-walking `dag-executor.ts` | v0.2 PE scenario combines additive + subtractive + Bayesian — monolithic dispatch can't represent this |
| 2 | Removed name-matching (`includes("sensitivit")`) | Fragile. Uses node groups and edge structure instead |
| 3 | Added `"subtractive"` to `CombinationMethod` | Needed for lab_variability modifying d_dimer_spec (v0.2 pattern) |
| 4 | Implemented both sensitivity methods | "Fix to mean" (v0.2) for variance contribution + "halve SD" (v0.1) for information value |
| 5 | Added seeded PRNG (`prng.ts`) | Reproducible results for demos (seed=42) and saved analyses |
| 6 | Added v0.2 PE scenario as AI few-shot example | Without it, AI produces flat 3-node graphs instead of rich 6-node decompositions |
| 7 | Expert disagreement narration in AI prompt | Makes Principle 2 tangible: "experts disagreed 10-25% — this IS the uncertainty" |
| 8 | Calibration starts empty, no synthetic data | Honors NO MOCK policy. Real outcomes only (Principle 4) |
| 9 | Pre-built PE graph in examples (instant demo) | No API call needed for first demo — runs immediately with seed=42 |
| 10 | Golden reference test against Python outputs | Cross-validates the TypeScript port against known-good Python results |

---

## Phase 1: Project Scaffolding & Monte Carlo Engine

### Task 1: Initialize Next.js Project

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.js`, `tailwind.config.ts`, `postcss.config.js`
- Create: `app/layout.tsx`, `app/page.tsx`, `app/globals.css`
- Create: `.env.local` (gitignored), `.gitignore`

**Step 1:** Scaffold Next.js with TypeScript and Tailwind
**Step 2:** Configure dark theme (bg `#0a0e1a`, text `#e2e8f0`)
**Step 3:** Create `.env.local` with `OPENROUTER_API_KEY` and `DATABASE_URL`
**Step 4:** Verify dev server starts at localhost:3000
**Step 5:** `git init && git add . && git commit`

---

### Task 2: Core Type Definitions

**Files:** `lib/types.ts`

Key types: `UncertaintyNode`, `ReasoningEdge` (with per-edge `method`), `UncertaintyGraph` (**no `computeFn`**), `SimulationConfig` (optional `seed`), `SimulationResult` (saves `seed`), `SensitivityResult` (both `varianceReduction` and `ciWidthReduction`).

`CombinationMethod = "additive" | "subtractive" | "bayesian_update" | "multiplicative" | "custom"`

Commit after types compile.

---

### Task 3: Monte Carlo Engine (Web Worker)

**Files:**
- `lib/engine/prng.ts` — Mulberry32 seeded PRNG
- `lib/engine/distributions.ts` — getBetaParams, sampleDistribution (accepts `rand` fn)
- `lib/engine/dag-executor.ts` — walks edges by method, replaces monolithic switch
- `lib/engine/monte-carlo.ts` — runSimulation, runSimulationBatched (uses DAG executor)
- `lib/engine/sensitivity.ts` — both "fix to mean" AND "halve SD" methods
- Tests: `__tests__/engine/distributions.test.ts`, `__tests__/engine/dag-executor.test.ts`, `__tests__/engine/monte-carlo.test.ts`, `__tests__/engine/sensitivity.test.ts`

**DAG executor logic:**
1. Group edges by target
2. Compute intermediate values (additive composition, e.g., `pre_test_composed`)
3. Apply subtractive modifications (e.g., lab noise on specificity)
4. Execute Bayesian update / additive / multiplicative for output node

**Golden test:** Full 6-node v0.2 PE graph with deterministic seed=42.

TDD: write failing tests → implement → verify pass → commit.

---

### Task 4: Web Worker Wrapper

**Files:** `lib/engine/worker.ts`, `lib/engine/use-simulation.ts`

Worker streams batches via postMessage. React hook exposes `{ phase, currentBatch, result, start, cancel }`. Default config: 15000 samples, batch size 500, no default seed (random, saved in result).

---

## Phase 2: AI Pipeline

### Task 5: AI Node Generation API Route

**Files:** `lib/ai/prompt.ts`, `lib/ai/parse-response.ts`, `app/api/analyze/route.ts`, `__tests__/ai/parse-response.test.ts`

**System prompt includes:**
- Full v0.2 PE scenario as worked example (6 nodes, edge definitions)
- `"subtractive"` as valid edge method
- Instruction to articulate expert disagreement in narration (Principle 2)
- No `computeFn` in schema — edges define computation

**API route:** No default model hardcoded — user always selects via ModelSelector.

**Parse validation:** Checks edge methods against valid list, throws on invalid.

---

## Phase 3: Dashboard Visualization

### Task 6: Dashboard Layout Shell
6-panel grid: `components/Dashboard.tsx`, `components/InputBar.tsx`, wire into `app/page.tsx`

### Task 7: Node Network Panel (Canvas 2D, animated)
`components/panels/NodeNetwork.tsx`, `lib/viz/node-layout.ts` — glowing nodes, particle flow, pulse by sensitivity

### Task 8: Live Distribution Panel
`components/panels/LiveDistribution.tsx` — progressive histogram, CI sweep, "Polaroid developing"

### Task 9: Sensitivity Radar + Tornado Drill-Down
`components/panels/SensitivityRadar.tsx` — radar shows variance contribution (v0.2), click toggles tornado view showing swing (v0.1)

### Task 10: Uncertainty Gauges Panel
`components/panels/GaugePanel.tsx` — 4 analog dials: Confidence, Convergence, Decision Clarity, Information Value (no calibration gauge — requires real outcomes)

### Task 11: Spectrum Bars Panel
`components/panels/SpectrumBars.tsx` — horizontal per-node mini-histograms

### Task 12: Wire All Panels
Replace placeholders with real components in `app/page.tsx`. End-to-end manual test.

---

## Phase 4: Interactive Features

### Task 13: What-If Node Editing
`components/NodeEditor.tsx` — click node → adjust mean/SD via sliders → re-run. Includes "Expert Panel" input mode (enter multiple estimates → auto-compute distribution).

### Task 14: Model Selector
`components/ModelSelector.tsx` — user selects AI model via OpenRouter. No default.

---

## Phase 5: Persistence & Calibration

### Task 15: Database Schema
`prisma/schema.prisma` — Analysis (with `seed` field), CalibrationOutcome

### Task 16: Save/Load + Calibration API
CRUD for analyses. Calibration starts empty — shows message until >= 20 real outcomes recorded. No synthetic data.

---

## Phase 6: Polish & Testing

### Task 17: Comprehensive Test Suite
Golden reference test (Python outputs at seed=42), integration tests, >90% coverage with gap action plan.

### Task 18: CSS Animations
fadeIn keyframes, dark EEG aesthetic.

### Task 19: Example Scenarios
PE example includes pre-built 6-node graph (instant demo, seed=42). Other domains call AI.

---

## Build Checklist

| # | Task | Depends On | Validates |
|---|---|---|---|
| 1 | Initialize Next.js | — | Dev server starts |
| 2 | Core types | 1 | Types compile, no computeFn |
| 3 | MC engine + DAG + tests | 2 | All tests pass, 6-node PE graph works |
| 4 | Web Worker wrapper | 3 | Batches stream |
| 5 | AI pipeline | 2 | NL → valid DAG graph |
| 6 | Dashboard shell | 1 | 6-panel grid renders |
| 7 | Node Network | 6, 2 | Animated particles |
| 8 | Live Distribution | 6, 4 | Progressive histogram |
| 9 | Sensitivity Radar | 6, 3 | Radar + tornado |
| 10 | Gauges | 6, 4 | 4 smooth gauges |
| 11 | Spectrum Bars | 6, 4 | Per-node bars |
| 12 | Wire panels | 7-11 | Full e2e flow |
| 13 | What-If editing | 12 | Node adjust → re-run |
| 14 | Model selector | 5 | User picks model |
| 15 | DB schema | 1 | Prisma generates |
| 16 | Save/Calibration API | 15 | CRUD + real outcomes |
| 17 | Test suite | 3, 5 | >90% coverage |
| 18 | CSS polish | 12 | Dark theme |
| 19 | Examples | 12 | PE instant, others via AI |
