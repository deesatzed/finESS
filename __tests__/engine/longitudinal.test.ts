import { runLongitudinalSimulation } from "@/lib/engine/longitudinal";
import { runSimulation } from "@/lib/engine/monte-carlo";
import { RecurrenceEvaluationError } from "@/lib/engine/recurrence";
import { PE_GRAPH } from "./test-fixtures";
import type {
  LongitudinalGraph,
  SimulationConfig,
  UncertaintyGraph,
  RecurrenceExpr,
} from "@/lib/types";

const baseConfig: SimulationConfig = {
  numSamples: 5000,
  batchSize: 500,
  seed: 42,
};

// ---------- helpers ----------

/**
 * Build a deterministic, single-node graph whose only node always
 * samples to `constant` (uniform distribution on a degenerate range).
 */
function constantNodeGraph(nodeId: string, constant: number): UncertaintyGraph {
  return {
    nodes: [
      {
        id: nodeId,
        name: nodeId,
        description: "deterministic constant",
        distribution: "uniform",
        mean: constant,
        sd: 0,
        range: [constant, constant],
        unit: "",
      },
    ],
    edges: [],
    outputNodeId: nodeId,
  };
}

// ---------- tests ----------

describe("runLongitudinalSimulation — basic invariants", () => {
  test("horizonSteps=1 with no recurrence updates matches single-shot headline", () => {
    // Same nodes/edges as PE_GRAPH, but wrapped as a longitudinal graph
    // with a no-op transition and the output state variable seeded from
    // a DAG run. We compare DAG-output samples between the two engines.
    const longGraph: LongitudinalGraph = {
      ...PE_GRAPH,
      horizonSteps: 1,
      stateTransition: {
        initialState: { dummy: 0 },
        recurrence: { updates: {} },
      },
      // outputStateVar is undefined → headline comes from DAG.
    };

    const single = runSimulation(PE_GRAPH, baseConfig);
    const longRes = runLongitudinalSimulation(longGraph, baseConfig);

    // Same seed + same nodes + horizon=1 → the per-step samples for the
    // single inner step are drawn from the same PRNG sequence, so means
    // should be very close. Allow 5% tolerance to be conservative.
    expect(Math.abs(longRes.mean - single.mean) / single.mean).toBeLessThan(0.05);
    expect(longRes.horizonSteps).toBe(1);
  });

  test("deterministic accumulator: 30 steps of constant addition", () => {
    const graph: LongitudinalGraph = {
      ...constantNodeGraph("c", 7),
      horizonSteps: 30,
      stateTransition: {
        initialState: { x: 100 },
        recurrence: {
          updates: {
            x: {
              kind: "add",
              left: { kind: "state", name: "x" },
              right: { kind: "sample", nodeId: "c" },
            },
          },
        },
      },
      outputStateVar: "x",
    };

    const res = runLongitudinalSimulation(graph, baseConfig);

    // Final value should be 100 + 30 * 7 = 310 exactly because the
    // single node is degenerate (uniform on [7, 7]).
    expect(res.mean).toBeCloseTo(310, 6);
    expect(res.ciLow).toBeCloseTo(310, 6);
    expect(res.ciHigh).toBeCloseTo(310, 6);
  });

  test("path trace length is exactly horizonSteps + 1", () => {
    const graph: LongitudinalGraph = {
      ...constantNodeGraph("c", 1),
      horizonSteps: 12,
      stateTransition: {
        initialState: { acc: 0 },
        recurrence: {
          updates: {
            acc: {
              kind: "add",
              left: { kind: "state", name: "acc" },
              right: { kind: "sample", nodeId: "c" },
            },
          },
        },
      },
      outputStateVar: "acc",
    };
    const res = runLongitudinalSimulation(graph, {
      numSamples: 100,
      batchSize: 100,
      seed: 1,
    });
    expect(res.pathTraces.acc.perStepMean.length).toBe(13);
    expect(res.pathTraces.acc.perStepCiLow.length).toBe(13);
    expect(res.pathTraces.acc.perStepCiHigh.length).toBe(13);
  });

  test("path trace index 0 equals the initialState value for every sample", () => {
    // Use a value that survives floating-point summation exactly so the
    // recovered mean is bit-equal to `initial`. Any number expressible
    // as p / 2^k with small p and k (e.g. 100, 0.5, 0.125) works because
    // the per-sample copies sum to n * initial without rounding.
    const initial = 100;
    const graph: LongitudinalGraph = {
      ...constantNodeGraph("c", 1),
      horizonSteps: 5,
      stateTransition: {
        initialState: { x: initial },
        recurrence: {
          updates: {
            x: {
              kind: "add",
              left: { kind: "state", name: "x" },
              right: { kind: "sample", nodeId: "c" },
            },
          },
        },
      },
      outputStateVar: "x",
    };
    const res = runLongitudinalSimulation(graph, {
      numSamples: 500,
      batchSize: 500,
      seed: 7,
    });
    // Mean is allowed to drift by a few ULPs; the percentile bounds use
    // sorted-index lookup and so are exactly the underlying value.
    expect(res.pathTraces.x.perStepMean[0]).toBeCloseTo(initial, 9);
    expect(res.pathTraces.x.perStepCiLow[0]).toBe(initial);
    expect(res.pathTraces.x.perStepCiHigh[0]).toBe(initial);
  });

  test("pure-additive accumulator with positive constant is monotonically increasing", () => {
    const graph: LongitudinalGraph = {
      ...constantNodeGraph("c", 2),
      horizonSteps: 20,
      stateTransition: {
        initialState: { acc: 0 },
        recurrence: {
          updates: {
            acc: {
              kind: "add",
              left: { kind: "state", name: "acc" },
              right: { kind: "sample", nodeId: "c" },
            },
          },
        },
      },
      outputStateVar: "acc",
    };
    const res = runLongitudinalSimulation(graph, baseConfig);
    const means = res.pathTraces.acc.perStepMean;
    for (let i = 1; i < means.length; i++) {
      expect(means[i]).toBeGreaterThan(means[i - 1]);
    }
  });

  test("per-step CI bounds bracket per-step mean at every step", () => {
    // Stochastic node, so the CI bounds will be meaningful (not equal to mean).
    const stochasticGraph: LongitudinalGraph = {
      nodes: [
        {
          id: "r",
          name: "r",
          description: "stochastic return",
          distribution: "normal",
          mean: 0.05,
          sd: 0.10,
          range: [-0.5, 0.5],
          unit: "",
        },
      ],
      edges: [],
      outputNodeId: "r",
      horizonSteps: 15,
      stateTransition: {
        initialState: { wealth: 1.0 },
        recurrence: {
          updates: {
            wealth: {
              kind: "multiply",
              left: { kind: "state", name: "wealth" },
              right: {
                kind: "add",
                left: { kind: "literal", value: 1 },
                right: { kind: "sample", nodeId: "r" },
              },
            },
          },
        },
      },
      outputStateVar: "wealth",
    };
    const res = runLongitudinalSimulation(stochasticGraph, baseConfig);
    const { perStepMean, perStepCiLow, perStepCiHigh } = res.pathTraces.wealth;
    for (let step = 0; step < perStepMean.length; step++) {
      expect(perStepCiLow[step]).toBeLessThanOrEqual(perStepMean[step]);
      expect(perStepMean[step]).toBeLessThanOrEqual(perStepCiHigh[step]);
    }
  });
});

