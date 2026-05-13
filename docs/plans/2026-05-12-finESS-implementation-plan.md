# finESS Platform Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Next.js web application where users describe decisions in natural language, AI builds probabilistic uncertainty models, and users watch live Monte Carlo simulations through an immersive 6-panel animated dashboard.

**Architecture:** Next.js 14 App Router with a TypeScript Monte Carlo engine running in Web Workers for real-time browser-side simulation. AI (via OpenRouter, user-selected model) parses natural language into node graphs. D3.js + Canvas 2D handles the animated dashboard panels. PostgreSQL + Prisma stores saved analyses and calibration outcomes.

**Tech Stack:** Next.js 14, TypeScript, Tailwind CSS, D3.js, Canvas API, Web Workers, OpenRouter API, PostgreSQL, Prisma

---

## Phase 1: Project Scaffolding & Monte Carlo Engine

### Task 1: Initialize Next.js Project

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.js`, `tailwind.config.ts`, `postcss.config.js`
- Create: `app/layout.tsx`, `app/page.tsx`, `app/globals.css`
- Create: `.env.local` (gitignored)
- Create: `.gitignore`

**Step 1: Scaffold Next.js with TypeScript and Tailwind**

```bash
cd /Volumes/WS4TB/finESS
npx create-next-app@latest app --typescript --tailwind --eslint --app --src-dir=false --import-alias="@/*" --no-git
```

Move contents out of `app/` subdirectory into project root (or scaffold directly in finESS root).

**Step 2: Configure dark theme defaults in globals.css**

Set body background to `#0a0e1a` (dark navy), default text `#e2e8f0`. This matches the EEG-style immersive aesthetic.

**Step 3: Create .env.local with required keys**

```env
OPENROUTER_API_KEY=
DATABASE_URL=
```

**Step 4: Verify dev server starts**

```bash
npm run dev
```

Expected: App loads at localhost:3000 with dark background.

**Step 5: Initialize git and commit**

```bash
git init
git add .
git commit -m "feat: initialize finESS Next.js project with dark theme"
```

---

### Task 2: Core Type Definitions

**Files:**
- Create: `lib/types.ts`

**Step 1: Write the failing test**

```bash
# No test for types — this is pure type definitions
```

**Step 2: Define the core domain types**

```typescript
// lib/types.ts

export type DistributionType = "beta" | "normal" | "lognormal" | "uniform";

export type CombinationMethod = "bayesian_update" | "additive" | "multiplicative" | "custom";

export interface UncertaintyNode {
  id: string;
  name: string;
  description: string;
  distributionType: DistributionType;
  mean: number;
  sd: number;
  plausibleRange: [number, number];
  unit: string;
  source: string; // Where AI got this estimate
  group: "input" | "modifier" | "test" | "output";
}

export interface ReasoningEdge {
  from: string; // node id
  to: string;   // node id
  method: CombinationMethod;
  description: string;
}

export interface UncertaintyGraph {
  id: string;
  title: string;
  domain: string;
  question: string;
  nodes: UncertaintyNode[];
  edges: ReasoningEdge[];
  outputNodeId: string;
  threshold: number;
  thresholdLabel: string;
  computeFn: string; // serialized computation function identifier
}

export interface SimulationConfig {
  nSamples: number;
  batchSize: number; // samples per animation frame
  seed: number;
}

export interface NodeSamples {
  nodeId: string;
  samples: Float64Array;
}

export interface SimulationBatch {
  batchIndex: number;
  totalBatches: number;
  nodeSamples: Record<string, number[]>; // nodeId -> samples for this batch
  posteriorSamples: number[];
  runningStats: {
    mean: number;
    ci_low: number;
    ci_high: number;
    p_above_threshold: number;
    convergence: number; // 0-1, how stable is the mean
  };
}

export interface SimulationResult {
  mean: number;
  median: number;
  ci_low: number;
  ci_high: number;
  ci_width: number;
  p_above_threshold: number;
  allSamples: number[];
  nodeSamples: Record<string, number[]>;
  sensitivity: SensitivityResult[];
}

export interface SensitivityResult {
  nodeId: string;
  nodeName: string;
  varianceReduction: number; // percentage
  ciWidthReduction: number;  // percentage
  rank: number;
}

export interface CalibrationPoint {
  predictedBin: number;
  observedRate: number;
  count: number;
}

// AI Pipeline types
export interface ParsedIntent {
  decision: string;
  domain: string;
  factors: string[];
  availableData: string[];
  question: string;
}

export interface AINodeGenerationResult {
  graph: UncertaintyGraph;
  narration: string[]; // step-by-step explanation for the stream panel
}

// Dashboard state
export type SimulationPhase = "idle" | "parsing" | "building_nodes" | "simulating" | "analyzing" | "complete";

export interface DashboardState {
  phase: SimulationPhase;
  graph: UncertaintyGraph | null;
  currentBatch: SimulationBatch | null;
  result: SimulationResult | null;
  narrationLog: string[];
}
```

**Step 3: Commit**

```bash
git add lib/types.ts
git commit -m "feat: define core domain types for uncertainty graph and simulation"
```

---

### Task 3: Monte Carlo Engine (Web Worker)

This is the mathematical heart — ported from the Python `distribclin_expert_system2.py`. Runs entirely in a Web Worker so the UI thread stays free for animations.

**Files:**
- Create: `lib/engine/distributions.ts`
- Create: `lib/engine/monte-carlo.ts`
- Create: `lib/engine/sensitivity.ts`
- Create: `lib/engine/worker.ts`
- Create: `lib/engine/use-simulation.ts` (React hook)
- Test: `__tests__/engine/distributions.test.ts`
- Test: `__tests__/engine/monte-carlo.test.ts`
- Test: `__tests__/engine/sensitivity.test.ts`

**Step 1: Write failing tests for distributions**

```typescript
// __tests__/engine/distributions.test.ts
import { getBetaParams, sampleDistribution } from "@/lib/engine/distributions";

describe("getBetaParams", () => {
  it("converts mean=0.18 sd=0.055 to valid alpha/beta", () => {
    const [a, b] = getBetaParams(0.18, 0.055);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    // Verify mean = a/(a+b) ≈ 0.18
    expect(a / (a + b)).toBeCloseTo(0.18, 1);
  });

  it("handles edge case sd near zero", () => {
    const [a, b] = getBetaParams(0.5, 0.001);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
  });
});

describe("sampleDistribution", () => {
  it("samples beta distribution within [0,1]", () => {
    const samples = sampleDistribution("beta", 0.18, 0.055, [0.05, 0.45], 1000);
    expect(samples.length).toBe(1000);
    samples.forEach((s) => {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    });
  });

  it("samples normal distribution clipped to range", () => {
    const samples = sampleDistribution("normal", 0.04, 0.025, [-0.05, 0.15], 1000);
    expect(samples.length).toBe(1000);
    samples.forEach((s) => {
      expect(s).toBeGreaterThanOrEqual(-0.05);
      expect(s).toBeLessThanOrEqual(0.15);
    });
  });

  it("sample mean is close to specified mean", () => {
    const samples = sampleDistribution("beta", 0.5, 0.1, [0, 1], 10000);
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean).toBeCloseTo(0.5, 1);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npm test -- __tests__/engine/distributions.test.ts
```

Expected: FAIL — modules don't exist.

**Step 3: Implement distributions.ts**

