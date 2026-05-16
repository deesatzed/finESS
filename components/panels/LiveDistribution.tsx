"use client";

import { useRef, useEffect, useCallback } from "react";
import type { SimulationResult, SimulationPhase } from "@/lib/types";

// ============================================================
// LiveDistribution — Canvas 2D Progressive Histogram
// ============================================================

interface LiveDistributionProps {
  /** All samples accumulated so far */
  samples: number[];
  /** Final simulation result (available when phase === "complete") */
  result: SimulationResult | null;
  /** Current simulation phase */
  phase: SimulationPhase;
  /** Decision threshold for coloring bars above/below */
  threshold?: number;
}

// -- Constants ------------------------------------------------

const BG_COLOR = "#0a0e1a";
const BAR_COLOR_BELOW = "#3b82f6";
const BAR_COLOR_ABOVE = "#ef4444";
const CI_COLOR = "#f59e0b";
const MEAN_COLOR = "#ffffff";
const THRESHOLD_COLOR = "#ef4444";
const TEXT_COLOR = "#e2e8f0";
const MUTED_COLOR = "#64748b";
const NUM_BINS = 50;

/** Padding around the histogram area (px) */
const PAD = { top: 24, right: 140, bottom: 40, left: 56 };

/** Minimum opacity for bars (Polaroid developing effect) */
const MIN_OPACITY = 0.15;

/** Sample count at which bars reach full opacity */
const FULL_OPACITY_AT = 5000;

// -- Helpers --------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function computeStats(samples: number[]) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = samples.reduce((s, v) => s + v, 0);
  const mean = sum / samples.length;
  const ciLow = percentile(sorted, 2.5);
  const ciHigh = percentile(sorted, 97.5);
  return { mean, ciLow, ciHigh, sorted };
}

function buildHistogram(
  samples: number[],
  min: number,
  max: number,
  numBins: number
): number[] {
  const bins = new Array(numBins).fill(0);
  if (max === min) {
    // degenerate case: all samples identical
    bins[0] = samples.length;
    return bins;
  }
  const binWidth = (max - min) / numBins;
  for (const v of samples) {
    let idx = Math.floor((v - min) / binWidth);
    if (idx >= numBins) idx = numBins - 1;
    if (idx < 0) idx = 0;
    bins[idx]++;
  }
  return bins;
}

// -- Component ------------------------------------------------

