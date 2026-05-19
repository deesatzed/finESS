"use client";

// ============================================================
// MultiProposalsPanel (R6-02)
// ------------------------------------------------------------
// Side-by-side per-model results view for the multi-LLM proposal
// lane. Each card shows what one configured model proposed for
// the same query. Errors are shown alongside successes — the
// whole point of this lane is to surface disagreement (and
// disagreement includes "this model couldn't even answer").
//
// Above the grid we render an amber banner in the same visual
// language as PathADraftBanner. The banner text is load-bearing:
// it tells the human the visible disagreement *is* the real
// uncertainty hidden by single-model views.
// ============================================================

import { useState } from "react";
import type { UncertaintyGraph } from "@/lib/types";
import type { ProposalResult } from "@/lib/ai/multi-proposer";

interface MultiProposalsPanelProps {
  proposals: ProposalResult[];
  summary?: {
    successCount: number;
    errorCount: number;
    totalCostUsd: number;
    wallTimeMs: number;
  };
  /**
   * Called when the user picks one proposer's graph to switch into the
   * existing single-graph editing/simulation flow. Parent decides what
   * "use this graph" means in their state machine.
   */
  onUseGraph?: (model: string, graph: UncertaintyGraph) => void;
  className?: string;
}

function formatCost(cost: number): string {
  if (!Number.isFinite(cost)) return "$0.0000";
  return `$${cost.toFixed(4)}`;
}

function formatLatency(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function ProposalCard({
  proposal,
  onUseGraph,
}: {
  proposal: ProposalResult;
  onUseGraph?: (model: string, graph: UncertaintyGraph) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const ok = Boolean(proposal.graph);

  return (
    <div
      className={`rounded-md border bg-[#0f1629] p-3 text-xs text-[#cbd5e1] ${
        ok
          ? "border-[#1e293b]"
          : "border-red-900/60 bg-red-950/20"
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[11px] text-white break-all">
          {proposal.model}
        </span>
        <span
          className={`text-[10px] uppercase tracking-wider ${
            ok ? "text-emerald-400" : "text-red-400"
          }`}
        >
          {ok ? "OK" : "Error"}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-[#64748b]">
        <span>latency {formatLatency(proposal.latencyMs)}</span>
        <span>cost {formatCost(proposal.costUsd)}</span>
        {proposal.retryCount > 0 && (
          <span>retries {proposal.retryCount}</span>
        )}
      </div>

      {ok && proposal.graph ? (
        <>
          <div className="mt-2 text-[11px] text-[#94a3b8]">
            <span className="font-semibold text-white">
              {proposal.graph.nodes.length}
            </span>{" "}
            nodes,{" "}
            <span className="font-semibold text-white">
              {proposal.graph.edges.length}
            </span>{" "}
            edges, output{" "}
            <span className="font-mono text-white">
              {proposal.graph.outputNodeId}
            </span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setExpanded((prev) => !prev)}
              className="rounded border border-[#1e293b] px-2 py-0.5 text-[11px] text-[#cbd5e1] hover:border-[#3b82f6] hover:text-white"
            >
              {expanded ? "Hide nodes" : "Show nodes"}
            </button>
            {onUseGraph && (
              <button
                type="button"
                onClick={() => onUseGraph(proposal.model, proposal.graph!)}
                className="rounded bg-[#3b82f6] px-2 py-0.5 text-[11px] font-medium text-white hover:bg-[#2563eb]"
              >
                Use this graph
              </button>
            )}
          </div>

          {expanded && (
            <ul className="mt-2 space-y-1 border-t border-[#1e293b] pt-2">
              {proposal.graph.nodes.map((node) => (
                <li
                  key={node.id}
                  className="leading-tight text-[10px] text-[#94a3b8]"
                >
                  <span className="font-mono text-white">{node.id}</span>{" "}
                  <span className="text-[#cbd5e1]">{node.name}</span> —{" "}
                  mean {Number(node.mean).toFixed(3)} ± {Number(node.sd).toFixed(3)}{" "}
                  <span className="text-[#64748b]">({node.source ?? "llm_prior"})</span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="mt-2 break-words text-[11px] text-red-300">
          {proposal.error ?? "Unknown error"}
        </p>
      )}
    </div>
  );
}

export function MultiProposalsPanel({
  proposals,
  summary,
  onUseGraph,
  className = "",
}: MultiProposalsPanelProps) {
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <div
        role="alert"
        className="rounded-md border-l-4 border-amber-500 bg-amber-100 px-3 py-2 text-xs text-amber-900"
      >
        <p className="leading-5">
          <span className="font-semibold">Multi-model proposal.</span>{" "}
          Each LLM proposed a different graph. Disagreement is the real
          uncertainty — the visible variance below is what the single-model
          view hides. None of these are verified; pick the one closest to
          your data and edit it.
        </p>
      </div>

      {summary && (
        <div className="text-[10px] text-[#64748b]">
          {summary.successCount} ok · {summary.errorCount} error ·{" "}
          total cost {formatCost(summary.totalCostUsd)} ·{" "}
          wall {formatLatency(summary.wallTimeMs)}
        </div>
      )}

      <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
        {proposals.map((proposal, idx) => (
          <ProposalCard
            key={`${proposal.model}-${idx}`}
            proposal={proposal}
            onUseGraph={onUseGraph}
          />
        ))}
      </div>
    </div>
  );
}

export default MultiProposalsPanel;