```typescript
// lib/engine/distributions.ts

export function getBetaParams(mean: number, sd: number): [number, number] {
  if (sd <= 0) sd = 1e-6;
  const variance = sd * sd;
  const alpha = mean * (mean * (1 - mean) / variance - 1);
  const beta = (1 - mean) * (mean * (1 - mean) / variance - 1);
  return [Math.max(alpha, 0.05), Math.max(beta, 0.05)];
}

// Marsaglia polar method for normal distribution
function randomNormal(mean: number, sd: number): number {
  let u: number, v: number, s: number;
  do {
    u = Math.random() * 2 - 1;
    v = Math.random() * 2 - 1;
    s = u * u + v * v;
  } while (s >= 1 || s === 0);
  const mul = Math.sqrt(-2.0 * Math.log(s) / s);
  return mean + sd * u * mul;
}

// Joehnk's algorithm for Beta distribution
function randomBeta(alpha: number, beta: number): number {
  if (alpha <= 0 || beta <= 0) return 0.5;
  // Use gamma-based method for general alpha, beta
  const x = randomGamma(alpha);
  const y = randomGamma(beta);
  return x / (x + y);
}

// Marsaglia and Tsang's method for Gamma distribution
function randomGamma(shape: number): number {
  if (shape < 1) {
    return randomGamma(shape + 1) * Math.pow(Math.random(), 1.0 / shape);
  }
  const d = shape - 1.0 / 3.0;
  const c = 1.0 / Math.sqrt(9.0 * d);
  while (true) {
    let x: number, v: number;
    do {
      x = randomNormal(0, 1);
      v = 1.0 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1.0 - 0.0331 * (x * x) * (x * x)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1.0 - v + Math.log(v))) return d * v;
  }
}

export type DistributionType = "beta" | "normal" | "lognormal" | "uniform";

export function sampleDistribution(
  type: DistributionType,
  mean: number,
  sd: number,
  range: [number, number],
  n: number
): number[] {
  const samples: number[] = new Array(n);

  switch (type) {
    case "beta": {
      const [a, b] = getBetaParams(mean, sd);
      for (let i = 0; i < n; i++) {
        samples[i] = Math.max(range[0], Math.min(range[1], randomBeta(a, b)));
      }
      break;
    }
    case "normal": {
      for (let i = 0; i < n; i++) {
        const val = randomNormal(mean, sd);
        samples[i] = Math.max(range[0], Math.min(range[1], val));
      }
      break;
    }
    case "lognormal": {
      // Convert mean/sd to log-space parameters
      const variance = sd * sd;
      const mu = Math.log(mean * mean / Math.sqrt(variance + mean * mean));
      const sigma = Math.sqrt(Math.log(1 + variance / (mean * mean)));
      for (let i = 0; i < n; i++) {
        const val = Math.exp(randomNormal(mu, sigma));
        samples[i] = Math.max(range[0], Math.min(range[1], val));
      }
      break;
    }
    case "uniform": {
      for (let i = 0; i < n; i++) {
        samples[i] = range[0] + Math.random() * (range[1] - range[0]);
      }
      break;
    }
  }

  return samples;
}
```

**Step 4: Run tests to verify they pass**

```bash
npm test -- __tests__/engine/distributions.test.ts
```

Expected: PASS

**Step 5: Write failing tests for monte-carlo**

```typescript
// __tests__/engine/monte-carlo.test.ts
import { runSimulation } from "@/lib/engine/monte-carlo";
import type { UncertaintyGraph } from "@/lib/types";

const PE_GRAPH: UncertaintyGraph = {
  id: "test-pe",
  title: "PE Risk",
  domain: "clinical",
  question: "What is the posterior probability of PE?",
  nodes: [
    { id: "pre_test", name: "Pre-test Probability", description: "Base prevalence", distributionType: "beta", mean: 0.18, sd: 0.055, plausibleRange: [0.05, 0.45], unit: "%", source: "Expert panel", group: "input" },
    { id: "sensitivity", name: "D-dimer Sensitivity", description: "True positive rate", distributionType: "beta", mean: 0.93, sd: 0.025, plausibleRange: [0.82, 0.98], unit: "%", source: "Literature", group: "test" },
    { id: "specificity", name: "D-dimer Specificity", description: "True negative rate", distributionType: "beta", mean: 0.38, sd: 0.075, plausibleRange: [0.20, 0.60], unit: "%", source: "Literature", group: "test" },
  ],
  edges: [
    { from: "pre_test", to: "posterior", method: "bayesian_update", description: "Bayes update" },
    { from: "sensitivity", to: "posterior", method: "bayesian_update", description: "Bayes update" },
    { from: "specificity", to: "posterior", method: "bayesian_update", description: "Bayes update" },
  ],
  outputNodeId: "posterior",
  threshold: 0.30,
  thresholdLabel: "High risk",
  computeFn: "bayesian_positive_test",
};

describe("runSimulation", () => {
  it("returns valid posterior statistics for PE scenario", () => {
    const result = runSimulation(PE_GRAPH, { nSamples: 5000, batchSize: 1000, seed: 42 });
    expect(result.mean).toBeGreaterThan(0.10);
    expect(result.mean).toBeLessThan(0.50);
    expect(result.ci_low).toBeLessThan(result.mean);
    expect(result.ci_high).toBeGreaterThan(result.mean);
    expect(result.ci_width).toBeGreaterThan(0);
    expect(result.allSamples.length).toBe(5000);
  });

  it("posterior mean is roughly consistent with Python reference (~22%)", () => {
    const result = runSimulation(PE_GRAPH, { nSamples: 15000, batchSize: 5000, seed: 42 });
    // Python distribclin_app.py produces mean around 22%
    expect(result.mean).toBeGreaterThan(0.15);
    expect(result.mean).toBeLessThan(0.35);
  });
});
```

**Step 6: Run to verify failure**

```bash
npm test -- __tests__/engine/monte-carlo.test.ts
```

**Step 7: Implement monte-carlo.ts**