export default function LiveDistribution({
  samples,
  result,
  phase,
  threshold,
}: LiveDistributionProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animFrameRef = useRef<number>(0);

  // We snapshot the samples array reference into a ref so the
  // rAF loop always reads the latest without re-subscribing.
  const samplesRef = useRef<number[]>(samples);
  samplesRef.current = samples;

  const resultRef = useRef<SimulationResult | null>(result);
  resultRef.current = result;

  const phaseRef = useRef<SimulationPhase>(phase);
  phaseRef.current = phase;

  const thresholdRef = useRef<number | undefined>(threshold);
  thresholdRef.current = threshold;

  // -- Resize observer ----------------------------------------

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = container.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    return () => observer.disconnect();
  }, []);

  // -- Draw function ------------------------------------------

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;

    // Clear
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, w, h);

    const currentSamples = samplesRef.current;
    const currentPhase = phaseRef.current;
    const currentResult = resultRef.current;
    const currentThreshold = thresholdRef.current;

    // -- Placeholder state ------------------------------------
    if (currentSamples.length === 0) {
      ctx.fillStyle = MUTED_COLOR;
      ctx.font = "14px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Waiting for data...", w / 2, h / 2);
      return;
    }

    // -- Compute statistics -----------------------------------
    const stats = computeStats(currentSamples);
    if (!stats) return;

    const { mean, ciLow, ciHigh, sorted } = stats;
    const dataMin = sorted[0];
    const dataMax = sorted[sorted.length - 1];

    // Expand range slightly so edge bars are visible
    const rangePad = (dataMax - dataMin) * 0.05 || 1;
    const rangeMin = dataMin - rangePad;
    const rangeMax = dataMax + rangePad;

    // -- Build histogram bins ---------------------------------
    const bins = buildHistogram(currentSamples, rangeMin, rangeMax, NUM_BINS);
    const maxBin = Math.max(...bins, 1);

    // -- Chart area -------------------------------------------
    const chartX = PAD.left;
    const chartY = PAD.top;
    const chartW = w - PAD.left - PAD.right;
    const chartH = h - PAD.top - PAD.bottom;

    if (chartW <= 0 || chartH <= 0) return;

    const binWidth = chartW / NUM_BINS;

    // -- Polaroid developing opacity --------------------------
    const opacity = Math.min(
      1,
      MIN_OPACITY +
        (1 - MIN_OPACITY) *
          (currentSamples.length / FULL_OPACITY_AT)
    );

    // -- Draw bars --------------------------------------------
    const binValueWidth = (rangeMax - rangeMin) / NUM_BINS;
    for (let i = 0; i < NUM_BINS; i++) {
      if (bins[i] === 0) continue;

      const barH = (bins[i] / maxBin) * chartH;
      const barX = chartX + i * binWidth;
      const barY = chartY + chartH - barH;

      // Determine bar color: compare bin center to threshold
      const binCenter = rangeMin + (i + 0.5) * binValueWidth;
      const isAbove =
        currentThreshold !== undefined && binCenter > currentThreshold;

      ctx.globalAlpha = opacity;
      ctx.fillStyle = isAbove ? BAR_COLOR_ABOVE : BAR_COLOR_BELOW;
      ctx.fillRect(barX, barY, binWidth - 1, barH);
      ctx.globalAlpha = 1;
    }

    // -- Helper: x position from data value -------------------
    const xFromValue = (v: number) =>
      chartX + ((v - rangeMin) / (rangeMax - rangeMin)) * chartW;

    // -- CI lines (dashed amber) ------------------------------
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = CI_COLOR;
    ctx.lineWidth = 1.5;

    const ciLowX = xFromValue(ciLow);
    ctx.beginPath();
    ctx.moveTo(ciLowX, chartY);
    ctx.lineTo(ciLowX, chartY + chartH);
    ctx.stroke();

    const ciHighX = xFromValue(ciHigh);
    ctx.beginPath();
    ctx.moveTo(ciHighX, chartY);
    ctx.lineTo(ciHighX, chartY + chartH);
    ctx.stroke();
    ctx.restore();

    // -- Mean line (solid white) ------------------------------
    ctx.save();
    ctx.strokeStyle = MEAN_COLOR;
    ctx.lineWidth = 1.5;
    const meanX = xFromValue(mean);
    ctx.beginPath();
    ctx.moveTo(meanX, chartY);
    ctx.lineTo(meanX, chartY + chartH);
    ctx.stroke();
    ctx.restore();

    // -- Threshold line (dotted red) --------------------------
    if (currentThreshold !== undefined) {
      const tx = xFromValue(currentThreshold);
      if (tx >= chartX && tx <= chartX + chartW) {
        ctx.save();
        ctx.setLineDash([3, 5]);
        ctx.strokeStyle = THRESHOLD_COLOR;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(tx, chartY);
        ctx.lineTo(tx, chartY + chartH);
        ctx.stroke();
        ctx.restore();

        // Label
        ctx.fillStyle = THRESHOLD_COLOR;
        ctx.font = "11px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.fillText("threshold", tx, chartY + chartH + 24);
      }
    }

    // -- X-axis tick labels -----------------------------------
    ctx.fillStyle = MUTED_COLOR;
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "center";
    const numTicks = 6;
    for (let t = 0; t <= numTicks; t++) {
      const frac = t / numTicks;
      const val = rangeMin + frac * (rangeMax - rangeMin);
      const x = chartX + frac * chartW;
      ctx.fillText(formatValue(val), x, chartY + chartH + 14);
    }

    // -- Y-axis label -----------------------------------------
    ctx.save();
    ctx.fillStyle = MUTED_COLOR;
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.translate(14, chartY + chartH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("frequency", 0, 0);
    ctx.restore();

    // -- Stats overlay (top-right) ----------------------------
    const pAbove =
      currentResult && currentPhase === "complete"
        ? currentResult.pAboveThreshold
        : currentThreshold !== undefined
          ? currentSamples.filter((s) => s > currentThreshold).length /
            currentSamples.length
          : null;

    const statsLines: string[] = [];
    statsLines.push(`n = ${currentSamples.length.toLocaleString()}`);
    statsLines.push(`mean = ${formatValue(mean)}`);
    statsLines.push(`CI 95% [${formatValue(ciLow)}, ${formatValue(ciHigh)}]`);
    if (pAbove !== null) {
      statsLines.push(`P(>thr) = ${(pAbove * 100).toFixed(1)}%`);
    }

    const lineH = 18;
    const boxPad = 10;
    const boxW = 170;
    const boxH = statsLines.length * lineH + boxPad * 2;
    const boxX = w - PAD.right + 12;
    const boxY = chartY;

    // Background for stats box
    ctx.fillStyle = "rgba(10, 14, 26, 0.85)";
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxW, boxH, 6);
    ctx.fill();

    ctx.strokeStyle = "rgba(100, 116, 139, 0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxW, boxH, 6);
    ctx.stroke();

    ctx.fillStyle = TEXT_COLOR;
    ctx.font = "12px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    statsLines.forEach((line, i) => {
      ctx.fillText(line, boxX + boxPad, boxY + boxPad + i * lineH);
    });

    // -- Phase indicator (bottom-right) -----------------------
    if (currentPhase === "running") {
      ctx.fillStyle = BAR_COLOR_BELOW;
      ctx.font = "11px ui-monospace, monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      // Pulsing dot effect
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 300);
      ctx.globalAlpha = pulse;
      ctx.fillText("running", w - 12, h - 8);
      ctx.globalAlpha = 1;
    } else if (currentPhase === "complete") {
      ctx.fillStyle = "#22c55e";
      ctx.font = "11px ui-monospace, monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      ctx.fillText("complete", w - 12, h - 8);
    }
  }, []);

  // -- Animation loop -----------------------------------------

  useEffect(() => {
    let running = true;

    const loop = () => {
      if (!running) return;
      draw();
      animFrameRef.current = requestAnimationFrame(loop);
    };

    animFrameRef.current = requestAnimationFrame(loop);

    return () => {
      running = false;
      cancelAnimationFrame(animFrameRef.current);
    };
  }, [draw]);

  // -- Render -------------------------------------------------

  return (
    <div
      ref={containerRef}
      className="w-full h-full min-h-[280px]"
      style={{ background: BG_COLOR }}
    >
      <canvas ref={canvasRef} className="block w-full h-full" />
    </div>
  );
}

// -- Format helper --------------------------------------------

function formatValue(v: number): string {
  const abs = Math.abs(v);
  if (abs === 0) return "0";
  if (abs >= 1_000_000) return (v / 1_000_000).toFixed(2) + "M";
  if (abs >= 1_000) return (v / 1_000).toFixed(1) + "k";
  if (abs >= 1) return v.toFixed(2);
  if (abs >= 0.01) return v.toFixed(3);
  return v.toFixed(4);
}
