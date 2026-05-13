import { parseAIResponse } from "@/lib/ai/parse-response";

const VALID_RESPONSE = JSON.stringify({
  nodes: [
    {
      id: "node_a",
      name: "Node A",
      description: "Test node",
      distribution: "beta",
      mean: 0.5,
      sd: 0.1,
      range: [0, 1],
      unit: "%",
    },
    {
      id: "node_b",
      name: "Node B",
      description: "Test node B",
      distribution: "normal",
      mean: 0.3,
      sd: 0.05,
      range: [0, 1],
      unit: "%",
    },
  ],
  edges: [
    {
      id: "e1",
      source: "node_a",
      target: "output",
      method: "additive",
    },
    {
      id: "e2",
      source: "node_b",
      target: "output",
      method: "additive",
    },
  ],
  outputNodeId: "output",
  threshold: 0.5,
  narration: "Test narration",
});

describe("parseAIResponse", () => {
  test("parses valid JSON response", () => {
    const graph = parseAIResponse(VALID_RESPONSE);
    expect(graph.nodes.length).toBe(2);
    expect(graph.edges.length).toBe(2);
    expect(graph.outputNodeId).toBe("output");
    expect(graph.threshold).toBe(0.5);
    expect(graph.narration).toBe("Test narration");
  });

  test("strips markdown code fences", () => {
    const wrapped = "```json\n" + VALID_RESPONSE + "\n```";
    const graph = parseAIResponse(wrapped);
    expect(graph.nodes.length).toBe(2);
  });

  test("handles fences without language tag", () => {
    const wrapped = "```\n" + VALID_RESPONSE + "\n```";
    const graph = parseAIResponse(wrapped);
    expect(graph.nodes.length).toBe(2);
  });

  test("throws on invalid JSON", () => {
    expect(() => parseAIResponse("not json")).toThrow("not valid JSON");
  });

  test("throws on empty nodes array", () => {
    const bad = JSON.stringify({ nodes: [], edges: [{ id: "e1", source: "a", target: "b", method: "additive" }], outputNodeId: "b" });
    expect(() => parseAIResponse(bad)).toThrow("non-empty 'nodes'");
  });

  test("throws on invalid distribution type", () => {
    const bad = JSON.stringify({
      nodes: [
        { id: "a", name: "A", description: "d", distribution: "poisson", mean: 1, sd: 0.5, range: [0, 5], unit: "%" },
      ],
      edges: [{ id: "e1", source: "a", target: "out", method: "additive" }],
      outputNodeId: "out",
    });
    expect(() => parseAIResponse(bad)).toThrow("invalid distribution");
  });

  test("throws on invalid edge method", () => {
    const bad = JSON.stringify({
      nodes: [
        { id: "a", name: "A", description: "d", distribution: "beta", mean: 0.5, sd: 0.1, range: [0, 1], unit: "%" },
      ],
      edges: [{ id: "e1", source: "a", target: "out", method: "convolution" }],
      outputNodeId: "out",
    });
    expect(() => parseAIResponse(bad)).toThrow("invalid method");
  });

  test("accepts subtractive edge method", () => {
    const valid = JSON.stringify({
      nodes: [
        { id: "a", name: "A", description: "d", distribution: "beta", mean: 0.5, sd: 0.1, range: [0, 1], unit: "%" },
        { id: "b", name: "B", description: "d", distribution: "normal", mean: 0.1, sd: 0.05, range: [0, 0.5], unit: "pp" },
      ],
      edges: [
        { id: "e1", source: "b", target: "a", method: "subtractive" },
        { id: "e2", source: "a", target: "out", method: "additive" },
      ],
      outputNodeId: "out",
    });
    const graph = parseAIResponse(valid);
    expect(graph.edges[0].method).toBe("subtractive");
  });

  test("accepts bayesian_update edge method", () => {
    const valid = JSON.stringify({
      nodes: [
        { id: "pre", name: "Pre", description: "d", distribution: "beta", mean: 0.2, sd: 0.05, range: [0, 1], unit: "%" },
        { id: "sens", name: "Sens", description: "d", distribution: "beta", mean: 0.9, sd: 0.03, range: [0.8, 1], unit: "%" },
        { id: "spec", name: "Spec", description: "d", distribution: "beta", mean: 0.4, sd: 0.08, range: [0.2, 0.6], unit: "%" },
      ],
      edges: [
        { id: "e1", source: "pre", target: "output", method: "additive" },
        { id: "e2", source: "sens", target: "output", method: "bayesian_update" },
        { id: "e3", source: "spec", target: "output", method: "bayesian_update" },
      ],
      outputNodeId: "output",
    });
    const graph = parseAIResponse(valid);
    expect(graph.edges.filter((e) => e.method === "bayesian_update").length).toBe(2);
  });

  test("throws on negative SD", () => {
    const bad = JSON.stringify({
      nodes: [
        { id: "a", name: "A", description: "d", distribution: "beta", mean: 0.5, sd: -0.1, range: [0, 1], unit: "%" },
      ],
      edges: [{ id: "e1", source: "a", target: "out", method: "additive" }],
      outputNodeId: "out",
    });
    expect(() => parseAIResponse(bad)).toThrow("positive 'sd'");
  });

  test("throws on missing outputNodeId", () => {
    const bad = JSON.stringify({
      nodes: [
        { id: "a", name: "A", description: "d", distribution: "beta", mean: 0.5, sd: 0.1, range: [0, 1], unit: "%" },
      ],
      edges: [{ id: "e1", source: "a", target: "out", method: "additive" }],
    });
    expect(() => parseAIResponse(bad)).toThrow("outputNodeId");
  });

  test("optional fields default correctly", () => {
    const minimal = JSON.stringify({
      nodes: [
        { id: "a", name: "A", description: "d", distribution: "beta", mean: 0.5, sd: 0.1, range: [0, 1], unit: "%" },
      ],
      edges: [{ id: "e1", source: "a", target: "out", method: "additive" }],
      outputNodeId: "out",
    });
    const graph = parseAIResponse(minimal);
    expect(graph.threshold).toBeUndefined();
    expect(graph.narration).toBeUndefined();
  });
});