```typescript
// lib/engine/monte-carlo.ts
import { sampleDistribution } from "./distributions";
import type { UncertaintyGraph, SimulationConfig, SimulationResult, SimulationBatch } from "@/lib/types";

function computeBayesianPositiveTest(
  nodeSamples: Record<string, number[]>,
  graph: UncertaintyGraph,
  n: number
): number[] {
  // Find nodes by group
  const inputNodes = graph.nodes.filter((nd) => nd.group === "input" || nd.group === "modifier");
  const testNodes = graph.nodes.filter((nd) => nd.group === "test");

  const sensNode = testNodes.find((nd) => nd.name.toLowerCase().includes("sensitivit"));
  const specNode = testNodes.find((nd) => nd.name.toLowerCase().includes("specificit"));

  const posterior = new Array(n);

  for (let i = 0; i < n; i++) {
    // Sum all input/modifier nodes for pre-test
    let pre = 0;
    for (const nd of inputNodes) {
      pre += nodeSamples[nd.id][i];
    }
    pre = Math.max(0.01, Math.min(0.95, pre));

    const sens = sensNode ? nodeSamples[sensNode.id][i] : 0.9;
    const spec = specNode ? nodeSamples[specNode.id][i] : 0.5;

    // Bayes update for positive test
    const denom = pre * sens + (1 - pre) * (1 - spec);
    posterior[i] = Math.max(0, Math.min(1, (pre * sens) / Math.max(denom, 1e-12)));
  }

  return posterior;
}

function computeGenericAdditive(
  nodeSamples: Record<string, number[]>,
  graph: UncertaintyGraph,
  n: number
): number[] {
  const posterior = new Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (const nd of graph.nodes) {
      sum += nodeSamples[nd.id][i];
    }
    posterior[i] = sum;
  }
  return posterior;
}

function computeGenericMultiplicative(
  nodeSamples: Record<string, number[]>,
  graph: UncertaintyGraph,
  n: number
): number[] {
  const posterior = new Array(n);
  for (let i = 0; i < n; i++) {
    let product = 1;
    for (const nd of graph.nodes) {
      product *= nodeSamples[nd.id][i];
    }
    posterior[i] = product;
  }
  return posterior;
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
}

export function runSimulation(
  graph: UncertaintyGraph,
  config: SimulationConfig
): SimulationResult {
  const { nSamples } = config;

  // Sample all nodes
  const nodeSamples: Record<string, number[]> = {};
  for (const node of graph.nodes) {
    nodeSamples[node.id] = sampleDistribution(
      node.distributionType,
      node.mean,
      node.sd,
      node.plausibleRange,
      nSamples
    );
  }

  // Compute posterior based on computeFn
  let posteriorSamples: number[];
  switch (graph.computeFn) {
    case "bayesian_positive_test":
      posteriorSamples = computeBayesianPositiveTest(nodeSamples, graph, nSamples);
      break;
    case "additive":
      posteriorSamples = computeGenericAdditive(nodeSamples, graph, nSamples);
      break;
    case "multiplicative":
      posteriorSamples = computeGenericMultiplicative(nodeSamples, graph, nSamples);
      break;
    default:
      posteriorSamples = computeBayesianPositiveTest(nodeSamples, graph, nSamples);
  }

  const mean = posteriorSamples.reduce((a, b) => a + b, 0) / nSamples;
  const sorted = [...posteriorSamples].sort((a, b) => a - b);
  const median = sorted[Math.floor(nSamples / 2)];
  const ci_low = percentile(posteriorSamples, 2.5);
  const ci_high = percentile(posteriorSamples, 97.5);

  return {
    mean,
    median,
    ci_low,
    ci_high,
    ci_width: ci_high - ci_low,
    p_above_threshold: posteriorSamples.filter((s) => s > graph.threshold).length / nSamples,
    allSamples: posteriorSamples,
    nodeSamples,
    sensitivity: [], // computed separately
  };
}

export function runSimulationBatched(
  graph: UncertaintyGraph,
  config: SimulationConfig,
  onBatch: (batch: SimulationBatch) => void
): SimulationResult {
  const { nSamples, batchSize } = config;
  const totalBatches = Math.ceil(nSamples / batchSize);

  const allNodeSamples: Record<string, number[]> = {};
  for (const node of graph.nodes) {
    allNodeSamples[node.id] = [];
  }
  const allPosterior: number[] = [];
  let prevMean = 0;

  for (let b = 0; b < totalBatches; b++) {
    const n = Math.min(batchSize, nSamples - b * batchSize);

    // Sample this batch
    const batchNodeSamples: Record<string, number[]> = {};
    for (const node of graph.nodes) {
      const samples = sampleDistribution(node.distributionType, node.mean, node.sd, node.plausibleRange, n);
      batchNodeSamples[node.id] = samples;
      allNodeSamples[node.id].push(...samples);
    }

    // Compute posterior for this batch
    let batchPosterior: number[];
    switch (graph.computeFn) {
      case "bayesian_positive_test":
        batchPosterior = computeBayesianPositiveTest(batchNodeSamples, graph, n);
        break;
      case "additive":
        batchPosterior = computeGenericAdditive(batchNodeSamples, graph, n);
        break;
      case "multiplicative":
        batchPosterior = computeGenericMultiplicative(batchNodeSamples, graph, n);
        break;
      default:
        batchPosterior = computeBayesianPositiveTest(batchNodeSamples, graph, n);
    }
    allPosterior.push(...batchPosterior);

    // Running stats
    const currentMean = allPosterior.reduce((a, c) => a + c, 0) / allPosterior.length;
    const convergence = b === 0 ? 0 : 1 - Math.min(1, Math.abs(currentMean - prevMean) / Math.max(prevMean, 0.001));
    prevMean = currentMean;

    onBatch({
      batchIndex: b,
      totalBatches,
      nodeSamples: batchNodeSamples,
      posteriorSamples: batchPosterior,
      runningStats: {
        mean: currentMean,
        ci_low: percentile(allPosterior, 2.5),
        ci_high: percentile(allPosterior, 97.5),
        p_above_threshold: allPosterior.filter((s) => s > graph.threshold).length / allPosterior.length,
        convergence,
      },
    });
  }

  const mean = allPosterior.reduce((a, b) => a + b, 0) / allPosterior.length;
  const sorted = [...allPosterior].sort((a, b) => a - b);
  const median = sorted[Math.floor(allPosterior.length / 2)];

  return {
    mean,
    median,
    ci_low: percentile(allPosterior, 2.5),
    ci_high: percentile(allPosterior, 97.5),
    ci_width: percentile(allPosterior, 97.5) - percentile(allPosterior, 2.5),
    p_above_threshold: allPosterior.filter((s) => s > graph.threshold).length / allPosterior.length,
    allSamples: allPosterior,
    nodeSamples: allNodeSamples,
    sensitivity: [],
  };
}
```

**Step 8: Run tests to verify they pass**

```bash
npm test -- __tests__/engine/monte-carlo.test.ts
```

**Step 9: Write failing tests for sensitivity**

```typescript
// __tests__/engine/sensitivity.test.ts
import { computeSensitivity } from "@/lib/engine/sensitivity";
// Use same PE_GRAPH from monte-carlo tests

describe("computeSensitivity", () => {
  it("returns one entry per node", () => {
    const result = computeSensitivity(PE_GRAPH, { nSamples: 5000, batchSize: 5000, seed: 42 });
    expect(result.length).toBe(PE_GRAPH.nodes.length);
  });

  it("ranks nodes by variance reduction", () => {
    const result = computeSensitivity(PE_GRAPH, { nSamples: 5000, batchSize: 5000, seed: 42 });
    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i].varianceReduction).toBeGreaterThanOrEqual(result[i + 1].varianceReduction);
    }
  });

  it("specificity has highest sensitivity (matches Python reference)", () => {
    const result = computeSensitivity(PE_GRAPH, { nSamples: 10000, batchSize: 10000, seed: 42 });
    // In the Python version, specificity (most uncertain) drives the most variance
    expect(result[0].nodeId).toBe("specificity");
  });
});
```

**Step 10: Implement sensitivity.ts**

