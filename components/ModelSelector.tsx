"use client";

import { useEffect, useState } from "react";

interface ModelSelectorProps {
  selectedModel: string;
  onModelChange: (model: string) => void;
}

interface ModelOption {
  id: string;
  label: string;
}

interface ModelConfigResponse {
  models: ModelOption[];
  defaultModel: string;
  hasApiKey: boolean;
}

export function ModelSelector({
  selectedModel,
  onModelChange,
}: ModelSelectorProps) {
  const [isCustom, setIsCustom] = useState(false);
  const [customModel, setCustomModel] = useState("");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadModels() {
      try {
        const response = await fetch("/api/models");
        if (!response.ok) {
          throw new Error(`Model config failed (${response.status})`);
        }
        const data = (await response.json()) as ModelConfigResponse;
        if (cancelled) return;

        setModels(data.models ?? []);
        setHasApiKey(Boolean(data.hasApiKey));
        if (!selectedModel && data.defaultModel) {
          onModelChange(data.defaultModel);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(
            error instanceof Error ? error.message : "Failed to load model config"
          );
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    loadModels();
    return () => {
      cancelled = true;
    };
  }, [onModelChange, selectedModel]);

  return (
    <div className="flex flex-col gap-1 px-4 py-2 bg-[#0f1629] border-b border-[#1e293b] sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wider text-[#64748b]">
          AI setup
        </span>
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
          <option value="">
            {isLoading ? "Loading models..." : "Select a model..."}
          </option>
          {models.map((m) => (
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
      <span className="text-xs text-[#64748b]">
        {loadError
          ? loadError
          : hasApiKey
            ? "Models are loaded from local env. Instant demo needs no model."
            : "Add OPENROUTER_API_KEY in local env for custom AI questions."}
      </span>
    </div>
  );
}
