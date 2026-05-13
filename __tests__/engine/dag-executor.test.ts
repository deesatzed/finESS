import { buildEdgeGroups, executeDAGSample } from "@/lib/engine/dag-executor";
import { PE_GRAPH } from "./test-fixtures";
import type { UncertaintyGraph } from "@/lib/types";

describe("buildEdgeGroups", () => {
  test("produces correct number of groups for PE graph", () => {
    const groups = buildEdgeGroups(PE_GRAPH);
    // Should have groups for: pre_test_composed, d_dimer_spec (subtractive), output
    expect(groups.length).toBe(3);
  });

  test("resolves in topological order", () => {
    const groups = buildEdgeGroups(PE_GRAPH);
    const order = groups.map((g) => g.targetId);
    // pre_test_composed and d_dimer_spec must come before output
    const outputIdx = order.indexOf("output");
    const preTestIdx = order.indexOf("pre_test_composed");
    const specIdx = order.indexOf("d_dimer_spec");
    expect(preTestIdx).toBeLessThan(outputIdx);
    expect(specIdx).toBeLessThan(outputIdx);
  });

  test("throws on cyclic graph", () => {
    const cyclic: UncertaintyGraph = {
      nodes: [
        { id: "a", name: "A", description: "", distribution: "normal", mean: 0.5, sd: 0.1, range: [0, 1], unit: "%" },
        { id: "b", name: "B", description: "", distribution: "normal", mean: 0.5, sd: 0.1, range: [0, 1], unit: "%" },
      ],
      edges: [
        { id: "e1", source: "a", target: "b", method: "additive" },
        { id: "e2", source: "b", target: "a", method: "additive" },
      ],
      outputNodeId: "a",
    };
    expect(() => buildEdgeGroups(cyclic)).toThrow("Cycle detected");
  });
});

describe("executeDAGSample", () => {
  test("computes correct Bayesian posterior for known inputs", () => {
    const edgeGroups = buildEdgeGroups(PE_GRAPH);

    // Use exact values matching the Python computation
    const nodeSamples: Record<string, number> = {
      pre_test_base: 0.18,
      patient_modifier: 0.04,
      comorbidity_adjust: 0.06,
      d_dimer_sens: 0.93,
      d_dimer_spec: 0.38,
      lab_variability: 0.03,
    };

    const result = executeDAGSample(nodeSamples, PE_GRAPH, edgeGroups);

    // Manual calculation:
    // pre = 0.18 + 0.04 + 0.06 = 0.28
    // spec = 0.38 - 0.03 = 0.35
    // denom = 0.28 * 0.93 + 0.72 * (1 - 0.35) = 0.2604 + 0.468 = 0.7284
    // post = (0.28 * 0.93) / 0.7284 = 0.2604 / 0.7284 ≈ 0.35750...
    expect(result).toBeCloseTo(0.3575, 3);
  });

  test("handles simple additive graph", () => {
    const simple: UncertaintyGraph = {
      nodes: [
        { id: "a", name: "A", description: "", distribution: "normal", mean: 0.3, sd: 0.1, range: [0, 1], unit: "%" },
        { id: "b", name: "B", description: "", distribution: "normal", mean: 0.2, sd: 0.1, range: [0, 1], unit: "%" },
      ],
      edges: [
        { id: "e1", source: "a", target: "output", method: "additive" },
        { id: "e2", source: "b", target: "output", method: "additive" },
      ],
      outputNodeId: "output",
    };

    const groups = buildEdgeGroups(simple);
    const result = executeDAGSample({ a: 0.3, b: 0.2 }, simple, groups);
    expect(result).toBeCloseTo(0.5, 4);
  });

  test("handles multiplicative graph", () => {
    const mult: UncertaintyGraph = {
      nodes: [
        { id: "a", name: "A", description: "", distribution: "normal", mean: 0.5, sd: 0.1, range: [0, 1], unit: "%" },
        { id: "b", name: "B", description: "", distribution: "normal", mean: 0.6, sd: 0.1, range: [0, 1], unit: "%" },
      ],
      edges: [
        { id: "e1", source: "a", target: "output", method: "multiplicative" },
        { id: "e2", source: "b", target: "output", method: "multiplicative" },
      ],
      outputNodeId: "output",
    };

    const groups = buildEdgeGroups(mult);
    const result = executeDAGSample({ a: 0.5, b: 0.6 }, mult, groups);
    expect(result).toBeCloseTo(0.3, 4);
  });
});