```typescript
// lib/engine/sensitivity.ts
import { runSimulation } from "./monte-carlo";
import type { UncertaintyGraph, SimulationConfig, SensitivityResult } from "@/lib/types";

export function computeSensitivity(
  graph: UncertaintyGraph,
  config: SimulationConfig
): SensitivityResult[] {
  // Baseline variance
  const baseResult = runSimulation(graph, config);
  const baseVariance = variance(baseResult.allSamples);
  const baseCIWidth = baseResult.ci_width;

  const results: SensitivityResult[] = [];

  for (const node of graph.nodes) {
    // Create a copy with this node's SD halved
    const modifiedGraph: UncertaintyGraph = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === node.id ? { ...n, sd: n.sd * 0.5 } : n
      ),
    };

    const modResult = runSimulation(modifiedGraph, config);
    const modVariance = variance(modResult.allSamples);

    const varReduction = Math.max(0, ((baseVariance - modVariance) / baseVariance) * 100);
    const ciReduction = Math.max(0, ((baseCIWidth - modResult.ci_width) / baseCIWidth) * 100);

    results.push({
      nodeId: node.id,
      nodeName: node.name,
      varianceReduction: varReduction,
      ciWidthReduction: ciReduction,
      rank: 0,
    });
  }

  // Sort by variance reduction descending and assign ranks
  results.sort((a, b) => b.varianceReduction - a.varianceReduction);
  results.forEach((r, i) => (r.rank = i + 1));

  return results;
}

function variance(arr: number[]): number {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return arr.reduce((sum, val) => sum + (val - mean) ** 2, 0) / arr.length;
}
```

**Step 11: Run all engine tests**

```bash
npm test -- __tests__/engine/
```

Expected: ALL PASS

**Step 12: Commit**

```bash
git add lib/engine/ __tests__/engine/
git commit -m "feat: implement Monte Carlo engine with distributions, simulation, and sensitivity analysis"
```

---

### Task 4: Web Worker Wrapper

**Files:**
- Create: `lib/engine/worker.ts`
- Create: `lib/engine/use-simulation.ts`

**Step 1: Implement worker.ts**

```typescript
// lib/engine/worker.ts
/// <reference lib="webworker" />

import { runSimulationBatched } from "./monte-carlo";
import { computeSensitivity } from "./sensitivity";
import type { UncertaintyGraph, SimulationConfig } from "@/lib/types";

export type WorkerMessage =
  | { type: "start"; graph: UncertaintyGraph; config: SimulationConfig }
  | { type: "cancel" };

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;

  if (msg.type === "start") {
    const result = runSimulationBatched(msg.graph, msg.config, (batch) => {
      self.postMessage({ type: "batch", batch });
    });

    // Run sensitivity after simulation completes
    const sensitivity = computeSensitivity(msg.graph, msg.config);
    result.sensitivity = sensitivity;

    self.postMessage({ type: "complete", result });
  }
};
```

**Step 2: Implement use-simulation.ts React hook**

```typescript
// lib/engine/use-simulation.ts
"use client";

import { useCallback, useRef, useState } from "react";
import type {
  UncertaintyGraph,
  SimulationConfig,
  SimulationBatch,
  SimulationResult,
  SimulationPhase,
} from "@/lib/types";

const DEFAULT_CONFIG: SimulationConfig = {
  nSamples: 15000,
  batchSize: 500, // small batches for smooth animation
  seed: Date.now(),
};

export function useSimulation() {
  const workerRef = useRef<Worker | null>(null);
  const [phase, setPhase] = useState<SimulationPhase>("idle");
  const [currentBatch, setCurrentBatch] = useState<SimulationBatch | null>(null);
  const [result, setResult] = useState<SimulationResult | null>(null);

  const start = useCallback(
    (graph: UncertaintyGraph, config: SimulationConfig = DEFAULT_CONFIG) => {
      // Terminate existing worker
      if (workerRef.current) {
        workerRef.current.terminate();
      }

      setPhase("simulating");
      setResult(null);
      setCurrentBatch(null);

      const worker = new Worker(
        new URL("./worker.ts", import.meta.url),
        { type: "module" }
      );

      worker.onmessage = (e) => {
        if (e.data.type === "batch") {
          setCurrentBatch(e.data.batch);
        } else if (e.data.type === "complete") {
          setPhase("analyzing");
          setResult(e.data.result);
          setPhase("complete");
          worker.terminate();
          workerRef.current = null;
        }
      };

      worker.postMessage({ type: "start", graph, config });
      workerRef.current = worker;
    },
    []
  );

  const cancel = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    setPhase("idle");
  }, []);

  return { phase, currentBatch, result, start, cancel };
}
```

**Step 3: Commit**

```bash
git add lib/engine/worker.ts lib/engine/use-simulation.ts
git commit -m "feat: add Web Worker wrapper and React hook for live simulation streaming"
```

---

## Phase 2: AI Pipeline (Natural Language → Uncertainty Graph)

### Task 5: AI Node Generation API Route

**Files:**
- Create: `app/api/analyze/route.ts`
- Create: `lib/ai/prompt.ts`
- Create: `lib/ai/parse-response.ts`
- Test: `__tests__/ai/parse-response.test.ts`

**Step 1: Write the system prompt**

```typescript
// lib/ai/prompt.ts

export const SYSTEM_PROMPT = `You are finESS, an expert system that models uncertainty honestly.

Given a user's decision problem described in natural language, you must:

1. Identify the key uncertain factors (3-8 nodes)
2. For each factor, determine:
   - A descriptive name
   - The appropriate probability distribution type (beta for probabilities 0-1, normal for measurements, lognormal for right-skewed positive values, uniform for complete ignorance)
   - The best-estimate mean value
   - The standard deviation (encoding uncertainty/disagreement)
   - A plausible range [low, high]
   - The unit (%, pp, years, dollars, etc.)
   - The source of the estimate (literature, expert consensus, base rates, etc.)
   - The group: "input" (base rates/priors), "modifier" (adjustments), "test" (diagnostic characteristics), "output" (computed)

3. Determine the computation method:
   - "bayesian_positive_test" for diagnostic scenarios with sensitivity/specificity
   - "additive" for risk factors that add together
   - "multiplicative" for independent probability chains

4. Set an appropriate decision threshold and label

5. Narrate your reasoning step by step (this will be shown to the user in real-time)

You MUST respond with valid JSON matching this exact schema:

{
  "graph": {
    "title": "string — short title for the analysis",
    "domain": "clinical | financial | engineering | legal | policy | other",
    "question": "string — the decision question restated clearly",
    "nodes": [
      {
        "id": "snake_case_id",
        "name": "Human-Readable Name",
        "description": "What this factor represents",
        "distributionType": "beta | normal | lognormal | uniform",
        "mean": 0.0,
        "sd": 0.0,
        "plausibleRange": [0.0, 0.0],
        "unit": "string",
        "source": "Where this estimate comes from",
        "group": "input | modifier | test | output"
      }
    ],
    "edges": [
      {
        "from": "node_id",
        "to": "output",
        "method": "bayesian_update | additive | multiplicative",
        "description": "How this node feeds into the computation"
      }
    ],
    "outputNodeId": "output",
    "threshold": 0.0,
    "thresholdLabel": "string",
    "computeFn": "bayesian_positive_test | additive | multiplicative"
  },
  "narration": [
    "Step-by-step explanation of reasoning...",
    "Each string is one narration message shown to user...",
    "Include what factors you identified and why...",
    "Include your uncertainty estimates and sources..."
  ]
}

CRITICAL RULES:
- Every mean and sd must be real numbers based on evidence, literature, or calibrated expert estimates
- Never use placeholder values. Research-quality estimates only.
- The sd MUST reflect genuine uncertainty — wider when evidence is sparse, narrower when well-validated
- Always explain WHY you chose each distribution and parameter value in the narration
- Narration should be plain language a non-statistician can understand
- Include 5-10 narration messages that progressively reveal the reasoning`;

export function buildUserPrompt(question: string): string {
  return `Analyze this decision problem and build an uncertainty model:

