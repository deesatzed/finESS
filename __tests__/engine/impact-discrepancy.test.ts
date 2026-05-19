import { findImpactDiscrepancies } from "@/lib/engine/impact-discrepancy";
import type { SensitivityResult, UncertaintyGraph } from "@/lib/types";

function makeGraph(
  nodes: Array<Partial<UncertaintyGraph["nodes"][number]> & { id: string; name: string }>
): UncertaintyGraph {
  return {
    nodes: nodes.map((n) => ({
      description: "test",
      distribution: "normal",
      mean: 1,
      sd: 0.1,
      range: [0, 10],
      unit: "%",
      ...n,
    })) as UncertaintyGraph["nodes"],
    edges: [],
    outputNodeId: "out",
  };
}

function makeSens(entries: Array<{ nodeId: string; varianceReduction: number }>): SensitivityResult[] {
  return entries.map((e) => ({
    nodeId: e.nodeId,
    nodeName: e.nodeId.toUpperCase(),
    varianceReduction: e.varianceReduction,
    ciWidthReduction: 0,
  }));
}

describe("findImpactDiscrepancies (C4)", () => {
  test("returns empty when no nodes have impact tags", () => {
    const graph = makeGraph([{ id: "a", name: "A" }]);
    const sens = makeSens([{ nodeId: "a", varianceReduction: 50 }]);
    expect(findImpactDiscrepancies(graph, sens)).toEqual([]);
  });

  test("returns empty when declared and measured align", () => {
    const graph = makeGraph([
      { id: "a", name: "A", impact: "critical" },
      { id: "b", name: "B", impact: "medium" },
      { id: "c", name: "C", impact: "low" },
    ]);
    const sens = makeSens([
      { nodeId: "a", varianceReduction: 60 },
      { nodeId: "b", varianceReduction: 15 },
      { nodeId: "c", varianceReduction: 3 },
    ]);
    expect(findImpactDiscrepancies(graph, sens)).toEqual([]);
  });

  test("flags overestimated impact (operator said critical, engine says low share)", () => {
    const graph = makeGraph([{ id: "a", name: "Disability cost", impact: "critical" }]);
    const sens = makeSens([{ nodeId: "a", varianceReduction: 3 }]);
    const out = findImpactDiscrepancies(graph, sens);
    expect(out).toHaveLength(1);
    expect(out[0].direction).toBe("overestimated");
    expect(out[0].declaredImpact).toBe("critical");
    expect(out[0].measuredVariancePct).toBe(3);
    expect(out[0].message).toMatch(/Disability cost/);
    expect(out[0].message).toMatch(/critical/);
    expect(out[0].message).toMatch(/3\.0%/);
  });

  test("flags underestimated impact (operator said low, engine says huge share)", () => {
    const graph = makeGraph([{ id: "a", name: "Tax drag", impact: "low" }]);
    const sens = makeSens([{ nodeId: "a", varianceReduction: 45 }]);
    const out = findImpactDiscrepancies(graph, sens);
    expect(out).toHaveLength(1);
    expect(out[0].direction).toBe("underestimated");
    expect(out[0].declaredImpact).toBe("low");
    expect(out[0].measuredVariancePct).toBe(45);
    expect(out[0].message).toMatch(/Consider raising/);
  });

  test("skips nodes without a sensitivity entry", () => {
    const graph = makeGraph([{ id: "a", name: "A", impact: "critical" }]);
    expect(findImpactDiscrepancies(graph, [])).toEqual([]);
  });

  test("flags only the nodes that disagree", () => {
    const graph = makeGraph([
      { id: "a", name: "A", impact: "critical" },
      { id: "b", name: "B", impact: "medium" },
    ]);
    const sens = makeSens([
      { nodeId: "a", varianceReduction: 50 }, // aligned
      { nodeId: "b", varianceReduction: 80 }, // medium tag but huge share
    ]);
    const out = findImpactDiscrepancies(graph, sens);
    expect(out).toHaveLength(1);
    expect(out[0].nodeId).toBe("b");
  });
});