describe("runLongitudinalSimulation — reproducibility", () => {
  test("same seed + same graph → identical samples and identical pathTraces", () => {
    const graph: LongitudinalGraph = {
      nodes: [
        {
          id: "r",
          name: "r",
          description: "stochastic return",
          distribution: "normal",
          mean: 0.07,
          sd: 0.15,
          range: [-0.5, 0.5],
          unit: "",
        },
      ],
      edges: [],
      outputNodeId: "r",
      horizonSteps: 10,
      stateTransition: {
        initialState: { wealth: 1_000_000 },
        recurrence: {
          updates: {
            wealth: {
              kind: "multiply",
              left: { kind: "state", name: "wealth" },
              right: {
                kind: "add",
                left: { kind: "literal", value: 1 },
                right: { kind: "sample", nodeId: "r" },
              },
            },
          },
        },
      },
      outputStateVar: "wealth",
    };
    const cfg: SimulationConfig = { numSamples: 1000, batchSize: 500, seed: 12345 };
    const r1 = runLongitudinalSimulation(graph, cfg);
    const r2 = runLongitudinalSimulation(graph, cfg);

    // Byte-for-byte equality on the sample vectors and the path traces.
    expect(r1.samples).toEqual(r2.samples);
    expect(r1.pathTraces).toEqual(r2.pathTraces);
    expect(r1.mean).toBe(r2.mean);
    expect(r1.ciLow).toBe(r2.ciLow);
    expect(r1.ciHigh).toBe(r2.ciHigh);
    expect(r1.seed).toBe(r2.seed);
  });

  test("generates and saves a random seed when none provided", () => {
    const graph: LongitudinalGraph = {
      ...constantNodeGraph("c", 1),
      horizonSteps: 2,
      stateTransition: {
        initialState: { x: 0 },
        recurrence: { updates: {} },
      },
      outputStateVar: "x",
    };
    const r1 = runLongitudinalSimulation(graph, { numSamples: 50, batchSize: 50 });
    const r2 = runLongitudinalSimulation(graph, { numSamples: 50, batchSize: 50 });
    expect(typeof r1.seed).toBe("number");
    expect(typeof r2.seed).toBe("number");
    expect(r1.seed).not.toBe(r2.seed);
  });
});

