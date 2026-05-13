"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import type {
  UncertaintyGraph,
  SensitivityResult,
  SimulationPhase,
} from "@/lib/types";
import {
  layoutGraph,
  type PositionedNode,
  type PositionedEdge,
  type LayoutResult,
} from "@/lib/viz/node-layout";

// ============================================================
// NodeNetwork - Canvas 2D animated uncertainty graph
// ============================================================

interface NodeNetworkProps {
  graph: UncertaintyGraph | null;
  sensitivity: SensitivityResult[] | null;
  phase: SimulationPhase;
  progress: number;
  onNodeClick?: (nodeId: string) => void;
}

// ---- Constants ----
const BG_COLOR = "#0a0e1a";
const GRID_COLOR = "rgba(59, 130, 246, 0.04)";
const TEXT_COLOR = "rgba(255, 255, 255, 0.85)";
const EDGE_COLOR = "rgba(255, 255, 255, 0.12)";
const PARTICLE_COLOR = "rgba(59, 130, 246, 0.9)";
const PARTICLE_RADIUS = 2.5;
const PARTICLE_SPEED = 0.004; // progress units per frame (~60fps)
const FONT_FAMILY = "'Inter', 'SF Pro Display', -apple-system, sans-serif";

// ---- Bezier helpers ----

/** Compute control point for a quadratic bezier curve between two points */
function controlPoint(
  sx: number,
  sy: number,
  tx: number,
  ty: number
): { cx: number; cy: number } {
  const mx = (sx + tx) / 2;
  const my = (sy + ty) / 2;
  const dx = tx - sx;
  const dy = ty - sy;
  // Perpendicular offset proportional to distance, capped
  const dist = Math.sqrt(dx * dx + dy * dy);
  const offset = Math.min(dist * 0.2, 40);
  // Always curve in one direction for consistent aesthetics
  return {
    cx: mx - (dy / dist) * offset,
    cy: my + (dx / dist) * offset,
  };
}

/** Evaluate position on quadratic bezier at t in [0,1] */
function bezierPoint(
  sx: number,
  sy: number,
  cx: number,
  cy: number,
  tx: number,
  ty: number,
  t: number
): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: u * u * sx + 2 * u * t * cx + t * t * tx,
    y: u * u * sy + 2 * u * t * cy + t * t * ty,
  };
}

// ---- Drawing functions ----

function drawBackground(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, w, h);

  // Subtle grid
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 1;
  const gridSize = 40;
  ctx.beginPath();
  for (let x = gridSize; x < w; x += gridSize) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let y = gridSize; y < h; y += gridSize) {
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
}

function drawEdge(ctx: CanvasRenderingContext2D, edge: PositionedEdge) {
  const { sourceX, sourceY, targetX, targetY } = edge;
  if (sourceX === 0 && sourceY === 0 && targetX === 0 && targetY === 0) return;

  const cp = controlPoint(sourceX, sourceY, targetX, targetY);

  ctx.strokeStyle = EDGE_COLOR;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(sourceX, sourceY);
  ctx.quadraticCurveTo(cp.cx, cp.cy, targetX, targetY);
  ctx.stroke();

  // Arrowhead at target end
  const arrowT = 0.92;
  const arrowPt = bezierPoint(sourceX, sourceY, cp.cx, cp.cy, targetX, targetY, arrowT);
  const tipPt = bezierPoint(sourceX, sourceY, cp.cx, cp.cy, targetX, targetY, 0.98);
  const angle = Math.atan2(tipPt.y - arrowPt.y, tipPt.x - arrowPt.x);
  const arrowLen = 8;
  const arrowSpread = 0.4;

  ctx.fillStyle = EDGE_COLOR;
  ctx.beginPath();
  ctx.moveTo(tipPt.x, tipPt.y);
  ctx.lineTo(
    tipPt.x - arrowLen * Math.cos(angle - arrowSpread),
    tipPt.y - arrowLen * Math.sin(angle - arrowSpread)
  );
  ctx.lineTo(
    tipPt.x - arrowLen * Math.cos(angle + arrowSpread),
    tipPt.y - arrowLen * Math.sin(angle + arrowSpread)
  );
  ctx.closePath();
  ctx.fill();
}

