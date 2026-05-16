"use client";

import { useEffect, useState } from "react";

interface ModelSelectorProps {
  selectedModel: string;
  onModelChange: (model: string) => void;
  sessionApiKey: string;
  onSessionApiKeyChange: (apiKey: string) => void;
  onApiKeyAvailabilityChange?: (available: boolean) => void;
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
  sessionApiKey,
  onSessionApiKeyChange,
  onApiKeyAvailabilityChange,
}: ModelSelectorProps) {
  const [isCustom, setIsCustom] = useState(false);
  const [customModel, setCustomModel] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [hasEnvApiKey, setHasEnvApiKey] = useState(false);
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
        setHasEnvApiKey(Boolean(data.hasApiKey));
        onApiKeyAvailabilityChange?.(Boolean(data.hasApiKey || sessionApiKey));
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
  }, [onApiKeyAvailabilityChange, onModelChange, selectedModel, sessionApiKey]);

  useEffect(() => {
    onApiKeyAvailabilityChange?.(Boolean(hasEnvApiKey || sessionApiKey));
  }, [hasEnvApiKey, onApiKeyAvailabilityChange, sessionApiKey]);

  return (
    <div className="flex flex-col gap-2 px-4 py-2 bg-[#0f1629] border-b border-[#1e293b] lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-wrap items-center gap-2">
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
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-[#64748b]">
          {loadError
            ? loadError
            : sessionApiKey
              ? "Session API key active; not stored."
              : hasEnvApiKey
                ? "Env API key configured."
                : "No API key active."}
        </span>
        <div className="flex items-center gap-1">
          <input
            type="password"
            value={keyDraft}
            onChange={(event) => setKeyDraft(event.target.value)}
            placeholder={
              hasEnvApiKey
                ? "Optional session key override"
                : "OpenRouter key for this session"
            }
            className="w-56 rounded border border-[#334155] bg-[#1e293b] px-2 py-1 text-xs text-[#e2e8f0] placeholder:text-[#64748b] focus:outline-none focus:ring-1 focus:ring-[#3b82f6]"
          />
          <button
            type="button"
            onClick={() => {
              onSessionApiKeyChange(keyDraft.trim());
              setKeyDraft("");
            }}
            disabled={!keyDraft.trim()}
            className="rounded border border-[#334155] bg-[#1e293b] px-2 py-1 text-xs font-medium text-[#cbd5e1] hover:text-white disabled:cursor-not-allowed disabled:text-[#64748b]"
          >
            Use
          </button>
        </div>
        {sessionApiKey && (
          <button
            type="button"
            onClick={() => onSessionApiKeyChange("")}
            className="rounded border border-[#334155] bg-[#111827] px-2 py-1 text-xs text-[#94a3b8] hover:text-white"
          >
            Clear key
          </button>
        )}
      </div>
    </div>
  );
}
