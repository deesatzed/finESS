import { parseAIResponse } from "@/lib/ai/parse-response";

function build(overrides: {
  nodes?: unknown[];
  edges?: unknown[];
  outputNodeId?: string;
}): string {
  return JSON.stringify({
    nodes: overrides.nodes ?? [
      {
        id: "n1",
        name: "N1",
        description: "d",
        distribution: "beta",
        mean: 0.5,
        sd: 0.1,
        range: [0, 1],
        unit: "%",
      },
    ],
    edges: overrides.edges ?? [
      { id: "e1", source: "n1", target: "out", method: "additive" },
    ],
    outputNodeId: overrides.outputNodeId ?? "out",
  });
}

describe("parseAIResponse semantic validation", () => {
  test("rejects mean below range", () => {
    const bad = build({
      nodes: [
        {
          id: "n1",
          name: "N1",
          description: "d",
          distribution: "beta",
          mean: -0.1,
          sd: 0.05,
          range: [0, 1],
          unit: "%",
        },
      ],
    });
    expect(() => parseAIResponse(bad)).toThrow(/outside range/);
  });

  test("rejects mean above range", () => {
    const bad = build({
      nodes: [
        {
          id: "n1",
          name: "N1",
          description: "d",
          distribution: "beta",
          mean: 1.5,
          sd: 0.05,
          range: [0, 1],
          unit: "%",
        },
      ],
    });
    expect(() => parseAIResponse(bad)).toThrow(/outside range/);
  });

  test("rejects inverted range", () => {
    const bad = build({
      nodes: [
        {
          id: "n1",
          name: "N1",
          description: "d",
          distribution: "beta",
          mean: 0.5,
          sd: 0.1,
          range: [1, 0],
          unit: "%",
        },
      ],
    });
    expect(() => parseAIResponse(bad)).toThrow(/inverted range/);
  });

  test("rejects edge whose source is neither a declared node nor an edge target", () => {
    const bad = build({
      edges: [
        { id: "e1", source: "ghost", target: "out", method: "additive" },
      ],
    });
    expect(() => parseAIResponse(bad)).toThrow(/unknown source 'ghost'/);
  });

  test("accepts edge whose source is an intermediate (target of another edge)", () => {
    const ok = build({
      nodes: [
        {
          id: "leaf",
          name: "Leaf",
          description: "d",
          distribution: "beta",
          mean: 0.4,
          sd: 0.1,
          range: [0, 1],
          unit: "%",
        },
      ],
      edges: [
        { id: "e1", source: "leaf", target: "intermediate", method: "additive" },
        { id: "e2", source: "intermediate", target: "out", method: "additive" },
      ],
    });
    expect(() => parseAIResponse(ok)).not.toThrow();
  });

  test("rejects unreachable outputNodeId", () => {
    const bad = build({
      outputNodeId: "nowhere",
    });
    expect(() => parseAIResponse(bad)).toThrow(/unreachable/);
  });

  test("rejects bayesian_update target with only one bayesian_update edge", () => {
    const bad = build({
      nodes: [
        { id: "pre", name: "Pre", description: "d", distribution: "beta", mean: 0.2, sd: 0.05, range: [0, 1], unit: "%" },
        { id: "sens", name: "Sens", description: "d", distribution: "beta", mean: 0.9, sd: 0.02, range: [0, 1], unit: "%" },
      ],
      edges: [
        { id: "e1", source: "pre", target: "out", method: "additive" },
        { id: "e2", source: "sens", target: "out", method: "bayesian_update" },
      ],
    });
    expect(() => parseAIResponse(bad)).toThrow(/need at least 2 for sensitivity and specificity/);
  });

  test("rejects bayesian_update target with two bayes edges but no pre-test source", () => {
    const bad = build({
      nodes: [
        { id: "sens", name: "Sens", description: "d", distribution: "beta", mean: 0.9, sd: 0.02, range: [0, 1], unit: "%" },
        { id: "spec", name: "Spec", description: "d", distribution: "beta", mean: 0.4, sd: 0.05, range: [0, 1], unit: "%" },
      ],
      edges: [
        { id: "e1", source: "sens", target: "out", method: "bayesian_update" },
        { id: "e2", source: "spec", target: "out", method: "bayesian_update" },
      ],
    });
    expect(() => parseAIResponse(bad)).toThrow(/need additive pre-test edges or a third bayesian_update edge/);
  });

  test("accepts well-formed PE-style bayesian_update graph", () => {
    const ok = JSON.stringify({
      nodes: [
        { id: "pre_test_base", name: "Pre-test Base", description: "d", distribution: "beta", mean: 0.18, sd: 0.05, range: [0.05, 0.45], unit: "%" },
        { id: "d_dimer_sens", name: "Sens", description: "d", distribution: "beta", mean: 0.93, sd: 0.025, range: [0.82, 0.98], unit: "%" },
        { id: "d_dimer_spec", name: "Spec", description: "d", distribution: "beta", mean: 0.38, sd: 0.075, range: [0.20, 0.60], unit: "%" },
      ],
      edges: [
        { id: "e1", source: "pre_test_base", target: "output", method: "additive" },
        { id: "e2", source: "d_dimer_sens", target: "output", method: "bayesian_update" },
        { id: "e3", source: "d_dimer_spec", target: "output", method: "bayesian_update" },
      ],
      outputNodeId: "output",
    });
    expect(() => parseAIResponse(ok)).not.toThrow();
  });
});