"${question}"

Respond with the JSON uncertainty graph and step-by-step narration.`;
}
```

**Step 2: Write failing tests for parse-response**

```typescript
// __tests__/ai/parse-response.test.ts
import { parseAIResponse } from "@/lib/ai/parse-response";

const VALID_RESPONSE = JSON.stringify({
  graph: {
    title: "PE Risk Assessment",
    domain: "clinical",
    question: "What is the posterior probability of PE?",
    nodes: [
      { id: "pre_test", name: "Pre-test Probability", description: "Base rate", distributionType: "beta", mean: 0.18, sd: 0.055, plausibleRange: [0.05, 0.45], unit: "%", source: "Expert panel", group: "input" },
    ],
    edges: [{ from: "pre_test", to: "output", method: "bayesian_update", description: "Bayes" }],
    outputNodeId: "output",
    threshold: 0.30,
    thresholdLabel: "High risk",
    computeFn: "bayesian_positive_test",
  },
  narration: ["Identified pre-test probability as key factor"],
});

describe("parseAIResponse", () => {
  it("parses valid JSON response", () => {
    const result = parseAIResponse(VALID_RESPONSE);
    expect(result.graph.nodes.length).toBe(1);
    expect(result.narration.length).toBe(1);
  });

  it("extracts JSON from markdown code block", () => {
    const wrapped = "```json\n" + VALID_RESPONSE + "\n```";
    const result = parseAIResponse(wrapped);
    expect(result.graph.nodes.length).toBe(1);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseAIResponse("not json")).toThrow();
  });

  it("throws when required fields are missing", () => {
    expect(() => parseAIResponse(JSON.stringify({ graph: {} }))).toThrow();
  });
});
```

**Step 3: Implement parse-response.ts**

```typescript
// lib/ai/parse-response.ts
import type { AINodeGenerationResult, UncertaintyGraph, UncertaintyNode, ReasoningEdge } from "@/lib/types";

export function parseAIResponse(raw: string): AINodeGenerationResult {
  // Strip markdown code block if present
  let jsonStr = raw.trim();
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`Failed to parse AI response as JSON: ${jsonStr.substring(0, 200)}...`);
  }

  const obj = parsed as Record<string, unknown>;
  if (!obj.graph || typeof obj.graph !== "object") {
    throw new Error("AI response missing 'graph' field");
  }

  const graph = obj.graph as Record<string, unknown>;
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    throw new Error("AI response graph must have at least one node");
  }
  if (!graph.computeFn || !graph.threshold) {
    throw new Error("AI response graph missing computeFn or threshold");
  }

  const narration = Array.isArray(obj.narration) ? (obj.narration as string[]) : [];

  // Assign IDs to graph
  const resultGraph: UncertaintyGraph = {
    id: `analysis-${Date.now()}`,
    title: (graph.title as string) || "Untitled Analysis",
    domain: (graph.domain as string) || "other",
    question: (graph.question as string) || "",
    nodes: (graph.nodes as UncertaintyNode[]).map((n, i) => ({
      ...n,
      id: n.id || `node_${i}`,
    })),
    edges: (graph.edges as ReasoningEdge[]) || [],
    outputNodeId: (graph.outputNodeId as string) || "output",
    threshold: graph.threshold as number,
    thresholdLabel: (graph.thresholdLabel as string) || "Threshold",
    computeFn: graph.computeFn as string,
  };

  return { graph: resultGraph, narration };
}
```

**Step 4: Run tests**

```bash
npm test -- __tests__/ai/parse-response.test.ts
```

Expected: PASS

**Step 5: Implement the API route**

```typescript
// app/api/analyze/route.ts
import { NextResponse } from "next/server";
import { SYSTEM_PROMPT, buildUserPrompt } from "@/lib/ai/prompt";
import { parseAIResponse } from "@/lib/ai/parse-response";

export async function POST(request: Request) {
  try {
    const { question, model } = await request.json();

    if (!question || typeof question !== "string") {
      return NextResponse.json({ error: "Question is required" }, { status: 400 });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "OPENROUTER_API_KEY not configured" }, { status: 500 });
    }

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://finess.app",
        "X-Title": "finESS",
      },
      body: JSON.stringify({
        model: model || "anthropic/claude-sonnet-4", // user selects model
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(question) },
        ],
        temperature: 0.3,
        max_tokens: 4000,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return NextResponse.json(
        { error: `OpenRouter API error: ${response.status}`, details: errorBody },
        { status: 502 }
      );
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      return NextResponse.json({ error: "No content in AI response" }, { status: 502 });
    }

    const result = parseAIResponse(content);

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

**Step 6: Commit**

```bash
git add lib/ai/ app/api/analyze/ __tests__/ai/
git commit -m "feat: implement AI pipeline - natural language to uncertainty graph via OpenRouter"
```

---

## Phase 3: Dashboard Visualization Components

### Task 6: Dashboard Layout Shell

**Files:**
- Create: `components/Dashboard.tsx`
- Create: `components/InputBar.tsx`
- Modify: `app/page.tsx`

**Step 1: Build the 6-panel dashboard layout**

```typescript
// components/Dashboard.tsx
"use client";

import { type ReactNode } from "react";

interface DashboardProps {
  nodeNetwork: ReactNode;
  distributionPanel: ReactNode;
  sensitivityRadar: ReactNode;
  gauges: ReactNode;
  spectrumBars: ReactNode;
  narrationStream: ReactNode;
  phase: string;
}

