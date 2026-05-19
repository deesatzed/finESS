/**
 * C3b: performance budget for the longitudinal sampler.
 *
 * Canonical hometier-style workload: 10 nodes × 30 horizon steps × 15k
 * samples = 4.5M node samples per run, plus 30 × 15k = 450k recurrence
 * evaluations. This is the realistic upper bound for a retirement-style
 * model; if it breaks the budget, the engine has regressed and we want
 * CI to know about it before users do.
 *
 * Budget: 8 seconds wall-clock on the reference machine. Deliberately
 * loose: the goal is to catch regressions (a 10x slowdown would
 * obviously fail) without making the test flaky on slower CI runners.
 * Tighten the budget once the production deployment target is known.
 */

import { runLongitudinalSimulation } from "@/lib/engine/longitudinal";
import type { LongitudinalGraph, UncertaintyNode } from "@/lib/types";

const PERF_BUDGET_MS = 8_000;

function makeHometierGraph(): LongitudinalGraph {
  // Ten hometier-style nodes covering returns, inflation, healthcare,
  // disability cost, tax drag, longevity, rebalancing, spending creep,
  // home repair (gated), and market volatility. All distributions are
  // intentionally varied so the perf number reflects the full sampler
  // dispatch cost, not just one fast path.
  const nodes: UncertaintyNode[] = [
    {
      id: "ret",
      name: "Annual Return",
      description: "",
      distribution: "normal",
      mean: 0.07,
      sd: 0.155,
      range: [-0.5, 0.5],
      unit: "%",
    },
    {
      id: "inflation",
      name: "Inflation",
      description: "",
      distribution: "triangular",
      mean: 0.03,
      sd: 0.01,
      range: [0, 0.1],
      unit: "%",
      min: 0.018,
      mode: 0.028,
      max: 0.055,
    },
    {
      id: "healthcare",
      name: "Healthcare shock",
      description: "",
      distribution: "triangular",
      mean: 12000,
      sd: 5000,
      range: [-10000, 80000],
      unit: "$",
      min: -8000,
      mode: 12000,
      max: 65000,
    },
    {
      id: "disability",
      name: "Disability cost growth",
      description: "",
      distribution: "lognormal",
      mean: 0.068,
      sd: 0.042,
      range: [0, 0.5],
      unit: "%",
    },
    {
      id: "tax",
      name: "Tax drag",
      description: "",
      distribution: "normal",
      mean: 0.025,
      sd: 0.06,
      range: [-0.1, 0.2],
      unit: "%",
    },
    {
      id: "longevity",
      name: "Longevity",
      description: "",
      distribution: "normal",
      mean: 94,
      sd: 4.5,
      range: [70, 110],
      unit: "yrs",
    },
    {
      id: "rebalance",
      name: "Rebalancing drag",
      description: "",
      distribution: "triangular",
      mean: 0,
      sd: 0.01,
      range: [-0.02, 0.03],
      unit: "%",
      min: -0.012,
      mode: 0,
      max: 0.028,
    },
    {
      id: "spending_creep",
      name: "Spending creep",
      description: "",
      distribution: "normal",
      mean: 0.018,
      sd: 0.024,
      range: [-0.05, 0.1],
      unit: "%",
    },
    {
      id: "home_repair",
      name: "Major home repair",
      description: "",
      distribution: "lognormal",
      mean: 14500,
      sd: 9800,
      range: [0, 80000],
      unit: "$",
      gate: { probability: 0.12 },
    },
    {
      id: "ssi_change",
      name: "SSI policy change",
      description: "",
      distribution: "triangular",
      mean: 0,
      sd: 0.05,
      range: [-0.2, 0.1],
      unit: "%",
      min: -0.15,
      mode: 0,
      max: 0.08,
    },
  ];

  return {
    nodes,
    edges: [],
    outputNodeId: "ret",
    horizonSteps: 30,
    stateTransition: {
      initialState: { portfolio: 1_000_000 },
      recurrence: {
        updates: {
          portfolio: {
            kind: "subtract",
            left: {
              kind: "multiply",
              left: { kind: "state", name: "portfolio" },
              right: {
                kind: "add",
                left: { kind: "literal", value: 1 },
                right: { kind: "sample", nodeId: "ret" },
              },
            },
            right: { kind: "literal", value: 50_000 },
          },
        },
      },
    },
    outputStateVar: "portfolio",
  };
}

describe("longitudinal performance budget (C3b)", () => {
  test(`hometier-style 10 nodes × 30 steps × 15k samples completes under ${PERF_BUDGET_MS}ms`, () => {
    const graph = makeHometierGraph();
    const t0 = Date.now();
    const result = runLongitudinalSimulation(graph, {
      numSamples: 15_000,
      batchSize: 1_000,
      seed: 42,
    });
    const elapsed = Date.now() - t0;

    expect(result.samples).toHaveLength(15_000);
    expect(result.pathTraces.portfolio.perStepMean).toHaveLength(31);
    // Don't pin a specific dollar number — the graph is illustrative and the
    // exact mean depends on PRNG ordering. The bound check is "engine
    // produced finite output", which is what the budget assertion needs.
    expect(Number.isFinite(result.mean)).toBe(true);
    expect(elapsed).toBeLessThan(PERF_BUDGET_MS);
  }, 30_000); // jest timeout 30s to give margin above the 8s budget
});
