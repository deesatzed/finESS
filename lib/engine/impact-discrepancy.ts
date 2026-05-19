/**
 * C4: cross-reference operator-assigned `node.impact` against engine-computed
 * sensitivity to surface mismatches.
 *
 * The point is honest disagreement: if the operator flagged a node "critical"
 * but variance attribution says it only drives 3% of the output spread, the
 * operator either over-estimated importance OR the engine is missing a
 * structural effect. Either way, the user should see the mismatch — not have
 * the UI silently agree with one or the other.
 *
 * This is a pure derivation. No I/O, no side effects.
 */

import type { SensitivityResult, UncertaintyGraph } from "@/lib/types";

/**
 * Impact tag → expected approximate variance-reduction share (%).
 *
 * These are deliberately wide bands. They reflect "what an operator probably
 * meant by tagging this critical" — not a calibrated mapping. The point is
 * to catch wild mismatches (operator says critical, engine says 1%), not to
 * grade fine-grained accuracy.
 */
const IMPACT_EXPECTED_VARIANCE_PCT: Record<
  NonNullable<UncertaintyGraph["nodes"][number]["impact"]>,
  { min: number; max: number }
> = {
  low: { min: 0, max: 10 },
  medium: { min: 5, max: 30 },
  high: { min: 15, max: 60 },
  critical: { min: 30, max: 100 },
};

export interface ImpactDiscrepancy {
  nodeId: string;
  nodeName: string;
  /** What the operator tagged this node as. */
  declaredImpact: NonNullable<UncertaintyGraph["nodes"][number]["impact"]>;
  /** Engine-measured variance share for this node (%). */
  measuredVariancePct: number;
  /** Whether measured is below the declared band (over-estimated) or above (under-estimated). */
  direction: "overestimated" | "underestimated";
  /** Plain-language explanation suitable for direct UI display. */
  message: string;
}

/**
 * Find nodes where the operator's `impact` tag and the engine's sensitivity
 * disagree by more than the expected band. Returns one entry per
 * disagreement; empty array when everything aligns or no nodes carry an
 * impact tag.
 */
export function findImpactDiscrepancies(
  graph: UncertaintyGraph,
  sensitivity: SensitivityResult[]
): ImpactDiscrepancy[] {
  const byNodeId = new Map<string, SensitivityResult>();
  for (const s of sensitivity) {
    byNodeId.set(s.nodeId, s);
  }

  const out: ImpactDiscrepancy[] = [];
  for (const node of graph.nodes) {
    if (node.impact === undefined) continue;
    const s = byNodeId.get(node.id);
    if (s === undefined) continue;
    const expected = IMPACT_EXPECTED_VARIANCE_PCT[node.impact];
    const measured = s.varianceReduction;
    if (measured < expected.min) {
      out.push({
        nodeId: node.id,
        nodeName: node.name,
        declaredImpact: node.impact,
        measuredVariancePct: measured,
        direction: "overestimated",
        message: `You flagged ${node.name} as ${node.impact} impact, but sensitivity attributes only ${measured.toFixed(1)}% of output variance to it (expected at least ${expected.min}% for ${node.impact}). Either the engine is missing a structural effect, or the tag overstates importance.`,
      });
    } else if (measured > expected.max) {
      out.push({
        nodeId: node.id,
        nodeName: node.name,
        declaredImpact: node.impact,
        measuredVariancePct: measured,
        direction: "underestimated",
        message: `You flagged ${node.name} as ${node.impact} impact, but sensitivity attributes ${measured.toFixed(1)}% of output variance to it (more than the ${expected.max}% expected for ${node.impact}). Consider raising the impact tag.`,
      });
    }
  }
  return out;
}