export function Dashboard({
  nodeNetwork,
  distributionPanel,
  sensitivityRadar,
  gauges,
  spectrumBars,
  narrationStream,
  phase,
}: DashboardProps) {
  return (
    <div className="h-screen w-screen bg-[#0a0e1a] text-slate-200 grid grid-rows-[auto_1fr_auto] overflow-hidden">
      {/* Top bar */}
      <div className="px-6 py-3 border-b border-slate-800/50 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold tracking-tight text-white font-mono">finESS</h1>
          <span className="text-xs text-slate-500 font-mono">Distributions, not verdicts</span>
        </div>
        <div className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full ${
              phase === "simulating"
                ? "bg-emerald-400 animate-pulse"
                : phase === "complete"
                  ? "bg-cyan-400"
                  : "bg-slate-600"
            }`}
          />
          <span className="text-xs font-mono text-slate-400 uppercase tracking-wider">
            {phase}
          </span>
        </div>
      </div>

      {/* Main grid: 6 panels */}
      <div className="grid grid-cols-[1fr_300px] grid-rows-[1fr_1fr_auto] gap-1 p-1 min-h-0">
        {/* Center: Node Network (spans 2 rows) */}
        <div className="row-span-1 rounded-lg border border-slate-800/50 bg-[#0d1220] overflow-hidden">
          {nodeNetwork}
        </div>

        {/* Right top: Narration Stream */}
        <div className="row-span-2 rounded-lg border border-slate-800/50 bg-[#0d1220] overflow-hidden">
          {narrationStream}
        </div>

        {/* Center bottom row: Distribution + Radar + Gauges */}
        <div className="grid grid-cols-3 gap-1">
          <div className="rounded-lg border border-slate-800/50 bg-[#0d1220] overflow-hidden">
            {distributionPanel}
          </div>
          <div className="rounded-lg border border-slate-800/50 bg-[#0d1220] overflow-hidden">
            {sensitivityRadar}
          </div>
          <div className="rounded-lg border border-slate-800/50 bg-[#0d1220] overflow-hidden">
            {gauges}
          </div>
        </div>

        {/* Bottom: Spectrum Bars (full width) */}
        <div className="col-span-2 rounded-lg border border-slate-800/50 bg-[#0d1220] overflow-hidden h-28">
          {spectrumBars}
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Build the input bar**

```typescript
// components/InputBar.tsx
"use client";

import { useState } from "react";

interface InputBarProps {
  onSubmit: (question: string) => void;
  disabled: boolean;
}

export function InputBar({ onSubmit, disabled }: InputBarProps) {
  const [question, setQuestion] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (question.trim() && !disabled) {
      onSubmit(question.trim());
    }
  };

  return (
    <form onSubmit={handleSubmit} className="relative">
      <input
        type="text"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="Describe your decision problem..."
        disabled={disabled}
        className="w-full bg-[#111827] border border-slate-700 rounded-xl px-5 py-4 text-lg text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/30 disabled:opacity-50 font-mono"
      />
      <button
        type="submit"
        disabled={disabled || !question.trim()}
        className="absolute right-3 top-1/2 -translate-y-1/2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 text-white px-4 py-2 rounded-lg text-sm font-bold transition-colors"
      >
        Analyze
      </button>
    </form>
  );
}
```

**Step 3: Wire up page.tsx**

```typescript
// app/page.tsx
"use client";

import { useState, useCallback } from "react";
import { Dashboard } from "@/components/Dashboard";
import { InputBar } from "@/components/InputBar";
import { useSimulation } from "@/lib/engine/use-simulation";
import type { UncertaintyGraph, SimulationPhase, AINodeGenerationResult } from "@/lib/types";

export default function Home() {
  const { phase: simPhase, currentBatch, result, start, cancel } = useSimulation();
  const [appPhase, setAppPhase] = useState<SimulationPhase>("idle");
  const [graph, setGraph] = useState<UncertaintyGraph | null>(null);
  const [narration, setNarration] = useState<string[]>([]);

  const phase = simPhase === "idle" ? appPhase : simPhase;

  const handleSubmit = useCallback(
    async (question: string) => {
      setAppPhase("parsing");
      setNarration(["Analyzing your question..."]);

      try {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question }),
        });

        if (!res.ok) {
          const err = await res.json();
          setNarration((prev) => [...prev, `Error: ${err.error}`]);
          setAppPhase("idle");
          return;
        }

        const data: AINodeGenerationResult = await res.json();
        setGraph(data.graph);
        setNarration(data.narration);
        setAppPhase("building_nodes");

        // Start simulation after a brief pause for node animation
        setTimeout(() => {
          start(data.graph);
        }, 2000);
      } catch (err) {
        setNarration((prev) => [...prev, `Network error: ${String(err)}`]);
        setAppPhase("idle");
      }
    },
    [start]
  );

  return (
    <div className="h-screen flex flex-col bg-[#0a0e1a]">
      <div className="px-6 py-4">
        <InputBar onSubmit={handleSubmit} disabled={phase !== "idle" && phase !== "complete"} />
      </div>
      <div className="flex-1 min-h-0">
        <Dashboard
          phase={phase}
          nodeNetwork={<PlaceholderPanel label="Node Network" graph={graph} />}
          distributionPanel={<PlaceholderPanel label="Distribution" batch={currentBatch} result={result} />}
          sensitivityRadar={<PlaceholderPanel label="Sensitivity Radar" result={result} />}
          gauges={<PlaceholderPanel label="Gauges" batch={currentBatch} />}
          spectrumBars={<PlaceholderPanel label="Spectrum Bars" batch={currentBatch} />}
          narrationStream={<NarrationPanel messages={narration} />}
        />
      </div>
    </div>
  );
}

function PlaceholderPanel({ label, ...props }: { label: string; [key: string]: unknown }) {
  return (
    <div className="h-full flex items-center justify-center text-slate-600 text-sm font-mono">
      {label}
    </div>
  );
}

function NarrationPanel({ messages }: { messages: string[] }) {
  return (
    <div className="h-full p-4 overflow-y-auto">
      <h3 className="text-xs font-bold text-cyan-400 uppercase tracking-wider mb-3 font-mono">
        Reasoning
      </h3>
      <div className="space-y-2">
        {messages.map((msg, i) => (
          <div key={i} className="text-sm text-slate-300 font-mono leading-relaxed animate-fadeIn">
            <span className="text-cyan-600 mr-2">&gt;</span>
            {msg}
          </div>
        ))}
      </div>
    </div>
  );
}
```

**Step 4: Verify the app loads and shows the dashboard shell**

```bash
npm run dev
```

Open localhost:3000. Expected: Dark dashboard with input bar, 6 panel grid visible with placeholder labels.

**Step 5: Commit**

```bash
git add components/ app/page.tsx
git commit -m "feat: build dashboard shell with 6-panel layout and input bar"
```

---

### Task 7: Node Network Visualization (Canvas 2D, Animated)

**Files:**
- Create: `components/panels/NodeNetwork.tsx`
- Create: `lib/viz/node-layout.ts`

This panel shows nodes as glowing circles with animated particle connections. Nodes pulse based on their sensitivity contribution. Dark theme with neon accents like the EEG screenshot.

**Step 1: Implement force-directed layout helper**

```typescript
// lib/viz/node-layout.ts
import type { UncertaintyNode } from "@/lib/types";

export interface NodePosition {
  id: string;
  x: number;
  y: number;
  radius: number;
  color: string;
  glowIntensity: number; // 0-1
}

const GROUP_COLORS: Record<string, string> = {
  input: "#0ea5e9",    // cyan
  modifier: "#8b5cf6", // purple
  test: "#10b981",     // emerald
  output: "#ef4444",   // red
};

export function layoutNodes(
  nodes: UncertaintyNode[],
  width: number,
  height: number,
  sensitivity?: Record<string, number> // nodeId -> variance reduction %
): NodePosition[] {
  const padding = 60;
  const outputX = width - padding;
  const outputY = height / 2;

  // Group nodes by type, place in columns
  const groups = { input: [] as UncertaintyNode[], modifier: [] as UncertaintyNode[], test: [] as UncertaintyNode[] };
  for (const node of nodes) {
    if (node.group in groups) {
      groups[node.group as keyof typeof groups].push(node);
    }
  }

  const positions: NodePosition[] = [];
  const cols = [0.2, 0.45, 0.65]; // x positions for each group
  const groupOrder: (keyof typeof groups)[] = ["input", "modifier", "test"];

  for (let g = 0; g < groupOrder.length; g++) {
    const group = groups[groupOrder[g]];
    if (group.length === 0) continue;

    const colX = padding + cols[g] * (width - 2 * padding);
    const spacing = (height - 2 * padding) / (group.length + 1);

    for (let i = 0; i < group.length; i++) {
      const node = group[i];
      const sensContrib = sensitivity?.[node.id] ?? 0;
      const glowIntensity = Math.min(1, sensContrib / 50);

      positions.push({
        id: node.id,
        x: colX,
        y: padding + spacing * (i + 1),
        radius: 20 + glowIntensity * 15,
        color: GROUP_COLORS[node.group] || "#64748b",
        glowIntensity,
      });
    }
  }

  // Output node
  positions.push({
    id: "__output__",
    x: outputX,
    y: outputY,
    radius: 35,
    color: "#ef4444",
    glowIntensity: 1,
  });

  return positions;
}
```

**Step 2: Build the animated Canvas component**

```typescript
// components/panels/NodeNetwork.tsx
"use client";

