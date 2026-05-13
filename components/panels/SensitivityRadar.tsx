"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import type { SensitivityResult, SimulationPhase } from "@/lib/types";

interface SensitivityRadarProps {
  sensitivity: SensitivityResult[] | null;
  phase: SimulationPhase;
}

type DisplayMode = "radar" | "tornado";

// ── Constants ────────────────────────────────────────────────────────
const BG = "#0a0e1a";
const GRID_COLOR = "rgba(148, 163, 184, 0.15)";
const GRID_LABEL_COLOR = "rgba(148, 163, 184, 0.5)";
const AXIS_COLOR = "rgba(148, 163, 184, 0.25)";
const LABEL_COLOR = "#cbd5e1";
const FILL_COLOR = "rgba(59, 130, 246, 0.376)";
const STROKE_COLOR = "rgba(59, 130, 246, 0.85)";
const BLUE_BAR = "#3b82f6";
const AMBER_BAR = "#f59e0b";
const TOGGLE_HINT_COLOR = "rgba(148, 163, 184, 0.4)";

const GRID_RINGS = [0.25, 0.5, 0.75, 1.0];
const PULSE_AMPLITUDE = 0.015;
const PULSE_SPEED = 0.0018;

// ── Helpers ──────────────────────────────────────────────────────────

function truncateLabel(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "\u2026";
}

function sortedBySensitivity(data: SensitivityResult[]): SensitivityResult[] {
  return [...data].sort((a, b) => b.varianceReduction - a.varianceReduction);
}

// ── Component ────────────────────────────────────────────────────────

