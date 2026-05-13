"use client";

import { useEffect, useRef } from "react";
import type { SimulationPhase, SimulationResult, SensitivityResult } from "@/lib/types";

interface NarrationStreamProps {
  phase: SimulationPhase;
  progress: number;
  narration: string | null;
  result: SimulationResult | null;
  sensitivity: SensitivityResult[] | null;
  threshold?: number;
}

export function NarrationStream({
  phase,
  progress,
  narration,
  result,
  sensitivity,
  threshold,
}: NarrationStreamProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [phase, progress, result]);

  const lines: { text: string; type: "info" | "data" | "recommend" }[] = [];

  if (narration) {
    lines.push({ text: narration, type: "info" });
  }

  if (phase === "running") {
    lines.push({
      text: `Running ${Math.round(progress * 15000)} / 15,000 simulations...`,
      type: "data",
    });
  }

  if (phase === "complete" && result) {
    lines.push({
      text: `Simulation complete. ${result.samples.length.toLocaleString()} samples.`,
      type: "data",
    });
    lines.push({
      text: `Posterior mean: ${(result.mean * 100).toFixed(1)}%`,
      type: "data",
    });
    lines.push({
      text: `95% CI: [${(result.ciLow * 100).toFixed(1)}% \u2013 ${(result.ciHigh * 100).toFixed(1)}%]`,
      type: "data",
    });
    if (threshold !== undefined) {
      lines.push({
        text: `P(>${(threshold * 100).toFixed(0)}%): ${(result.pAboveThreshold * 100).toFixed(1)}%`,
        type: "data",
      });
    }

    if (sensitivity && sensitivity.length > 0) {
      const top = sensitivity[0];
      lines.push({
        text: `"${top.nodeName}" drives ${top.varianceReduction.toFixed(0)}% of output variance.`,
        type: "recommend",
      });
      if (top.ciWidthReduction > 10) {
        lines.push({
          text: `Reducing uncertainty in "${top.nodeName}" would shrink the CI by ${top.ciWidthReduction.toFixed(0)}%.`,
          type: "recommend",
        });
      }
    }
  }

  return (
    <div
      ref={containerRef}
      className="h-full overflow-y-auto p-3 text-xs font-[family-name:var(--font-geist-mono)] space-y-2"
    >
      {lines.length === 0 && (
        <p className="text-[#475569] italic">Waiting for analysis...</p>
      )}
      {lines.map((line, i) => (
        <p
          key={i}
          className={
            line.type === "recommend"
              ? "text-[#f59e0b]"
              : line.type === "data"
                ? "text-[#94a3b8]"
                : "text-[#cbd5e1]"
          }
        >
          {line.type === "recommend" ? "\u25B6 " : ""}
          {line.text}
        </p>
      ))}
    </div>
  );
}
