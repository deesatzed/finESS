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