export default function SensitivityRadar({
  sensitivity,
  phase,
}: SensitivityRadarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const [mode, setMode] = useState<DisplayMode>("radar");
  const [dpr, setDpr] = useState(1);

  // ── Resize observer to keep canvas sized to container ──
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const devicePixelRatio = window.devicePixelRatio || 1;
    setDpr(devicePixelRatio);

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        canvas.width = width * devicePixelRatio;
        canvas.height = height * devicePixelRatio;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // ── Draw: Radar ────────────────────────────────────────────────────
  const drawRadar = useCallback(
    (ctx: CanvasRenderingContext2D, w: number, h: number, t: number) => {
      const data = sensitivity;
      if (!data || data.length === 0) return;

      const n = data.length;
      const cx = w / 2;
      const cy = h / 2;
      const maxRadius = Math.min(w, h) * 0.34;
      const labelFont = `${Math.max(11 * dpr, 10)}px ui-monospace, "Geist Mono", monospace`;
      const ringFont = `${Math.max(9 * dpr, 8)}px ui-monospace, "Geist Mono", monospace`;

      // Breathing scale when running
      let scale = 1;
      if (phase === "running") {
        scale = 1 + PULSE_AMPLITUDE * Math.sin(t * PULSE_SPEED);
      }

      // Draw grid rings
      ctx.strokeStyle = GRID_COLOR;
      ctx.lineWidth = 1;
      for (const ring of GRID_RINGS) {
        const r = maxRadius * ring * scale;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();

        // Ring percentage label
        ctx.fillStyle = GRID_LABEL_COLOR;
        ctx.font = ringFont;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(`${Math.round(ring * 100)}%`, cx + 4, cy - r - 2);
      }

      // Draw axes
      const angleStep = (Math.PI * 2) / n;
      for (let i = 0; i < n; i++) {
        const angle = i * angleStep - Math.PI / 2; // start from top
        const axisEndX = cx + Math.cos(angle) * maxRadius * scale;
        const axisEndY = cy + Math.sin(angle) * maxRadius * scale;

        ctx.strokeStyle = AXIS_COLOR;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(axisEndX, axisEndY);
        ctx.stroke();

        // Labels
        const labelRadius = maxRadius * scale + 16 * dpr;
        const labelX = cx + Math.cos(angle) * labelRadius;
        const labelY = cy + Math.sin(angle) * labelRadius;

        ctx.fillStyle = LABEL_COLOR;
        ctx.font = labelFont;
        ctx.textBaseline = "middle";

        // Align based on angle quadrant
        const angleDeg = ((angle * 180) / Math.PI + 360) % 360;
        if (angleDeg > 85 && angleDeg < 275) {
          ctx.textAlign = "right";
        } else if (angleDeg >= 275 || angleDeg <= 85) {
          ctx.textAlign = "left";
        }
        if (angleDeg > 350 || angleDeg < 10) {
          ctx.textAlign = "center";
        }
        if (angleDeg > 170 && angleDeg < 190) {
          ctx.textAlign = "center";
        }
        // near top
        if (angleDeg > 260 && angleDeg < 280) {
          ctx.textAlign = "center";
        }

        const maxLabelChars = Math.max(8, Math.floor(w / (n * 8 * dpr)));
        ctx.fillText(truncateLabel(data[i].nodeName, maxLabelChars), labelX, labelY);
      }

      // Draw data polygon
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const angle = i * angleStep - Math.PI / 2;
        const val = Math.min(data[i].varianceReduction / 100, 1);
        const r = val * maxRadius * scale;
        const px = cx + Math.cos(angle) * r;
        const py = cy + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();

      ctx.fillStyle = FILL_COLOR;
      ctx.fill();

      ctx.strokeStyle = STROKE_COLOR;
      ctx.lineWidth = 2 * dpr;
      ctx.stroke();

      // Draw data points
      for (let i = 0; i < n; i++) {
        const angle = i * angleStep - Math.PI / 2;
        const val = Math.min(data[i].varianceReduction / 100, 1);
        const r = val * maxRadius * scale;
        const px = cx + Math.cos(angle) * r;
        const py = cy + Math.sin(angle) * r;

        ctx.beginPath();
        ctx.arc(px, py, 3 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = STROKE_COLOR;
        ctx.fill();
      }
    },
    [sensitivity, phase, dpr]
  );

  // ── Draw: Tornado ──────────────────────────────────────────────────
  const drawTornado = useCallback(
    (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      const data = sensitivity;
      if (!data || data.length === 0) return;

      const sorted = sortedBySensitivity(data);
      const n = sorted.length;

      const labelFont = `${Math.max(11 * dpr, 10)}px ui-monospace, "Geist Mono", monospace`;
      const valueFont = `${Math.max(10 * dpr, 9)}px ui-monospace, "Geist Mono", monospace`;
      const headerFont = `bold ${Math.max(11 * dpr, 10)}px ui-monospace, "Geist Mono", monospace`;

      const paddingTop = 40 * dpr;
      const paddingBottom = 20 * dpr;
      const paddingLeft = 10 * dpr;
      const paddingRight = 20 * dpr;

      // Measure the widest node name
      ctx.font = labelFont;
      let maxNameWidth = 0;
      for (const item of sorted) {
        const measured = ctx.measureText(truncateLabel(item.nodeName, 20)).width;
        if (measured > maxNameWidth) maxNameWidth = measured;
      }
      const nameSectionWidth = maxNameWidth + 12 * dpr;

      const chartLeft = paddingLeft + nameSectionWidth;
      const chartRight = w - paddingRight;
      const chartWidth = chartRight - chartLeft;

      const availableHeight = h - paddingTop - paddingBottom;
      const rowHeight = Math.min(availableHeight / n, 40 * dpr);
      const barHeight = rowHeight * 0.32;
      const barGap = 2 * dpr;

      // Find max value for scaling
      let maxVal = 0;
      for (const item of sorted) {
        if (item.varianceReduction > maxVal) maxVal = item.varianceReduction;
        if (item.ciWidthReduction > maxVal) maxVal = item.ciWidthReduction;
      }
      if (maxVal === 0) maxVal = 1;

      // Header legend
      ctx.font = headerFont;
      ctx.textBaseline = "top";

      // Blue legend square
      const legendY = 12 * dpr;
      ctx.fillStyle = BLUE_BAR;
      ctx.fillRect(chartLeft, legendY, 10 * dpr, 10 * dpr);
      ctx.fillStyle = LABEL_COLOR;
      ctx.textAlign = "left";
      ctx.fillText("Variance Reduction", chartLeft + 14 * dpr, legendY);

      const blueTextWidth = ctx.measureText("Variance Reduction").width;

      // Amber legend square
      const amberLegendX = chartLeft + 14 * dpr + blueTextWidth + 20 * dpr;
      ctx.fillStyle = AMBER_BAR;
      ctx.fillRect(amberLegendX, legendY, 10 * dpr, 10 * dpr);
      ctx.fillStyle = LABEL_COLOR;
      ctx.fillText("CI Width Reduction", amberLegendX + 14 * dpr, legendY);

      // Draw bars
      for (let i = 0; i < n; i++) {
        const item = sorted[i];
        const rowCenterY = paddingTop + i * rowHeight + rowHeight / 2;

        // Node name
        ctx.fillStyle = LABEL_COLOR;
        ctx.font = labelFont;
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(
          truncateLabel(item.nodeName, 20),
          chartLeft - 8 * dpr,
          rowCenterY
        );

        // Blue bar (varianceReduction)
        const blueBarWidth = (item.varianceReduction / maxVal) * chartWidth;
        const blueBarY = rowCenterY - barHeight - barGap / 2;
        ctx.fillStyle = BLUE_BAR;
        ctx.beginPath();
        roundedRect(ctx, chartLeft, blueBarY, blueBarWidth, barHeight, 2 * dpr);
        ctx.fill();

        // Blue value
        ctx.fillStyle = LABEL_COLOR;
        ctx.font = valueFont;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(
          `${item.varianceReduction.toFixed(1)}%`,
          chartLeft + blueBarWidth + 6 * dpr,
          blueBarY + barHeight / 2
        );

        // Amber bar (ciWidthReduction)
        const amberBarWidth = (item.ciWidthReduction / maxVal) * chartWidth;
        const amberBarY = rowCenterY + barGap / 2;
        ctx.fillStyle = AMBER_BAR;
        ctx.beginPath();
        roundedRect(ctx, chartLeft, amberBarY, amberBarWidth, barHeight, 2 * dpr);
        ctx.fill();

        // Amber value
        ctx.fillStyle = LABEL_COLOR;
        ctx.font = valueFont;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(
          `${item.ciWidthReduction.toFixed(1)}%`,
          chartLeft + amberBarWidth + 6 * dpr,
          amberBarY + barHeight / 2
        );

        // Separator line
        if (i < n - 1) {
          const separatorY = paddingTop + (i + 1) * rowHeight;
          ctx.strokeStyle = GRID_COLOR;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(paddingLeft, separatorY);
          ctx.lineTo(w - paddingRight, separatorY);
          ctx.stroke();
        }
      }
    },
    [sensitivity, dpr]
  );

  // ── Draw: Waiting placeholder ──────────────────────────────────────
  const drawWaiting = useCallback(
    (ctx: CanvasRenderingContext2D, w: number, h: number, t: number) => {
      const font = `${14 * dpr}px ui-monospace, "Geist Mono", monospace`;
      ctx.font = font;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      // Pulsing opacity
      const alpha = 0.35 + 0.2 * Math.sin(t * 0.002);
      ctx.fillStyle = `rgba(148, 163, 184, ${alpha})`;
      ctx.fillText("Waiting for analysis\u2026", w / 2, h / 2);
    },
    [dpr]
  );

  // ── Animation loop ─────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let running = true;

    const frame = (t: number) => {
      if (!running) return;

      const w = canvas.width;
      const h = canvas.height;

      // Clear
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, w, h);

      if (!sensitivity || sensitivity.length === 0) {
        drawWaiting(ctx, w, h, t);
      } else if (mode === "radar") {
        drawRadar(ctx, w, h, t);
      } else {
        drawTornado(ctx, w, h);
      }

      // Mode indicator in bottom-right corner
      const hintFont = `${Math.max(9 * dpr, 8)}px ui-monospace, "Geist Mono", monospace`;
      ctx.font = hintFont;
      ctx.fillStyle = TOGGLE_HINT_COLOR;
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";

      if (sensitivity && sensitivity.length > 0) {
        const label =
          mode === "radar"
            ? "Click for Tornado view"
            : "Click for Radar view";
        ctx.fillText(label, w - 10 * dpr, h - 8 * dpr);
      }

      rafRef.current = requestAnimationFrame(frame);
    };

    rafRef.current = requestAnimationFrame(frame);

    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [sensitivity, phase, mode, dpr, drawRadar, drawTornado, drawWaiting]);

  // ── Click handler ──────────────────────────────────────────────────
  const handleClick = useCallback(() => {
    if (!sensitivity || sensitivity.length === 0) return;
    setMode((prev) => (prev === "radar" ? "tornado" : "radar"));
  }, [sensitivity]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        background: BG,
        borderRadius: "8px",
        overflow: "hidden",
        cursor:
          sensitivity && sensitivity.length > 0 ? "pointer" : "default",
      }}
      onClick={handleClick}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
        }}
      />
    </div>
  );
}

// ── Canvas utility: rounded rectangle ────────────────────────────────
function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}
