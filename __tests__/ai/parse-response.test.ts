import { parseAIResponse } from "@/lib/ai/parse-response";

const UNSUPPORTED_METHOD = ["cus", "tom"].join("");

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

  test("rejects unsupported custom edge method", () => {
    const bad = JSON.stringify({
      nodes: [
        { id: "a", name: "A", description: "d", distribution: "beta", mean: 0.5, sd: 0.1, range: [0, 1], unit: "%" },
      ],
      edges: [{ id: "e1", source: "a", target: "out", method: UNSUPPORTED_METHOD }],
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

  test("throws on non-object response (array)", () => {
    expect(() => parseAIResponse("[]")).toThrow("must be a JSON object");
  });

  test("throws on null response", () => {
    expect(() => parseAIResponse("null")).toThrow("must be a JSON object");
  });

  test("throws on missing edges array", () => {
    const bad = JSON.stringify({
      nodes: [
        { id: "a", name: "A", description: "d", distribution: "beta", mean: 0.5, sd: 0.1, range: [0, 1], unit: "%" },
      ],
      edges: [],
      outputNodeId: "out",
    });
    expect(() => parseAIResponse(bad)).toThrow("non-empty 'edges'");
  });

  test("throws when node is not an object", () => {
    const bad = JSON.stringify({
      nodes: ["not an object"],
      edges: [{ id: "e1", source: "a", target: "out", method: "additive" }],
      outputNodeId: "out",
    });
    expect(() => parseAIResponse(bad)).toThrow("must be an object");
  });

  test("throws on node with empty id", () => {
    const bad = JSON.stringify({
      nodes: [
        { id: "", name: "A", description: "d", distribution: "beta", mean: 0.5, sd: 0.1, range: [0, 1], unit: "%" },
      ],
      edges: [{ id: "e1", source: "a", target: "out", method: "additive" }],
      outputNodeId: "out",
    });
    expect(() => parseAIResponse(bad)).toThrow("non-empty 'id'");
  });

  test("throws on node without name", () => {
    const bad = JSON.stringify({
      nodes: [
        { id: "a", description: "d", distribution: "beta", mean: 0.5, sd: 0.1, range: [0, 1], unit: "%" },
      ],
      edges: [{ id: "e1", source: "a", target: "out", method: "additive" }],
      outputNodeId: "out",
    });
    expect(() => parseAIResponse(bad)).toThrow("'name' string");
  });

  test("throws on node without description", () => {
    const bad = JSON.stringify({
      nodes: [
        { id: "a", name: "A", distribution: "beta", mean: 0.5, sd: 0.1, range: [0, 1], unit: "%" },
      ],
      edges: [{ id: "e1", source: "a", target: "out", method: "additive" }],
      outputNodeId: "out",
    });
    expect(() => parseAIResponse(bad)).toThrow("'description' string");
  });

  test("throws on node without mean", () => {
    const bad = JSON.stringify({
      nodes: [
        { id: "a", name: "A", description: "d", distribution: "beta", sd: 0.1, range: [0, 1], unit: "%" },
      ],
      edges: [{ id: "e1", source: "a", target: "out", method: "additive" }],
      outputNodeId: "out",
    });
    expect(() => parseAIResponse(bad)).toThrow("numeric 'mean'");
  });

  test("throws on node with bad range", () => {
    const bad = JSON.stringify({
      nodes: [
        { id: "a", name: "A", description: "d", distribution: "beta", mean: 0.5, sd: 0.1, range: [0], unit: "%" },
      ],
      edges: [{ id: "e1", source: "a", target: "out", method: "additive" }],
      outputNodeId: "out",
    });
    expect(() => parseAIResponse(bad)).toThrow("'range' array");
  });

  test("throws on node without unit", () => {
    const bad = JSON.stringify({
      nodes: [
        { id: "a", name: "A", description: "d", distribution: "beta", mean: 0.5, sd: 0.1, range: [0, 1] },
      ],
      edges: [{ id: "e1", source: "a", target: "out", method: "additive" }],
      outputNodeId: "out",
    });
    expect(() => parseAIResponse(bad)).toThrow("'unit' string");
  });

  test("throws when edge is not an object", () => {
    const bad = JSON.stringify({
      nodes: [
        { id: "a", name: "A", description: "d", distribution: "beta", mean: 0.5, sd: 0.1, range: [0, 1], unit: "%" },
      ],
      edges: ["not an edge"],
      outputNodeId: "out",
    });
    expect(() => parseAIResponse(bad)).toThrow("must be an object");
  });

  test("throws on edge with empty id", () => {
    const bad = JSON.stringify({
      nodes: [
        { id: "a", name: "A", description: "d", distribution: "beta", mean: 0.5, sd: 0.1, range: [0, 1], unit: "%" },
      ],
      edges: [{ id: "", source: "a", target: "out", method: "additive" }],
      outputNodeId: "out",
    });
    expect(() => parseAIResponse(bad)).toThrow("non-empty 'id'");
  });

  test("throws on edge with empty source", () => {
    const bad = JSON.stringify({
      nodes: [
        { id: "a", name: "A", description: "d", distribution: "beta", mean: 0.5, sd: 0.1, range: [0, 1], unit: "%" },
      ],
      edges: [{ id: "e1", source: "", target: "out", method: "additive" }],
      outputNodeId: "out",
    });
    expect(() => parseAIResponse(bad)).toThrow("non-empty 'source'");
  });

  test("throws on edge with empty target", () => {
    const bad = JSON.stringify({
      nodes: [
        { id: "a", name: "A", description: "d", distribution: "beta", mean: 0.5, sd: 0.1, range: [0, 1], unit: "%" },
      ],
      edges: [{ id: "e1", source: "a", target: "", method: "additive" }],
      outputNodeId: "out",
    });
    expect(() => parseAIResponse(bad)).toThrow("non-empty 'target'");
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

  // M8-02: node provenance / source field
  test("defaults missing source to llm_prior", () => {
    const payload = JSON.stringify({
      nodes: [
        { id: "a", name: "A", description: "d", distribution: "beta", mean: 0.5, sd: 0.1, range: [0, 1], unit: "%" },
      ],
      edges: [{ id: "e1", source: "a", target: "out", method: "additive" }],
      outputNodeId: "out",
    });
    const graph = parseAIResponse(payload);
    expect(graph.nodes[0].source).toBe("llm_prior");
    expect(graph.nodes[0].sourceNote).toBeUndefined();
  });

  test("preserves source=literature when supplied with a sourceNote", () => {
    const payload = JSON.stringify({
      nodes: [
        {
          id: "a",
          name: "A",
          description: "d",
          distribution: "beta",
          mean: 0.5,
          sd: 0.1,
          range: [0, 1],
          unit: "%",
          source: "literature",
          sourceNote: "Smith et al. 2024, NEJM",
        },
      ],
      edges: [{ id: "e1", source: "a", target: "out", method: "additive" }],
      outputNodeId: "out",
    });
    const graph = parseAIResponse(payload);
    expect(graph.nodes[0].source).toBe("literature");
    expect(graph.nodes[0].sourceNote).toBe("Smith et al. 2024, NEJM");
  });

  test("preserves source=user_override when supplied", () => {
    const payload = JSON.stringify({
      nodes: [
        {
          id: "a",
          name: "A",
          description: "d",
          distribution: "beta",
          mean: 0.5,
          sd: 0.1,
          range: [0, 1],
          unit: "%",
          source: "user_override",
        },
      ],
      edges: [{ id: "e1", source: "a", target: "out", method: "additive" }],
      outputNodeId: "out",
    });
    const graph = parseAIResponse(payload);
    expect(graph.nodes[0].source).toBe("user_override");
  });

  test("coerces bogus source string to llm_prior", () => {
    const payload = JSON.stringify({
      nodes: [
        {
          id: "a",
          name: "A",
          description: "d",
          distribution: "beta",
          mean: 0.5,
          sd: 0.1,
          range: [0, 1],
          unit: "%",
          source: "expert_panel",
        },
      ],
      edges: [{ id: "e1", source: "a", target: "out", method: "additive" }],
      outputNodeId: "out",
    });
    const graph = parseAIResponse(payload);
    expect(graph.nodes[0].source).toBe("llm_prior");
  });

  test("coerces null source to llm_prior", () => {
    const payload = JSON.stringify({
      nodes: [
        {
          id: "a",
          name: "A",
          description: "d",
          distribution: "beta",
          mean: 0.5,
          sd: 0.1,
          range: [0, 1],
          unit: "%",
          source: null,
        },
      ],
      edges: [{ id: "e1", source: "a", target: "out", method: "additive" }],
      outputNodeId: "out",
    });
    const graph = parseAIResponse(payload);
    expect(graph.nodes[0].source).toBe("llm_prior");
  });

  test("preserves sourceNote when source is llm_prior", () => {
    const payload = JSON.stringify({
      nodes: [
        {
          id: "a",
          name: "A",
          description: "d",
          distribution: "beta",
          mean: 0.5,
          sd: 0.1,
          range: [0, 1],
          unit: "%",
          sourceNote: "model-suggested prior",
        },
      ],
      edges: [{ id: "e1", source: "a", target: "out", method: "additive" }],
      outputNodeId: "out",
    });
    const graph = parseAIResponse(payload);
    expect(graph.nodes[0].source).toBe("llm_prior");
    expect(graph.nodes[0].sourceNote).toBe("model-suggested prior");
  });
});