function drawParticles(
  ctx: CanvasRenderingContext2D,
  edge: PositionedEdge
) {
  const { sourceX, sourceY, targetX, targetY, particles } = edge;
  if (sourceX === 0 && sourceY === 0 && targetX === 0 && targetY === 0) return;
  if (particles.length === 0) return;

  const cp = controlPoint(sourceX, sourceY, targetX, targetY);

  for (const p of particles) {
    const pt = bezierPoint(sourceX, sourceY, cp.cx, cp.cy, targetX, targetY, p.progress);
    p.x = pt.x;
    p.y = pt.y;

    // Glowing particle
    const gradient = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, PARTICLE_RADIUS * 3);
    gradient.addColorStop(0, PARTICLE_COLOR);
    gradient.addColorStop(1, "rgba(59, 130, 246, 0)");

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, PARTICLE_RADIUS * 3, 0, Math.PI * 2);
    ctx.fill();

    // Solid core
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, PARTICLE_RADIUS * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawNode(ctx: CanvasRenderingContext2D, node: PositionedNode) {
  const { x, y, radius, color, glowIntensity, name } = node;

  // Outer glow
  const glowRadius = radius + 12 + glowIntensity * 18;
  const glow = ctx.createRadialGradient(x, y, radius * 0.5, x, y, glowRadius);
  glow.addColorStop(0, colorWithAlpha(color, 0.25 * glowIntensity));
  glow.addColorStop(1, colorWithAlpha(color, 0));

  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, glowRadius, 0, Math.PI * 2);
  ctx.fill();

  // Node body - filled circle with gradient
  const bodyGrad = ctx.createRadialGradient(
    x - radius * 0.3,
    y - radius * 0.3,
    0,
    x,
    y,
    radius
  );
  bodyGrad.addColorStop(0, lightenColor(color, 0.3));
  bodyGrad.addColorStop(1, color);

  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();

  // Border ring
  ctx.strokeStyle = colorWithAlpha(color, 0.6 + glowIntensity * 0.4);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, radius + 1, 0, Math.PI * 2);
  ctx.stroke();

  // Node name label below
  ctx.fillStyle = TEXT_COLOR;
  ctx.font = `11px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  // Truncate long names
  const maxLabelWidth = 100;
  let label = name;
  if (ctx.measureText(label).width > maxLabelWidth) {
    while (label.length > 3 && ctx.measureText(label + "...").width > maxLabelWidth) {
      label = label.slice(0, -1);
    }
    label += "...";
  }
  ctx.fillText(label, x, y + radius + 6);
}

function drawWaitingMessage(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, w, h);

  // Subtle grid
  drawBackground(ctx, w, h);

  // Pulsing text
  const alpha = 0.3 + Math.sin(Date.now() * 0.003) * 0.15;
  ctx.fillStyle = `rgba(148, 163, 184, ${alpha})`;
  ctx.font = `14px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("Waiting for analysis...", w / 2, h / 2);

  // Decorative ring
  const ringAlpha = 0.05 + Math.sin(Date.now() * 0.002) * 0.03;
  ctx.strokeStyle = `rgba(59, 130, 246, ${ringAlpha})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, 60, 0, Math.PI * 2);
  ctx.stroke();
}

// ---- Color utility helpers ----

function colorWithAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function lightenColor(hex: string, amount: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lr = Math.min(255, Math.round(r + (255 - r) * amount));
  const lg = Math.min(255, Math.round(g + (255 - g) * amount));
  const lb = Math.min(255, Math.round(b + (255 - b) * amount));
  return `rgb(${lr}, ${lg}, ${lb})`;
}

// ---- Component ----

export default function NodeNetwork({
  graph,
  sensitivity,
  phase,
  progress,
  onNodeClick,
}: NodeNetworkProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animFrameRef = useRef<number>(0);
  const layoutRef = useRef<LayoutResult | null>(null);
  const [dimensions, setDimensions] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  });

  // ---- Resize observer to fill container ----
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setDimensions({ w: Math.floor(width), h: Math.floor(height) });
        }
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // ---- Recompute layout when graph, sensitivity, or dimensions change ----
  useEffect(() => {
    if (!graph || dimensions.w === 0 || dimensions.h === 0) {
      layoutRef.current = null;
      return;
    }
    layoutRef.current = layoutGraph(
      graph,
      dimensions.w,
      dimensions.h,
      sensitivity
    );
  }, [graph, sensitivity, dimensions]);

  // ---- Animation loop ----
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Handle high-DPI displays
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.floor(dimensions.w * dpr) || canvas.height !== Math.floor(dimensions.h * dpr)) {
      canvas.width = Math.floor(dimensions.w * dpr);
      canvas.height = Math.floor(dimensions.h * dpr);
      canvas.style.width = `${dimensions.w}px`;
      canvas.style.height = `${dimensions.h}px`;
      ctx.scale(dpr, dpr);
    }

    const drawW = dimensions.w;
    const drawH = dimensions.h;

    const layout = layoutRef.current;

    if (!layout || !graph) {
      drawWaitingMessage(ctx, drawW, drawH);
      animFrameRef.current = requestAnimationFrame(render);
      return;
    }

    // Clear
    drawBackground(ctx, drawW, drawH);

    // Draw edges first (below nodes)
    for (const edge of layout.edges) {
      drawEdge(ctx, edge);
    }

    // Animate particles when running
    if (phase === "running") {
      for (const edge of layout.edges) {
        for (const p of edge.particles) {
          p.progress += PARTICLE_SPEED;
          if (p.progress > 1) p.progress -= 1;
        }
        drawParticles(ctx, edge);
      }
    } else if (phase === "complete") {
      // Show particles at rest (frozen positions)
      for (const edge of layout.edges) {
        drawParticles(ctx, edge);
      }
    }

    // Draw nodes on top
    for (const node of layout.nodes) {
      drawNode(ctx, node);
    }

    // Phase-specific overlay
    if (phase === "running" && progress > 0) {
      // Progress indicator - thin bar at bottom
      const barHeight = 3;
      const barY = drawH - barHeight;
      ctx.fillStyle = "rgba(59, 130, 246, 0.3)";
      ctx.fillRect(0, barY, drawW, barHeight);
      ctx.fillStyle = "rgba(59, 130, 246, 0.8)";
      ctx.fillRect(0, barY, drawW * progress, barHeight);
    }

    animFrameRef.current = requestAnimationFrame(render);
  }, [graph, phase, progress, dimensions]);

  // ---- Start / stop animation loop ----
  useEffect(() => {
    animFrameRef.current = requestAnimationFrame(render);
    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [render]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        overflow: "hidden",
        borderRadius: "8px",
        background: BG_COLOR,
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          width: dimensions.w || "100%",
          height: dimensions.h || "100%",
          cursor: graph && onNodeClick ? "pointer" : "default",
        }}
        onClick={(e) => {
          if (!onNodeClick || !layoutRef.current || !canvasRef.current) return;
          const rect = canvasRef.current.getBoundingClientRect();
          const dpr = window.devicePixelRatio || 1;
          const mx = (e.clientX - rect.left) * dpr;
          const my = (e.clientY - rect.top) * dpr;
          for (const node of layoutRef.current.nodes) {
            const dx = mx - node.x;
            const dy = my - node.y;
            if (dx * dx + dy * dy < node.radius * node.radius * 4) {
              onNodeClick(node.id);
              return;
            }
          }
        }}
      />
    </div>
  );
}