import { useRef, useEffect } from "react";
import { layoutNodes, type NodePosition } from "@/lib/viz/node-layout";
import type { UncertaintyGraph, SimulationBatch, SensitivityResult } from "@/lib/types";

interface Props {
  graph: UncertaintyGraph | null;
  batch: SimulationBatch | null;
  sensitivity: SensitivityResult[] | null;
  phase: string;
}

interface Particle {
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  progress: number;
  speed: number;
  sourceId: string;
}

export function NodeNetwork({ graph, batch, sensitivity, phase }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const particlesRef = useRef<Particle[]>([]);
  const timeRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      const rect = canvas.parentElement?.getBoundingClientRect();
      if (rect) {
        canvas.width = rect.width * window.devicePixelRatio;
        canvas.height = rect.height * window.devicePixelRatio;
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
        ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
      }
    };
    resize();
    window.addEventListener("resize", resize);

    const sensMap: Record<string, number> = {};
    if (sensitivity) {
      for (const s of sensitivity) {
        sensMap[s.nodeId] = s.varianceReduction;
      }
    }

    const draw = () => {
      const w = canvas.width / window.devicePixelRatio;
      const h = canvas.height / window.devicePixelRatio;

      ctx.clearRect(0, 0, w, h);
      timeRef.current += 0.016;

      if (!graph) {
        // Idle state — subtle grid pattern
        ctx.strokeStyle = "rgba(30, 41, 59, 0.3)";
        ctx.lineWidth = 1;
        for (let x = 0; x < w; x += 40) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, h);
          ctx.stroke();
        }
        for (let y = 0; y < h; y += 40) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();
        }
        animRef.current = requestAnimationFrame(draw);
        return;
      }

      const positions = layoutNodes(graph.nodes, w, h, sensMap);
      const outputNode = positions.find((p) => p.id === "__output__");

      // Draw connections (glowing lines)
      if (outputNode) {
        for (const pos of positions) {
          if (pos.id === "__output__") continue;

          ctx.beginPath();
          ctx.moveTo(pos.x, pos.y);
          ctx.lineTo(outputNode.x, outputNode.y);
          ctx.strokeStyle = `rgba(${hexToRgb(pos.color)}, 0.15)`;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }

      // Spawn particles when simulating
      if (phase === "simulating" && outputNode) {
        for (const pos of positions) {
          if (pos.id === "__output__") continue;
          if (Math.random() < 0.15) {
            particlesRef.current.push({
              x: pos.x,
              y: pos.y,
              targetX: outputNode.x,
              targetY: outputNode.y,
              progress: 0,
              speed: 0.01 + Math.random() * 0.02,
              sourceId: pos.id,
            });
          }
        }
      }

      // Draw and update particles
      const liveParticles: Particle[] = [];
      for (const p of particlesRef.current) {
        p.progress += p.speed;
        if (p.progress >= 1) continue;

        const px = p.x + (p.targetX - p.x) * p.progress;
        const py = p.y + (p.targetY - p.y) * p.progress;
        const alpha = 1 - p.progress;

        ctx.beginPath();
        ctx.arc(px, py, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(14, 165, 233, ${alpha * 0.8})`;
        ctx.fill();

        // Glow
        ctx.beginPath();
        ctx.arc(px, py, 6, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(14, 165, 233, ${alpha * 0.15})`;
        ctx.fill();

        liveParticles.push(p);
      }
      particlesRef.current = liveParticles.slice(-200); // cap particles

      // Draw nodes
      for (const pos of positions) {
        const pulse = Math.sin(timeRef.current * 3 + pos.x * 0.01) * 0.15 + 0.85;
        const glowRadius = pos.radius + pos.glowIntensity * 12 * pulse;

        // Outer glow
        const gradient = ctx.createRadialGradient(pos.x, pos.y, pos.radius * 0.5, pos.x, pos.y, glowRadius);
        gradient.addColorStop(0, `rgba(${hexToRgb(pos.color)}, 0.4)`);
        gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, glowRadius, 0, Math.PI * 2);
        ctx.fillStyle = gradient;
        ctx.fill();

        // Node circle
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, pos.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${hexToRgb(pos.color)}, 0.25)`;
        ctx.fill();
        ctx.strokeStyle = pos.color;
        ctx.lineWidth = 2;
        ctx.stroke();

        // Label
        const node = graph.nodes.find((n) => n.id === pos.id);
        const label = pos.id === "__output__" ? "OUTPUT" : (node?.name ?? pos.id);
        ctx.fillStyle = "#e2e8f0";
        ctx.font = "11px monospace";
        ctx.textAlign = "center";
        ctx.fillText(label, pos.x, pos.y + pos.radius + 16, pos.radius * 3);
      }

      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animRef.current);
      window.removeEventListener("resize", resize);
    };
  }, [graph, phase, sensitivity, batch]);

  return <canvas ref={canvasRef} className="w-full h-full" />;
}

function hexToRgb(hex: string): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return "255, 255, 255";
  return `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}`;
}
```

**Step 3: Commit**

```bash
git add components/panels/NodeNetwork.tsx lib/viz/node-layout.ts
git commit -m "feat: animated node network panel with particle flow and glow effects"
```

---

### Task 8: Live Distribution Panel (Canvas 2D)

**Files:**
- Create: `components/panels/LiveDistribution.tsx`

Draws histogram that builds progressively as batches arrive — the "Polaroid developing" effect.

**Step 1: Implement LiveDistribution.tsx**

The component accumulates samples across batches and redraws the histogram each frame, with the CI lines sweeping inward as convergence improves. Uses Canvas 2D with animated bar heights.

**Step 2: Commit**

```bash
git add components/panels/LiveDistribution.tsx
git commit -m "feat: live distribution panel with progressive histogram build"
```

---

### Task 9: Sensitivity Radar Panel (Canvas 2D)

**Files:**
- Create: `components/panels/SensitivityRadar.tsx`

Radar/spider chart where each axis is one uncertainty node. Arms extend in real-time. Pulsing "breathing" animation.

**Step 1: Implement SensitivityRadar.tsx**

Canvas-based radar chart that animates during simulation and freezes on final sensitivity values. Dark theme with cyan/emerald accents.

**Step 2: Commit**

```bash
git add components/panels/SensitivityRadar.tsx
git commit -m "feat: animated sensitivity radar panel"
```

---

### Task 10: Uncertainty Gauges Panel (Canvas 2D)

**Files:**
- Create: `components/panels/GaugePanel.tsx`

Four analog dial gauges: Confidence, Calibration, Convergence, Decision Clarity. Smooth needle animations like the EEG screenshot.

**Step 1: Implement GaugePanel.tsx**

Canvas-based circular gauges with smooth needle interpolation. Dark background, neon arc segments.

**Step 2: Commit**

```bash
git add components/panels/GaugePanel.tsx
git commit -m "feat: analog gauge panel with smooth needle animations"
```

---

### Task 11: Spectrum Bars Panel

**Files:**
- Create: `components/panels/SpectrumBars.tsx`

Horizontal bars like EEG frequency bands — one per node, mini-histograms filling in real-time.

**Step 1: Implement SpectrumBars.tsx**

