"use client";

import { useRef, useEffect, useCallback } from "react";
import type {
  UncertaintyGraph,
  SimulationPhase,
  DistributionType,
} from "@/lib/types";

interface SpectrumBarsProps {
  graph: UncertaintyGraph | null;
  nodeSamples: Record<string, number[]> | null;
  phase: SimulationPhase;
}

// ── Constants ─────────────────────────────────────────────────
const CANVAS_SCALE = 2;
const NUM_BINS = 30;
const LABEL_WIDTH_RATIO = 0.30; // 30% for labels
const HIST_WIDTH_RATIO = 0.70;  // 70% for histogram
const ROW_PADDING = 6;
const BAR_GAP = 1;
const HEADER_HEIGHT = 28;

// ── Distribution color map ────────────────────────────────────
const DIST_COLORS: Record<DistributionType, string> = {
  beta: "#3b82f6",
  normal: "#22c55e",
  uniform: "#a855f7",
  lognormal: "#f59e0b",
  triangular: "#ec4899",
};

// Dimmed variant for bar backgrounds
function dimColor(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Histogram computation ─────────────────────────────────────
function computeHistogram(
  samples: number[],
  rangeMin: number,
  rangeMax: number,
  numBins: number,
): number[] {
  const bins = new Array<number>(numBins).fill(0);
  if (samples.length === 0 || rangeMax <= rangeMin) return bins;

  const span = rangeMax - rangeMin;
  for (let i = 0; i < samples.length; i++) {
    const idx = Math.floor(((samples[i] - rangeMin) / span) * numBins);
    const clamped = Math.max(0, Math.min(numBins - 1, idx));
    bins[clamped]++;
  }
  return bins;
}

// ── Component ─────────────────────────────────────────────────

export default function SpectrumBars({
  graph,
  nodeSamples,
  phase,
}: SpectrumBarsProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafId = useRef<number>(0);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const rect = container.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    if (w === 0 || h === 0) return;

    canvas.width = w * CANVAS_SCALE;
    canvas.height = h * CANVAS_SCALE;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.scale(CANVAS_SCALE, CANVAS_SCALE);

    // Clear
    ctx.fillStyle = "#0a0e1a";
    ctx.fillRect(0, 0, w, h);

    // ── Panel title ──
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = "#64748b";
    ctx.font = `bold 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.fillText("NODE DISTRIBUTIONS", w / 2, 8);

    // ── No data placeholder ──
    if (!graph || !graph.nodes.length) {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#475569";
      ctx.font = `14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      ctx.fillText("Waiting for data...", w / 2, h / 2);
      return;
    }

    const nodes = graph.nodes;
    const numRows = nodes.length;
    const contentH = h - HEADER_HEIGHT;
    const rowHeight = Math.min(contentH / numRows, 60);
    const labelW = w * LABEL_WIDTH_RATIO;
    const histX = labelW;
    const histW = w * HIST_WIDTH_RATIO - 12; // right margin

    for (let rowIdx = 0; rowIdx < numRows; rowIdx++) {
      const node = nodes[rowIdx];
      const y = HEADER_HEIGHT + rowIdx * rowHeight;
      const barAreaTop = y + ROW_PADDING;
      const barAreaHeight = rowHeight - ROW_PADDING * 2;

      // ── Node label ──
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#cbd5e1";
      ctx.font = `12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      const truncatedName =
        node.name.length > 20 ? node.name.slice(0, 18) + "..." : node.name;
      ctx.fillText(truncatedName, labelW - 10, y + rowHeight / 2);

      // ── Distribution type indicator (small colored dot) ──
      const dotColor = DIST_COLORS[node.distribution] || "#64748b";
      ctx.beginPath();
      ctx.arc(labelW - node.name.length * 6.5 - 18, y + rowHeight / 2, 3, 0, Math.PI * 2);
      ctx.fillStyle = dotColor;
      ctx.fill();

      // ── Mini histogram ──
      const samples = nodeSamples?.[node.id];
      const color = DIST_COLORS[node.distribution] || "#64748b";

      if (!samples || samples.length === 0) {
        // Empty state: dim bars placeholder
        const binW = (histW - (NUM_BINS - 1) * BAR_GAP) / NUM_BINS;
        for (let b = 0; b < NUM_BINS; b++) {
          const bx = histX + b * (binW + BAR_GAP);
          ctx.fillStyle = "rgba(255,255,255,0.03)";
          ctx.fillRect(bx, barAreaTop, binW, barAreaHeight);
        }
        continue;
      }

      // Compute histogram bins
      const rangeMin = node.range[0];
      const rangeMax = node.range[1];
      const bins = computeHistogram(samples, rangeMin, rangeMax, NUM_BINS);
      const maxBin = Math.max(...bins, 1);

      const binW = (histW - (NUM_BINS - 1) * BAR_GAP) / NUM_BINS;

      for (let b = 0; b < NUM_BINS; b++) {
        const bx = histX + b * (binW + BAR_GAP);
        const fillRatio = bins[b] / maxBin;
        const barH = barAreaHeight * fillRatio;

        // Background track
        ctx.fillStyle = dimColor(color, 0.07);
        ctx.fillRect(bx, barAreaTop, binW, barAreaHeight);

        // Filled bar from bottom
        if (barH > 0) {
          ctx.fillStyle = dimColor(color, 0.25 + 0.55 * fillRatio);
          ctx.fillRect(bx, barAreaTop + barAreaHeight - barH, binW, barH);
        }
      }

      // ── Subtle row separator ──
      if (rowIdx < numRows - 1) {
        ctx.strokeStyle = "rgba(255,255,255,0.04)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(10, y + rowHeight);
        ctx.lineTo(w - 10, y + rowHeight);
        ctx.stroke();
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, nodeSamples]);

  // Redraw on data changes; keep animating during running phase
  useEffect(() => {
    cancelAnimationFrame(rafId.current);

    const loop = () => {
      draw();
      if (phase === "running") {
        rafId.current = requestAnimationFrame(loop);
      }
    };

    rafId.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId.current);
  }, [draw, phase]);

  // Handle container resize
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(rafId.current);
      rafId.current = requestAnimationFrame(draw);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [draw]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        background: "#0a0e1a",
        borderRadius: "8px",
        overflow: "hidden",
        position: "relative",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          position: "absolute",
          top: 0,
          left: 0,
        }}
      />
    </div>
  );
}
