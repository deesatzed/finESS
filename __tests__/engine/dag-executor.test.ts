import {
  buildEdgeGroups,
  executeDAGSample,
  DAGExecutionError,
} from "@/lib/engine/dag-executor";
import { PE_GRAPH } from "./test-fixtures";
import type { UncertaintyGraph } from "@/lib/types";

const UNSUPPORTED_METHOD = ["cus", "tom"].join("");

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
  test("throws on unsupported edge methods instead of silently composing", () => {
    const graph: UncertaintyGraph = {
      nodes: [
        { id: "a", name: "A", description: "", distribution: "normal", mean: 0.3, sd: 0.1, range: [0, 1], unit: "%" },
      ],
      edges: [
        { id: "e1", source: "a", target: "output", method: UNSUPPORTED_METHOD as never },
      ],
      outputNodeId: "output",
    };

    const groups = buildEdgeGroups(graph);

    expect(() => executeDAGSample({ a: 0.3 }, graph, groups)).toThrow(
      "Unsupported edge method"
    );
  });

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
    // post = (0.28 * 0.93) / 0.7284 = 0.2604 / 0.7284 ~= 0.35750...
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

  test("bayesian update without additive pre-test edges", () => {
    // When there are no additive edges, the first bayesian source becomes pre-test
    const bayesOnly: UncertaintyGraph = {
      nodes: [
        { id: "pre", name: "Pre", description: "", distribution: "beta", mean: 0.2, sd: 0.05, range: [0, 1], unit: "%" },
        { id: "sens", name: "Sens", description: "", distribution: "beta", mean: 0.9, sd: 0.03, range: [0, 1], unit: "%" },
        { id: "spec", name: "Spec", description: "", distribution: "beta", mean: 0.4, sd: 0.08, range: [0, 1], unit: "%" },
      ],
      edges: [
        { id: "e1", source: "pre", target: "output", method: "bayesian_update" },
        { id: "e2", source: "sens", target: "output", method: "bayesian_update" },
        { id: "e3", source: "spec", target: "output", method: "bayesian_update" },
      ],
      outputNodeId: "output",
    };

    const groups = buildEdgeGroups(bayesOnly);
    // pre=0.2, sens=0.9, spec=0.4 (no additive => first source is pre, second is sens, third is spec)
    const result = executeDAGSample({ pre: 0.2, sens: 0.9, spec: 0.4 }, bayesOnly, groups);
    // Manual: denom = 0.2*0.9 + 0.8*(1-0.4) = 0.18 + 0.48 = 0.66
    // post = 0.18 / 0.66 ~= 0.2727
    expect(result).toBeCloseTo(0.2727, 3);
  });

  test("bayesian update with 2 bayesian sources and no additive (uses 0.5 spec default)", () => {
    // When bayesSources.length === 2 and no additive: pre=first, sens=second, spec=0.5 default
    const twoBayes: UncertaintyGraph = {
      nodes: [
        { id: "pre", name: "Pre", description: "", distribution: "beta", mean: 0.3, sd: 0.05, range: [0, 1], unit: "%" },
        { id: "sens", name: "Sens", description: "", distribution: "beta", mean: 0.9, sd: 0.03, range: [0, 1], unit: "%" },
      ],
      edges: [
        { id: "e1", source: "pre", target: "output", method: "bayesian_update" },
        { id: "e2", source: "sens", target: "output", method: "bayesian_update" },
      ],
      outputNodeId: "output",
    };

    const groups = buildEdgeGroups(twoBayes);
    // pre=0.3, sens=0.9, spec defaults to 0.5
    const result = executeDAGSample({ pre: 0.3, sens: 0.9 }, twoBayes, groups);
    // denom = 0.3*0.9 + 0.7*(1-0.5) = 0.27 + 0.35 = 0.62
    // post = 0.27 / 0.62 ~= 0.4355
    expect(result).toBeCloseTo(0.4355, 3);
  });

  test("subtractive-only edges (no additive)", () => {
    const subOnly: UncertaintyGraph = {
      nodes: [
        { id: "base", name: "Base", description: "", distribution: "normal", mean: 0.8, sd: 0.1, range: [0, 1], unit: "%" },
        { id: "penalty", name: "Penalty", description: "", distribution: "normal", mean: 0.2, sd: 0.05, range: [0, 0.5], unit: "%" },
      ],
      edges: [
        { id: "e1", source: "penalty", target: "output", method: "subtractive" },
      ],
      outputNodeId: "output",
    };

    const groups = buildEdgeGroups(subOnly);
    // "output" is a synthetic intermediate (not a declared node), so base=0 by definition.
    // base=0, penalty=0.2, result = 0 - 0.2 = -0.2
    const result = executeDAGSample({ base: 0.8, penalty: 0.2 }, subOnly, groups);
    expect(result).toBeCloseTo(-0.2, 4);
  });

  test("subtractive edges where target has existing value", () => {
    // The target (d_dimer_spec) is a real node that already has a sampled value
    // This is the PE graph's subtractive pattern
    const edgeGroups = buildEdgeGroups(PE_GRAPH);
    const samples: Record<string, number> = {
      pre_test_base: 0.18,
      patient_modifier: 0.04,
      comorbidity_adjust: 0.06,
      d_dimer_sens: 0.93,
      d_dimer_spec: 0.40,
      lab_variability: 0.05,
    };
    const result = executeDAGSample(samples, PE_GRAPH, edgeGroups);
    // d_dimer_spec should be 0.40 - 0.05 = 0.35 after subtractive edge
    // Then bayesian update with pre=0.28, sens=0.93, spec=0.35
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(1);
  });

  test("mixed subtractive + additive edges to same target", () => {
    const mixed: UncertaintyGraph = {
      nodes: [
        { id: "a", name: "A", description: "", distribution: "normal", mean: 0.5, sd: 0.1, range: [0, 1], unit: "%" },
        { id: "b", name: "B", description: "", distribution: "normal", mean: 0.1, sd: 0.05, range: [0, 0.5], unit: "%" },
      ],
      edges: [
        { id: "e1", source: "a", target: "output", method: "additive" },
        { id: "e2", source: "b", target: "output", method: "subtractive" },
      ],
      outputNodeId: "output",
    };

    const groups = buildEdgeGroups(mixed);
    const result = executeDAGSample({ a: 0.5, b: 0.1 }, mixed, groups);
    // base=0, +0.5, -0.1 = 0.4
    expect(result).toBeCloseTo(0.4, 4);
  });
});