**Step 2: Commit**

```bash
git add components/panels/SpectrumBars.tsx
git commit -m "feat: spectrum bars panel showing per-node distributions"
```

---

### Task 12: Wire All Panels Into Dashboard

**Files:**
- Modify: `app/page.tsx`

Replace placeholder panels with real components. Pass graph, batch, result, and sensitivity data through.

**Step 1: Update page.tsx to use real panel components**

**Step 2: End-to-end manual test**

```bash
npm run dev
```

1. Type a question in the input bar
2. Watch AI parse it (narration stream populates)
3. Node network animates with nodes appearing
4. Simulation starts — particles flow, distribution builds, radar extends, gauges spin up
5. Sensitivity results appear after completion
6. Verify all 6 panels update correctly

**Step 3: Commit**

```bash
git add app/page.tsx
git commit -m "feat: wire all 6 panels into live dashboard"
```

---

## Phase 4: Interactive Features

### Task 13: "What If" Node Editing

**Files:**
- Create: `components/NodeEditor.tsx`
- Modify: `app/page.tsx`

Click any node on the network → opens a slider panel where user can adjust mean/SD → re-runs simulation live. This is the "drag any node's distribution" feature.

**Step 1: Implement NodeEditor**

Modal/drawer with sliders for mean and SD. On change, creates modified graph and re-triggers simulation.

**Step 2: Commit**

```bash
git add components/NodeEditor.tsx
git commit -m "feat: interactive node editor for what-if analysis"
```

---

### Task 14: Model Selector

**Files:**
- Create: `components/ModelSelector.tsx`
- Modify: `app/page.tsx`

User selects which AI model to use via OpenRouter. Dropdown in the top bar.

**Step 1: Implement ModelSelector**

Dropdown with model options. Value passed to the /api/analyze route.

**Step 2: Commit**

```bash
git add components/ModelSelector.tsx
git commit -m "feat: AI model selector for user-chosen LLM via OpenRouter"
```

---

## Phase 5: Persistence & Calibration

### Task 15: Database Schema

**Files:**
- Create: `prisma/schema.prisma`

Models: Analysis (saved graphs + results), CalibrationOutcome (user-reported outcomes for Principle 4).

**Step 1: Define Prisma schema**

```prisma
model Analysis {
  id        String   @id @default(cuid())
  title     String
  domain    String
  question  String
  graphJson Json
  resultJson Json?
  createdAt DateTime @default(now())
  outcomes  CalibrationOutcome[]
}

model CalibrationOutcome {
  id           String   @id @default(cuid())
  analysisId   String
  analysis     Analysis @relation(fields: [analysisId], references: [id])
  predictedProb Float
  actualOutcome Boolean
  createdAt    DateTime @default(now())
}
```

**Step 2: Generate and push**

```bash
npx prisma generate
npx prisma db push
```

**Step 3: Commit**

```bash
git add prisma/
git commit -m "feat: database schema for saved analyses and calibration outcomes"
```

---

### Task 16: Save & Load API Routes

**Files:**
- Create: `app/api/analyses/route.ts`
- Create: `app/api/analyses/[id]/route.ts`
- Create: `app/api/calibration/route.ts`

CRUD for analyses. POST calibration outcomes. GET calibration data for reliability diagrams.

**Step 1: Implement routes**

**Step 2: Commit**

```bash
git add app/api/analyses/ app/api/calibration/
git commit -m "feat: API routes for saving analyses and recording calibration outcomes"
```

---

## Phase 6: Polish & Testing

### Task 17: Comprehensive Test Suite

**Files:**
- Create: `__tests__/integration/full-pipeline.test.ts`
- Add edge case tests to existing test files

Test the full pipeline: question → AI parse → graph → simulation → sensitivity → stats match expected ranges.

**Step 1: Write integration tests**

**Step 2: Run full test suite and ensure >90% coverage**

```bash
npm test -- --coverage
```

**Step 3: Create action plan for any gaps below 100%**

**Step 4: Commit**

```bash
git add __tests__/
git commit -m "test: comprehensive test suite with integration tests"
```

---

### Task 18: CSS Animations & Final Polish

**Files:**
- Modify: `app/globals.css`
- Modify: various component files

Add fadeIn animation keyframes, smooth transitions, and the dark EEG-style aesthetic across all panels.

**Step 1: Add animation utilities to globals.css**

```css
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
.animate-fadeIn {
  animation: fadeIn 0.3s ease-out;
}
```

**Step 2: Commit**

```bash
git add app/globals.css
git commit -m "style: dark theme animations and EEG-inspired visual polish"
```

---

### Task 19: Example Scenarios (Pre-built Templates)

**Files:**
- Create: `lib/examples.ts`
- Modify: `app/page.tsx` (add example buttons)

Include 5 pre-built example questions (one per domain) so users can see the system in action immediately without typing.

**Step 1: Define example scenarios**

```typescript
// lib/examples.ts
export const EXAMPLES = [
  { domain: "Clinical", question: "A 55-year-old male with chest pain and elevated D-dimer. What's the risk of pulmonary embolism?" },
  { domain: "Financial", question: "Should I invest in a Series B climate tech startup with $2M ARR growing 40% YoY? What's the probability of 5x return in 5 years?" },
  { domain: "Engineering", question: "We're building a bridge with 75-year design life over variable clay soil. What's the probability settlement exceeds 25mm?" },
  { domain: "Legal", question: "We have a patent infringement case with ambiguous prior art and moderately broad claims. Probability of favorable judgment?" },
  { domain: "Policy", question: "If we implement a $50/ton carbon tax, what's the probability of 30% emissions reduction by 2035?" },
];
```

**Step 2: Add example buttons to the input area**

**Step 3: Commit**

```bash
git add lib/examples.ts app/page.tsx
git commit -m "feat: pre-built example scenarios across 5 domains"
```

---

## Build Checklist Summary

| # | Task | Depends On | Validates |
|---|---|---|---|
| 1 | Initialize Next.js project | — | Dev server starts |
| 2 | Core type definitions | 1 | Types compile |
| 3 | Monte Carlo engine + tests | 2 | All engine tests pass, means match Python reference |
| 4 | Web Worker wrapper | 3 | Simulation streams batches |
| 5 | AI pipeline + API route | 2 | Parses natural language, returns valid graph JSON |
| 6 | Dashboard layout shell | 1 | 6-panel grid renders |
| 7 | Node Network panel | 6, 2 | Nodes animate with particles |
| 8 | Live Distribution panel | 6, 4 | Histogram builds progressively |
| 9 | Sensitivity Radar panel | 6, 3 | Radar animates and shows final sensitivity |
| 10 | Gauges panel | 6, 4 | 4 gauges with smooth needles |
| 11 | Spectrum Bars panel | 6, 4 | Per-node histograms fill live |
| 12 | Wire all panels | 7-11 | End-to-end: question → all panels animate |
| 13 | What-If node editing | 12 | Adjust node → dashboard re-runs |
| 14 | Model selector | 5 | User picks AI model |
| 15 | Database schema | 1 | Prisma generates, schema pushes |
| 16 | Save/Load + Calibration API | 15 | CRUD works, calibration records |
| 17 | Test suite | 3, 5 | >90% coverage |
| 18 | CSS polish | 12 | Dark EEG aesthetic |
| 19 | Example scenarios | 12 | 5 domain examples work end-to-end |