describe("runLongitudinalSimulation — validation", () => {
  const baseGraph: LongitudinalGraph = {
    ...constantNodeGraph("c", 1),
    horizonSteps: 5,
    stateTransition: {
      initialState: { x: 0 },
      recurrence: { updates: {} },
    },
    outputStateVar: "x",
  };

  test("throws on horizonSteps = 0", () => {
    expect(() =>
      runLongitudinalSimulation({ ...baseGraph, horizonSteps: 0 }, baseConfig)
    ).toThrow(/positive integer/);
  });

  test("throws on negative horizonSteps", () => {
    expect(() =>
      runLongitudinalSimulation({ ...baseGraph, horizonSteps: -3 }, baseConfig)
    ).toThrow(/positive integer/);
  });

  test("throws on non-integer horizonSteps", () => {
    expect(() =>
      runLongitudinalSimulation({ ...baseGraph, horizonSteps: 1.5 }, baseConfig)
    ).toThrow(/positive integer/);
  });

  test("throws when outputStateVar is not present in initialState", () => {
    const bad: LongitudinalGraph = {
      ...baseGraph,
      outputStateVar: "no_such_var",
    };
    expect(() => runLongitudinalSimulation(bad, baseConfig)).toThrow(
      /no_such_var/
    );
  });

  test("propagates RecurrenceEvaluationError when recurrence references an unknown node id", () => {
    const bad: LongitudinalGraph = {
      ...baseGraph,
      stateTransition: {
        initialState: { x: 0 },
        recurrence: {
          updates: {
            x: { kind: "sample", nodeId: "ghost_node" },
          },
        },
      },
    };
    expect(() => runLongitudinalSimulation(bad, baseConfig)).toThrow(
      RecurrenceEvaluationError
    );
  });

  test("propagates RecurrenceEvaluationError when recurrence references an unknown state var", () => {
    const bad: LongitudinalGraph = {
      ...baseGraph,
      stateTransition: {
        initialState: { x: 0 },
        recurrence: {
          updates: {
            x: { kind: "state", name: "missing" },
          },
        },
      },
    };
    expect(() => runLongitudinalSimulation(bad, baseConfig)).toThrow(
      /missing/
    );
  });
});

describe("runLongitudinalSimulation — hometier-style drawdown scenario", () => {
  test("5-step portfolio drawdown produces a final value within obvious bounds", () => {
    // Annual return ~ Normal(7%, 15.5%) clipped to [-30%, 50%].
    // Drawdown: state.portfolio = state.portfolio * (1 + return/100) - 50_000
    // This is real path-dependent logic — the single-shot DAG cannot
    // express it because each step depends on the prior step's wealth.
    const returnPct: RecurrenceExpr = {
      kind: "divide",
      left: { kind: "sample", nodeId: "return" },
      right: { kind: "literal", value: 100 },
    };
    const onePlusReturn: RecurrenceExpr = {
      kind: "add",
      left: { kind: "literal", value: 1 },
      right: returnPct,
    };
    const grownWealth: RecurrenceExpr = {
      kind: "multiply",
      left: { kind: "state", name: "portfolio" },
      right: onePlusReturn,
    };
    const drawdown: RecurrenceExpr = {
      kind: "subtract",
      left: grownWealth,
      right: { kind: "literal", value: 50_000 },
    };

    const graph: LongitudinalGraph = {
      nodes: [
        {
          id: "return",
          name: "Annual Return %",
          description: "Stochastic annual portfolio return as a percentage",
          distribution: "normal",
          mean: 7,
          sd: 15.5,
          range: [-30, 50],
          unit: "%",
        },
      ],
      edges: [],
      outputNodeId: "return",
      horizonSteps: 5,
      stateTransition: {
        initialState: { portfolio: 1_000_000 },
        recurrence: { updates: { portfolio: drawdown } },
      },
      outputStateVar: "portfolio",
    };

    const res = runLongitudinalSimulation(graph, {
      numSamples: 3000,
      batchSize: 500,
      seed: 99,
    });

    // 5 years of mean 7% growth on a $1M portfolio with $50k/year
    // withdrawals: expected drift is roughly $1M * (1.07)^5 minus
    // five years of compounded $50k draws — comfortably positive and
    // within an order of magnitude of the starting value. We assert
    // wide-but-meaningful bounds rather than pinning a specific number.
    expect(res.mean).toBeGreaterThan(500_000);
    expect(res.mean).toBeLessThan(1_500_000);

    // Path traces should also be well-formed.
    expect(res.pathTraces.portfolio.perStepMean.length).toBe(6);
    expect(res.pathTraces.portfolio.perStepMean[0]).toBe(1_000_000);

    // Per-step CI bounds must bracket per-step mean (path-dependent
    // wealth has nontrivial dispersion after a few years).
    const { perStepMean, perStepCiLow, perStepCiHigh } = res.pathTraces.portfolio;
    for (let step = 0; step < perStepMean.length; step++) {
      expect(perStepCiLow[step]).toBeLessThanOrEqual(perStepMean[step]);
      expect(perStepMean[step]).toBeLessThanOrEqual(perStepCiHigh[step]);
    }

    // Final-step mean must equal the headline mean (same source).
    expect(perStepMean[5]).toBeCloseTo(res.mean, 6);
  });
});