/**
 * R6-03 invariant enforcement: the engine throws DAGExecutionError on
 * missing source values and unset output rather than silently defaulting.
 * These tests document the new defensive boundary — replacing the prior
 * tests that documented the old silent-default behavior.
 */
describe("executeDAGSample invariant enforcement (R6-03)", () => {
  test("DAGExecutionError carries a typed code field", () => {
    const err = new DAGExecutionError("OUTPUT_NODE_UNSET", "msg");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DAGExecutionError);
    expect(err.code).toBe("OUTPUT_NODE_UNSET");
    expect(err.name).toBe("DAGExecutionError");
  });

  test("throws OUTPUT_NODE_UNSET when output node has no incoming edge", () => {
    // The edge targets "intermediate", not the declared outputNodeId "output".
    // After walking the DAG, values["output"] is undefined → engine must throw.
    const graph: UncertaintyGraph = {
      nodes: [
        { id: "a", name: "A", description: "", distribution: "normal", mean: 0.5, sd: 0.1, range: [0, 1], unit: "%" },
      ],
      edges: [
        { id: "e1", source: "a", target: "intermediate", method: "additive" },
      ],
      outputNodeId: "output",
    };

    const groups = buildEdgeGroups(graph);

    expect.assertions(3);
    try {
      executeDAGSample({ a: 0.5 }, graph, groups);
    } catch (e) {
      expect(e).toBeInstanceOf(DAGExecutionError);
      const err = e as DAGExecutionError;
      expect(err.code).toBe("OUTPUT_NODE_UNSET");
      expect(err.message).toMatch(/"output"/);
    }
  });

  test("throws MISSING_SOURCE_VALUE for additive edge whose source was not sampled", () => {
    const graph: UncertaintyGraph = {
      nodes: [
        { id: "a", name: "A", description: "", distribution: "normal", mean: 0.5, sd: 0.1, range: [0, 1], unit: "%" },
        { id: "b", name: "B", description: "", distribution: "normal", mean: 0.3, sd: 0.1, range: [0, 1], unit: "%" },
      ],
      edges: [
        { id: "edge-additive-a", source: "a", target: "output", method: "additive" },
        { id: "edge-additive-b", source: "b", target: "output", method: "additive" },
      ],
      outputNodeId: "output",
    };

    const groups = buildEdgeGroups(graph);

    expect.assertions(4);
    try {
      // Pass only 'a', missing 'b'
      executeDAGSample({ a: 0.5 }, graph, groups);
    } catch (e) {
      expect(e).toBeInstanceOf(DAGExecutionError);
      const err = e as DAGExecutionError;
      expect(err.code).toBe("MISSING_SOURCE_VALUE");
      // Error message must name both the missing source and the offending edge
      expect(err.message).toMatch(/"b"/);
      expect(err.message).toMatch(/edge-additive-b/);
    }
  });

  test("throws MISSING_SOURCE_VALUE for multiplicative edge whose source was not sampled", () => {
    const graph: UncertaintyGraph = {
      nodes: [
        { id: "a", name: "A", description: "", distribution: "normal", mean: 0.5, sd: 0.1, range: [0, 1], unit: "%" },
        { id: "b", name: "B", description: "", distribution: "normal", mean: 0.3, sd: 0.1, range: [0, 1], unit: "%" },
      ],
      edges: [
        { id: "mult-a", source: "a", target: "output", method: "multiplicative" },
        { id: "mult-b", source: "b", target: "output", method: "multiplicative" },
      ],
      outputNodeId: "output",
    };

    const groups = buildEdgeGroups(graph);

    expect.assertions(4);
    try {
      executeDAGSample({ a: 0.5 }, graph, groups);
    } catch (e) {
      expect(e).toBeInstanceOf(DAGExecutionError);
      const err = e as DAGExecutionError;
      expect(err.code).toBe("MISSING_SOURCE_VALUE");
      expect(err.message).toMatch(/"b"/);
      expect(err.message).toMatch(/mult-b/);
    }
  });

  test("throws MISSING_SOURCE_VALUE for bayesian_update edge whose source was not sampled", () => {
    // Mixed additive + bayesian — sens edge points at a node that wasn't sampled.
    const graph: UncertaintyGraph = {
      nodes: [
        { id: "pre", name: "Pre", description: "", distribution: "beta", mean: 0.3, sd: 0.05, range: [0, 1], unit: "%" },
        { id: "sens", name: "Sens", description: "", distribution: "beta", mean: 0.9, sd: 0.03, range: [0, 1], unit: "%" },
      ],
      edges: [
        { id: "additive-pre", source: "pre", target: "output", method: "additive" },
        { id: "bayes-sens", source: "sens", target: "output", method: "bayesian_update" },
      ],
      outputNodeId: "output",
    };

    const groups = buildEdgeGroups(graph);

    expect.assertions(4);
    try {
      // Only provide 'pre', missing 'sens'
      executeDAGSample({ pre: 0.3 }, graph, groups);
    } catch (e) {
      expect(e).toBeInstanceOf(DAGExecutionError);
      const err = e as DAGExecutionError;
      expect(err.code).toBe("MISSING_SOURCE_VALUE");
      expect(err.message).toMatch(/"sens"/);
      expect(err.message).toMatch(/bayes-sens/);
    }
  });

  test("throws MISSING_SOURCE_VALUE for bayesian_update edge in pure-bayesian graph (no additive)", () => {
    const graph: UncertaintyGraph = {
      nodes: [
        { id: "pre", name: "Pre", description: "", distribution: "beta", mean: 0.2, sd: 0.05, range: [0, 1], unit: "%" },
        { id: "sens", name: "Sens", description: "", distribution: "beta", mean: 0.9, sd: 0.03, range: [0, 1], unit: "%" },
        { id: "spec", name: "Spec", description: "", distribution: "beta", mean: 0.4, sd: 0.08, range: [0, 1], unit: "%" },
      ],
      edges: [
        { id: "b-pre", source: "pre", target: "output", method: "bayesian_update" },
        { id: "b-sens", source: "sens", target: "output", method: "bayesian_update" },
        { id: "b-spec", source: "spec", target: "output", method: "bayesian_update" },
      ],
      outputNodeId: "output",
    };

    const groups = buildEdgeGroups(graph);

    expect.assertions(3);
    try {
      // Missing 'spec'
      executeDAGSample({ pre: 0.2, sens: 0.9 }, graph, groups);
    } catch (e) {
      expect(e).toBeInstanceOf(DAGExecutionError);
      const err = e as DAGExecutionError;
      expect(err.code).toBe("MISSING_SOURCE_VALUE");
      expect(err.message).toMatch(/b-spec/);
    }
  });

  test("throws MISSING_SOURCE_VALUE for additive edge feeding a bayesian target", () => {
    // The additive composition that builds preTest is also required input.
    const graph: UncertaintyGraph = {
      nodes: [
        { id: "pre_a", name: "PreA", description: "", distribution: "normal", mean: 0.1, sd: 0.02, range: [0, 1], unit: "%" },
        { id: "pre_b", name: "PreB", description: "", distribution: "normal", mean: 0.1, sd: 0.02, range: [0, 1], unit: "%" },
        { id: "sens", name: "Sens", description: "", distribution: "beta", mean: 0.9, sd: 0.03, range: [0, 1], unit: "%" },
        { id: "spec", name: "Spec", description: "", distribution: "beta", mean: 0.4, sd: 0.08, range: [0, 1], unit: "%" },
      ],
      edges: [
        { id: "add-a", source: "pre_a", target: "output", method: "additive" },
        { id: "add-b", source: "pre_b", target: "output", method: "additive" },
        { id: "bayes-sens", source: "sens", target: "output", method: "bayesian_update" },
        { id: "bayes-spec", source: "spec", target: "output", method: "bayesian_update" },
      ],
      outputNodeId: "output",
    };

    const groups = buildEdgeGroups(graph);

    expect.assertions(3);
    try {
      // Missing 'pre_b'
      executeDAGSample({ pre_a: 0.1, sens: 0.9, spec: 0.4 }, graph, groups);
    } catch (e) {
      expect(e).toBeInstanceOf(DAGExecutionError);
      const err = e as DAGExecutionError;
      expect(err.code).toBe("MISSING_SOURCE_VALUE");
      expect(err.message).toMatch(/add-b/);
    }
  });

  test("throws MISSING_SOURCE_VALUE for subtractive edge whose source was not sampled", () => {
    const graph: UncertaintyGraph = {
      nodes: [
        { id: "penalty", name: "Penalty", description: "", distribution: "normal", mean: 0.1, sd: 0.05, range: [0, 0.5], unit: "%" },
      ],
      edges: [
        { id: "sub-penalty", source: "penalty", target: "output", method: "subtractive" },
      ],
      outputNodeId: "output",
    };

    const groups = buildEdgeGroups(graph);

    expect.assertions(3);
    try {
      // Sample map is empty — subtractive source 'penalty' missing.
      executeDAGSample({}, graph, groups);
    } catch (e) {
      expect(e).toBeInstanceOf(DAGExecutionError);
      const err = e as DAGExecutionError;
      expect(err.code).toBe("MISSING_SOURCE_VALUE");
      expect(err.message).toMatch(/sub-penalty/);
    }
  });

  test("throws MISSING_SOURCE_VALUE when a declared subtractive target was not sampled", () => {
    // d_dimer_spec is a declared node. If the caller forgets to sample it, the
    // engine treats the missing base as an invariant violation rather than
    // silently using 0.
    const graph: UncertaintyGraph = {
      nodes: [
        { id: "d_dimer_spec", name: "Spec", description: "", distribution: "beta", mean: 0.4, sd: 0.08, range: [0, 1], unit: "%" },
        { id: "lab_variability", name: "Lab", description: "", distribution: "normal", mean: 0.03, sd: 0.02, range: [0, 0.1], unit: "pp" },
      ],
      edges: [
        { id: "sub-lab", source: "lab_variability", target: "d_dimer_spec", method: "subtractive" },
      ],
      outputNodeId: "d_dimer_spec",
    };

    const groups = buildEdgeGroups(graph);

    expect.assertions(3);
    try {
      // Provide only lab_variability; the declared target d_dimer_spec is missing.
      executeDAGSample({ lab_variability: 0.03 }, graph, groups);
    } catch (e) {
      expect(e).toBeInstanceOf(DAGExecutionError);
      const err = e as DAGExecutionError;
      expect(err.code).toBe("MISSING_SOURCE_VALUE");
      expect(err.message).toMatch(/d_dimer_spec/);
    }
  });

  test("throws MISSING_SOURCE_VALUE when a sampled value is NaN", () => {
    // Defense in depth: NaN should be treated like missing rather than poisoning downstream math.
    const graph: UncertaintyGraph = {
      nodes: [
        { id: "a", name: "A", description: "", distribution: "normal", mean: 0.5, sd: 0.1, range: [0, 1], unit: "%" },
      ],
      edges: [
        { id: "add-a", source: "a", target: "output", method: "additive" },
      ],
      outputNodeId: "output",
    };

    const groups = buildEdgeGroups(graph);

    expect.assertions(2);
    try {
      executeDAGSample({ a: Number.NaN }, graph, groups);
    } catch (e) {
      expect(e).toBeInstanceOf(DAGExecutionError);
      const err = e as DAGExecutionError;
      expect(err.code).toBe("MISSING_SOURCE_VALUE");
    }
  });

  test("well-formed PE graph still executes identically after invariant enforcement", () => {
    // Regression guard: the existing golden Bayesian computation is unchanged.
    const edgeGroups = buildEdgeGroups(PE_GRAPH);
    const nodeSamples: Record<string, number> = {
      pre_test_base: 0.18,
      patient_modifier: 0.04,
      comorbidity_adjust: 0.06,
      d_dimer_sens: 0.93,
      d_dimer_spec: 0.38,
      lab_variability: 0.03,
    };
    const result = executeDAGSample(nodeSamples, PE_GRAPH, edgeGroups);
    expect(result).toBeCloseTo(0.3575, 3);
  });

  test("bayesian update with only 1 bayesian source raises OUTPUT_NODE_UNSET", () => {
    // bayesSources.length < 2 means the bayesian branch never writes the target,
    // so the output stays unset. Previously this silently returned 0; now it throws.
    const singleBayes: UncertaintyGraph = {
      nodes: [
        { id: "a", name: "A", description: "", distribution: "normal", mean: 0.5, sd: 0.1, range: [0, 1], unit: "%" },
      ],
      edges: [
        { id: "only-bayes", source: "a", target: "output", method: "bayesian_update" },
      ],
      outputNodeId: "output",
    };

    const groups = buildEdgeGroups(singleBayes);

    expect.assertions(2);
    try {
      executeDAGSample({ a: 0.5 }, singleBayes, groups);
    } catch (e) {
      expect(e).toBeInstanceOf(DAGExecutionError);
      const err = e as DAGExecutionError;
      expect(err.code).toBe("OUTPUT_NODE_UNSET");
    }
  });
});