describe("parseAIResponse triangular distribution (C1)", () => {
  function buildTriangular(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      nodes: [
        {
          id: "inflation",
          name: "Inflation",
          description: "annual inflation rate",
          distribution: "triangular",
          mean: 0.03,
          sd: 0.01,
          range: [0, 0.1],
          unit: "%",
          min: 0.018,
          mode: 0.028,
          max: 0.055,
          ...overrides,
        },
      ],
      edges: [{ id: "e1", source: "inflation", target: "out", method: "additive" }],
      outputNodeId: "out",
    });
  }

  test("accepts well-formed triangular node", () => {
    expect(() => parseAIResponse(buildTriangular())).not.toThrow();
  });

  test("preserves min/mode/max on parsed node", () => {
    const graph = parseAIResponse(buildTriangular());
    expect(graph.nodes[0].distribution).toBe("triangular");
    expect(graph.nodes[0].min).toBe(0.018);
    expect(graph.nodes[0].mode).toBe(0.028);
    expect(graph.nodes[0].max).toBe(0.055);
  });

  test("rejects triangular missing min", () => {
    expect(() => parseAIResponse(buildTriangular({ min: undefined }))).toThrow(
      /missing numeric min\/mode\/max/
    );
  });

  test("rejects triangular missing mode", () => {
    expect(() => parseAIResponse(buildTriangular({ mode: undefined }))).toThrow(
      /missing numeric min\/mode\/max/
    );
  });

  test("rejects triangular missing max", () => {
    expect(() => parseAIResponse(buildTriangular({ max: undefined }))).toThrow(
      /missing numeric min\/mode\/max/
    );
  });

  test("rejects mode < min", () => {
    expect(() =>
      parseAIResponse(buildTriangular({ min: 5, mode: 3, max: 10 }))
    ).toThrow(/min <= mode <= max/);
  });

  test("rejects mode > max", () => {
    expect(() =>
      parseAIResponse(buildTriangular({ min: 0, mode: 11, max: 10 }))
    ).toThrow(/min <= mode <= max/);
  });
});

describe("parseAIResponse Bernoulli mixture gate (C2)", () => {
  function buildGated(gate: unknown): string {
    return JSON.stringify({
      nodes: [
        {
          id: "repair",
          name: "Repair",
          description: "rare hit",
          distribution: "lognormal",
          mean: 1000,
          sd: 500,
          range: [0, 100000],
          unit: "$",
          gate,
        },
      ],
      edges: [{ id: "e1", source: "repair", target: "out", method: "additive" }],
      outputNodeId: "out",
    });
  }

  test("accepts a well-formed gate and preserves it", () => {
    const graph = parseAIResponse(buildGated({ probability: 0.12 }));
    expect(graph.nodes[0].gate).toEqual({ probability: 0.12 });
  });

  test("preserves inactiveValue when present", () => {
    const graph = parseAIResponse(buildGated({ probability: 0.5, inactiveValue: -1 }));
    expect(graph.nodes[0].gate).toEqual({ probability: 0.5, inactiveValue: -1 });
  });

  test("rejects probability outside [0, 1]", () => {
    expect(() => parseAIResponse(buildGated({ probability: -0.1 }))).toThrow(
      /must be in \[0, 1\]/
    );
    expect(() => parseAIResponse(buildGated({ probability: 1.5 }))).toThrow(
      /must be in \[0, 1\]/
    );
  });

  test("rejects non-numeric probability", () => {
    expect(() => parseAIResponse(buildGated({ probability: "high" }))).toThrow(
      /gate\.probability must be a finite number/
    );
  });

  test("rejects non-object gate", () => {
    expect(() => parseAIResponse(buildGated("on"))).toThrow(/invalid 'gate'/);
  });

  test("rejects non-numeric inactiveValue", () => {
    expect(() =>
      parseAIResponse(buildGated({ probability: 0.5, inactiveValue: "zero" }))
    ).toThrow(/inactiveValue must be a finite number/);
  });
});

describe("parseAIResponse impact tag (C4)", () => {
  function buildImpact(impact: unknown): string {
    return JSON.stringify({
      nodes: [
        {
          id: "n1",
          name: "N1",
          description: "test",
          distribution: "normal",
          mean: 1,
          sd: 0.1,
          range: [0, 10],
          unit: "%",
          impact,
        },
      ],
      edges: [{ id: "e1", source: "n1", target: "out", method: "additive" }],
      outputNodeId: "out",
    });
  }

  test("accepts and preserves all valid impact values", () => {
    for (const value of ["low", "medium", "high", "critical"]) {
      const graph = parseAIResponse(buildImpact(value));
      expect(graph.nodes[0].impact).toBe(value);
    }
  });

  test("rejects invalid impact strings", () => {
    expect(() => parseAIResponse(buildImpact("blocker"))).toThrow(/invalid impact/);
    expect(() => parseAIResponse(buildImpact("Critical"))).toThrow(/invalid impact/);
  });
});
