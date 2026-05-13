"use client";

import { useRef, useEffect, useCallback } from "react";
import type {
  SimulationResult,
  SensitivityResult,
  SimulationPhase,
} from "@/lib/types";

interface GaugePanelProps {
  result: SimulationResult | null;
  sensitivity: SensitivityResult[] | null;
  phase: SimulationPhase;
  progress: number;
}

// ── Gauge geometry constants ──────────────────────────────────
const ARC_START_ANGLE = (7 / 6) * Math.PI; // 7 o'clock (210 deg from 3-o'clock)
const ARC_END_ANGLE = (2 * Math.PI) + (Math.PI * -1 / 6); // 5 o'clock (330 deg from 3-o'clock)
const ARC_SWEEP = ARC_END_ANGLE - ARC_START_ANGLE; // 240 degrees total

// Internal canvas resolution (2x for retina)
const CANVAS_SCALE = 2;

// ── Color helpers ─────────────────────────────────────────────

/** Interpolate from red (0) -> amber (0.5) -> green (1.0) */
function gaugeColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  if (clamped <= 0.5) {
    // red -> amber
    const p = clamped / 0.5;
    const r = 239;
    const g = Math.round(68 + (161) * p); // 68 -> 229
    const b = Math.round(68 - 34 * p);    // 68 -> 34
    return `rgb(${r},${g},${b})`;
  }
  // amber -> green
  const p = (clamped - 0.5) / 0.5;
  const r = Math.round(239 - 205 * p); // 239 -> 34
  const g = Math.round(229 - 32 * p);  // 229 -> 197
  const b = Math.round(34 + 60 * p);   // 34 -> 94
  return `rgb(${r},${g},${b})`;
}

// ── Gauge definitions ─────────────────────────────────────────

interface GaugeDef {
  label: string;
  compute: (
    result: SimulationResult | null,
    sensitivity: SensitivityResult[] | null,
    phase: SimulationPhase,
    progress: number,
  ) => number;
}

const GAUGES: GaugeDef[] = [
  {
    label: "Confidence",
    compute: (result) => {
      if (!result) return 0;
      const ciWidth = result.ciHigh - result.ciLow;
      // maxPossibleWidth is 1.0 for probability outputs [0,1]
      const maxPossibleWidth = 1.0;
      return Math.max(0, Math.min(1, 1 - ciWidth / maxPossibleWidth));
    },
  },
  {
    label: "Convergence",
    compute: (result, _sens, phase, progress) => {
      if (phase === "complete") return 1.0;
      if (phase === "running") return Math.max(0, Math.min(1, progress));
      return 0;
    },
  },
  {
    label: "Decision Clarity",
    compute: (result) => {
      if (!result) return 0;
      // How far the mean is from the threshold (default 0.5 if no threshold)
      // Decision clarity: further from threshold = clearer decision
      const threshold = 0.5;
      return Math.max(0, Math.min(1, Math.abs(result.mean - threshold) / 0.5));
    },
  },
  {
    label: "Information Value",
    compute: (_result, sensitivity) => {
      if (!sensitivity || sensitivity.length === 0) return 0;
      const maxReduction = Math.max(...sensitivity.map((s) => s.ciWidthReduction));
      return Math.max(0, Math.min(1, maxReduction / 100));
    },
  },
];

// ── Drawing helpers ───────────────────────────────────────────

