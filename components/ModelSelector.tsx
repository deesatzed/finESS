"use client";

import { useState } from "react";

interface ModelSelectorProps {
  selectedModel: string;
  onModelChange: (model: string) => void;
}

const SUGGESTED_MODELS = [
  { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" },
  { id: "openai/gpt-4o", label: "GPT-4o" },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "anthropic/claude-haiku-3.5", label: "Claude Haiku 3.5" },
];

export function ModelSelector({
  selectedModel,
  onModelChange,
}: ModelSelectorProps) {
  const [isCustom, setIsCustom] = useState(false);
  const [customModel, setCustomModel] = useState("");

  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-[#0f1629] border-b border-[#1e293b]">
      <span className="text-xs text-[#64748b]">Model:</span>
      {!isCustom ? (
        <select
          value={selectedModel}
          onChange={(e) => {
            if (e.target.value === "__custom__") {
              setIsCustom(true);
            } else {
              onModelChange(e.target.value);
            }
          }}
          className="bg-[#1e293b] text-[#e2e8f0] text-xs rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-[#3b82f6] border border-[#334155]"
        >
          <option value="">Select a model...</option>
          {SUGGESTED_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          <option value="__custom__">Custom model ID...</option>
        </select>
      ) : (
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && customModel.trim()) {
                onModelChange(customModel.trim());
                setIsCustom(false);
              }
            }}
            placeholder="e.g. anthropic/claude-sonnet-4"
            className="bg-[#1e293b] text-[#e2e8f0] text-xs rounded px-2 py-1 w-64 focus:outline-none focus:ring-1 focus:ring-[#3b82f6] border border-[#334155]"
            autoFocus
          />
          <button
            onClick={() => {
              if (customModel.trim()) {
                onModelChange(customModel.trim());
              }
              setIsCustom(false);
            }}
            className="text-xs text-[#3b82f6] hover:text-white"
          >
            OK
          </button>
          <button
            onClick={() => setIsCustom(false)}
            className="text-xs text-[#64748b] hover:text-white"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
