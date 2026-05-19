"use client";

import { useState, useCallback } from "react";
import type { UncertaintyNode, UncertaintyGraph, NodeImpact } from "@/lib/types";
import { VALID_IMPACTS } from "@/lib/types";
import { getSourceStyle, getImpactStyle } from "@/lib/ui/source-style";

interface NodeEditorProps {
  graph: UncertaintyGraph;
  onGraphUpdate: (graph: UncertaintyGraph) => void;
  onClose: () => void;
  selectedNodeId: string | null;
}

interface ExpertEstimate {
  value: string;
  id: number;
}

export function NodeEditor({
  graph,
  onGraphUpdate,
  onClose,
  selectedNodeId,
}: NodeEditorProps) {
  const node = graph.nodes.find((n) => n.id === selectedNodeId);
  const [mode, setMode] = useState<"sliders" | "expert">("sliders");

  // Slider state
  const [mean, setMean] = useState(node?.mean ?? 0.5);
  const [sd, setSd] = useState(node?.sd ?? 0.1);
  // C4: operator-assigned impact tag. "" represents "no impact set".
  const [impact, setImpact] = useState<NodeImpact | "">(node?.impact ?? "");

  // Expert panel state
  const [estimates, setEstimates] = useState<ExpertEstimate[]>([
    { value: "", id: 1 },
    { value: "", id: 2 },
    { value: "", id: 3 },
  ]);
  const [nextId, setNextId] = useState(4);

  const handleApply = useCallback(() => {
    if (!node) return;

    const updatedNodes = graph.nodes.map((n) => {
      if (n.id !== node.id) return n;
      // Flip provenance to user_override when the user actually changed the
      // distribution parameters. Preserve any existing sourceNote since the
      // editor doesn't currently expose editing it; downstream UI can clear
      // or relabel the note when source becomes user_override.
      const changed = mean !== n.mean || sd !== n.sd;
      const next: UncertaintyNode = {
        ...n,
        mean,
        sd,
        source: changed ? "user_override" : (n.source ?? "llm_prior"),
      };
      if (n.sourceNote !== undefined) {
        next.sourceNote = n.sourceNote;
      }
      // C4: persist impact change. Empty string clears the field; otherwise
      // store the selected NodeImpact. Impact does NOT flip source to
      // user_override because changing a tag is metadata, not a value edit.
      if (impact === "") {
        delete (next as Partial<UncertaintyNode>).impact;
      } else {
        next.impact = impact;
      }
      return next;
    });

    onGraphUpdate({ ...graph, nodes: updatedNodes });
  }, [graph, node, mean, sd, impact, onGraphUpdate]);

  const addEstimate = useCallback(() => {
    setEstimates((prev) => [...prev, { value: "", id: nextId }]);
    setNextId((prev) => prev + 1);
  }, [nextId]);

  const removeEstimate = useCallback((id: number) => {
    setEstimates((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const updateEstimate = useCallback((id: number, value: string) => {
    setEstimates((prev) =>
      prev.map((e) => (e.id === id ? { ...e, value } : e))
    );
  }, []);

  const computeFromEstimates = useCallback(() => {
    const values = estimates
      .map((e) => parseFloat(e.value))
      .filter((v) => !isNaN(v));

    if (values.length < 2) return;

    const newMean = values.reduce((a, b) => a + b, 0) / values.length;
    const newSd = Math.sqrt(
      values.reduce((a, b) => a + (b - newMean) ** 2, 0) / (values.length - 1)
    );

    setMean(Math.round(newMean * 10000) / 10000);
    setSd(Math.round(Math.max(newSd, 0.001) * 10000) / 10000);
    setMode("sliders");
  }, [estimates]);

  if (!node) {
    return (
      <div className="absolute inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-[#0f1629] border border-[#1e293b] rounded-lg p-4 text-[#94a3b8] text-sm">
          No node selected.
          <button
            onClick={onClose}
            className="ml-4 text-[#3b82f6] hover:text-white"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  const sourceStyle = getSourceStyle(node.source);
  const impactStyle = getImpactStyle(node.impact);

  return (
    <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-50">
      <div
        className={`bg-[#0f1629] border border-[#1e293b] border-l-4 ${sourceStyle.borderClass} rounded-lg w-[420px] max-h-[80vh] overflow-y-auto`}
        data-source={node.source ?? "llm_prior"}
        data-impact={node.impact ?? "unset"}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1e293b]">
          <div className="flex items-center gap-2 min-w-0">
            <h3 className="text-sm font-medium text-white truncate">{node.name}</h3>
            <span
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${sourceStyle.pillClass}`}
              title={sourceStyle.title}
            >
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${sourceStyle.dotClass}`} />
              {sourceStyle.label}
            </span>
            {impactStyle && (
              <span
                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${impactStyle.pillClass}`}
                title={impactStyle.title}
              >
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${impactStyle.dotClass}`} />
                {impactStyle.label}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-[#64748b] hover:text-white text-lg leading-none"
          >
            x
          </button>
        </div>

        {/* Description */}
        <p className="px-4 py-2 text-xs text-[#64748b]">{node.description}</p>

        {/* Mode Toggle */}
        <div className="px-4 py-2 flex gap-2">
          <button
            onClick={() => setMode("sliders")}
            className={`px-3 py-1 rounded text-xs ${
              mode === "sliders"
                ? "bg-[#3b82f6] text-white"
                : "bg-[#1e293b] text-[#94a3b8] hover:text-white"
            }`}
          >
            Direct Adjust
          </button>
          <button
            onClick={() => setMode("expert")}
            className={`px-3 py-1 rounded text-xs ${
              mode === "expert"
                ? "bg-[#3b82f6] text-white"
                : "bg-[#1e293b] text-[#94a3b8] hover:text-white"
            }`}
          >
            Expert Panel
          </button>
        </div>

        {/* Content */}
        <div className="px-4 py-3">
          {mode === "sliders" ? (
            <SliderMode
              node={node}
              mean={mean}
              sd={sd}
              onMeanChange={setMean}
              onSdChange={setSd}
            />
          ) : (
            <ExpertMode
              estimates={estimates}
              onAdd={addEstimate}
              onRemove={removeEstimate}
              onUpdate={updateEstimate}
              onCompute={computeFromEstimates}
            />
          )}
        </div>

        {/* C4: operator-assigned impact tag */}
        <div className="px-4 py-3 border-t border-[#1e293b] flex items-center gap-2">
          <label
            htmlFor="impact-select"
            className="text-xs text-[#94a3b8]"
            title="How important is this factor to the result? Used to flag mismatches against engine-computed sensitivity."
          >
            Impact:
          </label>
          <select
            id="impact-select"
            value={impact}
            onChange={(e) => setImpact(e.target.value as NodeImpact | "")}
            className="text-xs bg-[#1e293b] text-white border border-[#334155] rounded px-2 py-1 hover:border-[#475569]"
          >
            <option value="">— not set —</option>
            {VALID_IMPACTS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>

        {/* Actions */}
        <div className="px-4 py-3 border-t border-[#1e293b] flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded text-xs text-[#94a3b8] bg-[#1e293b] hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              handleApply();
              onClose();
            }}
            className="px-4 py-2 rounded text-xs text-white bg-[#3b82f6] hover:bg-[#2563eb]"
          >
            Apply & Re-run
          </button>
        </div>
      </div>
    </div>
  );
}

function SliderMode({
  node,
  mean,
  sd,
  onMeanChange,
  onSdChange,
}: {
  node: UncertaintyNode;
  mean: number;
  sd: number;
  onMeanChange: (v: number) => void;
  onSdChange: (v: number) => void;
}) {
  const [low, high] = node.range;
  const step = (high - low) / 200;
  const maxSd = (high - low) / 2;

  return (
    <div className="space-y-4">
      <div>
        <div className="flex justify-between text-xs mb-1">
          <span className="text-[#94a3b8]">Mean</span>
          <span className="text-white font-mono">{mean.toFixed(4)}</span>
        </div>
        <input
          type="range"
          min={low}
          max={high}
          step={step}
          value={mean}
          onChange={(e) => onMeanChange(parseFloat(e.target.value))}
          className="w-full accent-[#3b82f6]"
        />
        <div className="flex justify-between text-[10px] text-[#475569]">
          <span>{low}</span>
          <span>Original: {node.mean}</span>
          <span>{high}</span>
        </div>
      </div>

      <div>
        <div className="flex justify-between text-xs mb-1">
          <span className="text-[#94a3b8]">Standard Deviation</span>
          <span className="text-white font-mono">{sd.toFixed(4)}</span>
        </div>
        <input
          type="range"
          min={0.001}
          max={maxSd}
          step={maxSd / 200}
          value={sd}
          onChange={(e) => onSdChange(parseFloat(e.target.value))}
          className="w-full accent-[#f59e0b]"
        />
        <div className="flex justify-between text-[10px] text-[#475569]">
          <span>0.001</span>
          <span>Original: {node.sd}</span>
          <span>{maxSd.toFixed(3)}</span>
        </div>
      </div>

      <div className="text-[10px] text-[#475569] bg-[#1e293b] rounded p-2">
        Distribution: {node.distribution} | Unit: {node.unit} | Range: [{low}, {high}]
      </div>
    </div>
  );
}

function ExpertMode({
  estimates,
  onAdd,
  onRemove,
  onUpdate,
  onCompute,
}: {
  estimates: ExpertEstimate[];
  onAdd: () => void;
  onRemove: (id: number) => void;
  onUpdate: (id: number, value: string) => void;
  onCompute: () => void;
}) {
  const validCount = estimates.filter(
    (e) => e.value !== "" && !isNaN(parseFloat(e.value))
  ).length;

  return (
    <div className="space-y-3">
      <p className="text-xs text-[#94a3b8]">
        Enter multiple expert estimates. The mean and SD will be computed from
        the disagreement between experts.
      </p>

      {estimates.map((est, idx) => (
        <div key={est.id} className="flex items-center gap-2">
          <span className="text-[10px] text-[#475569] w-16">
            Expert {idx + 1}:
          </span>
          <input
            type="number"
            step="any"
            value={est.value}
            onChange={(e) => onUpdate(est.id, e.target.value)}
            placeholder="0.00"
            className="flex-1 bg-[#1e293b] text-[#e2e8f0] text-xs rounded px-2 py-1.5 border border-[#334155] focus:outline-none focus:ring-1 focus:ring-[#3b82f6]"
          />
          {estimates.length > 2 && (
            <button
              onClick={() => onRemove(est.id)}
              className="text-[#475569] hover:text-red-400 text-xs"
            >
              x
            </button>
          )}
        </div>
      ))}

      <div className="flex gap-2">
        <button
          onClick={onAdd}
          className="px-3 py-1 rounded text-[10px] bg-[#1e293b] text-[#94a3b8] hover:text-white border border-[#334155]"
        >
          + Add Expert
        </button>
        <button
          onClick={onCompute}
          disabled={validCount < 2}
          className="px-3 py-1 rounded text-[10px] bg-[#3b82f6] text-white hover:bg-[#2563eb] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Compute Distribution ({validCount} estimates)
        </button>
      </div>

      {validCount >= 2 && (
        <p className="text-[10px] text-[#64748b]">
          Expert disagreement becomes the uncertainty (Principle 2).
          Click &ldquo;Compute Distribution&rdquo; to set mean/SD from these estimates.
        </p>
      )}
    </div>
  );
}