function drawGauge(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  value: number, // animated current value 0..1
  label: string,
) {
  const arcRadius = radius * 0.78;
  const arcWidth = radius * 0.13;

  // ── Background track ──
  ctx.beginPath();
  ctx.arc(cx, cy, arcRadius, ARC_START_ANGLE, ARC_END_ANGLE);
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = arcWidth;
  ctx.lineCap = "round";
  ctx.stroke();

  // ── Colored arc segments (gradient approximation via many small arcs) ──
  const segments = 60;
  const valueAngle = ARC_START_ANGLE + ARC_SWEEP * value;
  for (let i = 0; i < segments; i++) {
    const t0 = i / segments;
    const t1 = (i + 1) / segments;
    const a0 = ARC_START_ANGLE + ARC_SWEEP * t0;
    const a1 = ARC_START_ANGLE + ARC_SWEEP * t1;
    if (a0 > valueAngle) break;
    const clampedEnd = Math.min(a1, valueAngle);
    ctx.beginPath();
    ctx.arc(cx, cy, arcRadius, a0, clampedEnd);
    ctx.strokeStyle = gaugeColor(t0);
    ctx.lineWidth = arcWidth;
    ctx.lineCap = "butt";
    ctx.stroke();
  }

  // ── Tick marks ──
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const angle = ARC_START_ANGLE + ARC_SWEEP * t;
    const innerR = arcRadius - arcWidth * 0.5 - 2;
    const outerR = arcRadius - arcWidth * 0.5 - (i % 5 === 0 ? 10 : 6);
    ctx.beginPath();
    ctx.moveTo(cx + innerR * Math.cos(angle), cy + innerR * Math.sin(angle));
    ctx.lineTo(cx + outerR * Math.cos(angle), cy + outerR * Math.sin(angle));
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = i % 5 === 0 ? 2 : 1;
    ctx.stroke();
  }

  // ── Needle ──
  const needleAngle = ARC_START_ANGLE + ARC_SWEEP * value;
  const needleLength = arcRadius - arcWidth * 0.5 - 4;
  const needleBaseWidth = 4;

  // Needle shadow
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 6;
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 2;

  ctx.beginPath();
  // Triangular needle from center
  const tipX = cx + needleLength * Math.cos(needleAngle);
  const tipY = cy + needleLength * Math.sin(needleAngle);
  const perpAngle = needleAngle + Math.PI / 2;
  const baseX1 = cx + needleBaseWidth * Math.cos(perpAngle);
  const baseY1 = cy + needleBaseWidth * Math.sin(perpAngle);
  const baseX2 = cx - needleBaseWidth * Math.cos(perpAngle);
  const baseY2 = cy - needleBaseWidth * Math.sin(perpAngle);

  ctx.moveTo(tipX, tipY);
  ctx.lineTo(baseX1, baseY1);
  ctx.lineTo(baseX2, baseY2);
  ctx.closePath();
  ctx.fillStyle = "#e2e8f0";
  ctx.fill();
  ctx.restore();

  // Center cap
  ctx.beginPath();
  ctx.arc(cx, cy, 6, 0, Math.PI * 2);
  ctx.fillStyle = "#94a3b8";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fillStyle = "#cbd5e1";
  ctx.fill();

  // ── Numeric value ──
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#e2e8f0";
  ctx.font = `bold ${radius * 0.26}px "SF Mono", "Fira Code", monospace`;
  ctx.fillText(value.toFixed(2), cx, cy + radius * 0.28);

  // ── Label ──
  ctx.fillStyle = "#94a3b8";
  ctx.font = `${radius * 0.16}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.fillText(label, cx, cy + radius * 0.50);
}

// ── Component ─────────────────────────────────────────────────

export default function GaugePanel({
  result,
  sensitivity,
  phase,
  progress,
}: GaugePanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Animated needle values (current positions)
  const animatedValues = useRef<number[]>([0, 0, 0, 0]);
  // Target values
  const targetValues = useRef<number[]>([0, 0, 0, 0]);
  const rafId = useRef<number>(0);

  // Compute target values whenever inputs change
  useEffect(() => {
    targetValues.current = GAUGES.map((g) =>
      g.compute(result, sensitivity, phase, progress),
    );
  }, [result, sensitivity, phase, progress]);

  // Animation + drawing loop
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const rect = container.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    if (w === 0 || h === 0) {
      rafId.current = requestAnimationFrame(draw);
      return;
    }

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
    ctx.letterSpacing = "1.5px";
    ctx.fillText("SYSTEM GAUGES", w / 2, 8);

    // ── 2x2 grid ──
    const headerOffset = 28;
    const cellW = w / 2;
    const cellH = (h - headerOffset) / 2;
    const gaugeRadius = Math.min(cellW, cellH) * 0.42;

    // Smoothly animate needles toward targets
    const easing = 0.06;
    let needsRedraw = false;

    for (let i = 0; i < 4; i++) {
      const delta = targetValues.current[i] - animatedValues.current[i];
      if (Math.abs(delta) > 0.001) {
        animatedValues.current[i] += delta * easing;
        needsRedraw = true;
      } else {
        animatedValues.current[i] = targetValues.current[i];
      }

      const col = i % 2;
      const row = Math.floor(i / 2);
      const cx = cellW * col + cellW / 2;
      const cy = headerOffset + cellH * row + cellH / 2;

      drawGauge(
        ctx,
        cx,
        cy,
        gaugeRadius,
        animatedValues.current[i],
        GAUGES[i].label,
      );
    }

    // ── Subtle grid lines between gauges ──
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    ctx.lineWidth = 1;
    // Vertical divider
    ctx.beginPath();
    ctx.moveTo(w / 2, headerOffset + 10);
    ctx.lineTo(w / 2, h - 10);
    ctx.stroke();
    // Horizontal divider
    ctx.beginPath();
    ctx.moveTo(10, headerOffset + cellH);
    ctx.lineTo(w - 10, headerOffset + cellH);
    ctx.stroke();

    // Keep animating if values haven't converged, or if phase is running
    if (needsRedraw || phase === "running") {
      rafId.current = requestAnimationFrame(draw);
    }
  }, [phase]);

  // Kick off redraw whenever inputs change
  useEffect(() => {
    cancelAnimationFrame(rafId.current);
    rafId.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId.current);
  }, [result, sensitivity, phase, progress, draw]);

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
