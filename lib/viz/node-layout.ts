// ============================================================
// Node Layout Engine for Uncertainty Graph Visualization
// Force-directed layout calculator that positions nodes by group
// ============================================================

import type {
  UncertaintyGraph,
  UncertaintyNode,
  SensitivityResult,
} from "@/lib/types";

/** A positioned node ready for canvas rendering */
export interface PositionedNode {
  id: string;
  name: string;
  x: number;
  y: number;
  radius: number;
  color: string;
  /** 0-1, based on sensitivity contribution (varianceReduction) */
  glowIntensity: number;
}

/** A positioned edge with particle state for animation */
export interface PositionedEdge {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  method: string;
  particles: { x: number; y: number; progress: number }[];
}

/** Result of a single layout pass */
export interface LayoutResult {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
}

// ---- Color mapping based on node uncertainty ----

/** Maps node's coefficient of variation (sd/mean) to a color tier */
function uncertaintyColor(node: UncertaintyNode): string {
  const cv = node.mean !== 0 ? Math.abs(node.sd / node.mean) : 0;
  if (cv < 0.15) return "#3b82f6"; // blue  - low uncertainty
  if (cv < 0.40) return "#f59e0b"; // amber - medium uncertainty
  return "#ef4444";                 // red   - high uncertainty
}

// ---- Group classification ----

type GroupBucket = "left" | "center" | "right";

function classifyGroup(group: string | undefined): GroupBucket {
  if (!group) return "center";
  const g = group.toLowerCase();
  if (g.includes("pre_test") || g.includes("pretest") || g.includes("prior")) return "left";
  if (g.includes("test") || g.includes("diagnostic") || g.includes("likelihood")) return "right";
  return "center";
}

// ---- Particle initialization ----

const PARTICLES_PER_EDGE = 3;

function initParticles(): PositionedEdge["particles"] {
  const particles: PositionedEdge["particles"] = [];
  for (let i = 0; i < PARTICLES_PER_EDGE; i++) {
    particles.push({
      x: 0,
      y: 0,
      progress: i / PARTICLES_PER_EDGE,
    });
  }
  return particles;
}

// ---- Node radius sizing ----

function nodeRadius(node: UncertaintyNode, totalNodes: number): number {
  // Base radius scales down as graph gets larger
  const base = Math.max(14, Math.min(28, 220 / totalNodes));
  // Slightly enlarge nodes with higher SD (more uncertain = bigger)
  const cv = node.mean !== 0 ? Math.abs(node.sd / node.mean) : 0;
  return base * (1 + Math.min(cv, 1) * 0.3);
}

// ---- Sensitivity lookup ----

function glowForNode(
  nodeId: string,
  sensitivity: SensitivityResult[] | undefined | null
): number {
  if (!sensitivity || sensitivity.length === 0) return 0.3; // default subtle glow
  const entry = sensitivity.find((s) => s.nodeId === nodeId);
  if (!entry) return 0.1;
  // varianceReduction is already 0-1 (fraction of output variance)
  return Math.max(0.1, Math.min(1, entry.varianceReduction));
}

// ---- Layout entry point ----

/**
 * Computes a grouped columnar layout for the uncertainty graph.
 *
 * Left column  : pre_test / prior nodes
 * Center column: output / intermediate nodes
 * Right column : test / diagnostic / likelihood nodes
 *
 * Within each column, nodes are evenly distributed vertically.
 */
export function layoutGraph(
  graph: UncertaintyGraph,
  width: number,
  height: number,
  sensitivity?: SensitivityResult[] | null
): LayoutResult {
  if (!graph || graph.nodes.length === 0) {
    return { nodes: [], edges: [] };
  }

  const padding = 60;
  const usableWidth = width - padding * 2;
  const usableHeight = height - padding * 2;

  // ---- Bucket nodes by group ----
  const buckets: Record<GroupBucket, UncertaintyNode[]> = {
    left: [],
    center: [],
    right: [],
  };

  for (const node of graph.nodes) {
    // Output node always goes center
    if (node.id === graph.outputNodeId) {
      buckets.center.push(node);
    } else {
      buckets[classifyGroup(node.group)].push(node);
    }
  }

  // If only center has nodes (no group info), spread them in a circle instead
  const hasSideNodes = buckets.left.length > 0 || buckets.right.length > 0;

  // ---- Position map ----
  const posMap = new Map<string, { x: number; y: number }>();

  if (hasSideNodes) {
    // Columnar layout
    const columnXs: Record<GroupBucket, number> = {
      left: padding + usableWidth * 0.15,
      center: padding + usableWidth * 0.5,
      right: padding + usableWidth * 0.85,
    };

    for (const bucket of ["left", "center", "right"] as GroupBucket[]) {
      const nodes = buckets[bucket];
      if (nodes.length === 0) continue;
      const colX = columnXs[bucket];
      const spacingY = usableHeight / (nodes.length + 1);
      nodes.forEach((node, i) => {
        posMap.set(node.id, {
          x: colX,
          y: padding + spacingY * (i + 1),
        });
      });
    }
  } else {
    // Circular layout fallback when no group info
    const allNodes = graph.nodes;
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(usableWidth, usableHeight) * 0.35;

    allNodes.forEach((node, i) => {
      if (node.id === graph.outputNodeId) {
        // Output node at center
        posMap.set(node.id, { x: cx, y: cy });
      } else {
        const angle =
          (2 * Math.PI * i) / (allNodes.length - 1) - Math.PI / 2;
        posMap.set(node.id, {
          x: cx + Math.cos(angle) * radius,
          y: cy + Math.sin(angle) * radius,
        });
      }
    });
  }

  // ---- Build PositionedNode array ----
  const positionedNodes: PositionedNode[] = graph.nodes.map((node) => {
    const pos = posMap.get(node.id)!;
    return {
      id: node.id,
      name: node.name,
      x: pos.x,
      y: pos.y,
      radius: nodeRadius(node, graph.nodes.length),
      color: uncertaintyColor(node),
      glowIntensity: glowForNode(node.id, sensitivity),
    };
  });

  // ---- Build PositionedEdge array ----
  const positionedEdges: PositionedEdge[] = graph.edges.map((edge) => {
    const src = posMap.get(edge.source);
    const tgt = posMap.get(edge.target);
    if (!src || !tgt) {
      // Defensive: skip edges referencing missing nodes
      return {
        sourceX: 0,
        sourceY: 0,
        targetX: 0,
        targetY: 0,
        method: edge.method,
        particles: [],
      };
    }
    return {
      sourceX: src.x,
      sourceY: src.y,
      targetX: tgt.x,
      targetY: tgt.y,
      method: edge.method,
      particles: initParticles(),
    };
  });

  return { nodes: positionedNodes, edges: positionedEdges };
}
