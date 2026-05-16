"use client";

import { useState, useEffect, useCallback } from "react";
import type {
  UncertaintyGraph,
  SimulationResult,
  SensitivityResult,
} from "@/lib/types";

interface SaveLoadModalProps {
  isOpen: boolean;
  onClose: () => void;
  // Save context
  query: string | null;
  graph: UncertaintyGraph | null;
  result: SimulationResult | null;
  sensitivity: SensitivityResult[] | null;
  // Load callback
  onLoad: (data: {
    id: string;
    query: string;
    graph: UncertaintyGraph;
    result: SimulationResult | null;
    sensitivity: SensitivityResult[] | null;
    seed: number | null;
  }) => void;
  // Called after a successful save with the new analysis ID
  onSave?: (id: string) => void;
}

interface AnalysisSummary {
  id: string;
  query: string;
  seed: number | null;
  createdAt: string;
}

type Tab = "save" | "load";

function getApiErrorMessage(data: unknown, fallback: string) {
  if (typeof data !== "object" || data === null || !("error" in data)) {
    return fallback;
  }
  const error = (data as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return fallback;
}

export function SaveLoadModal({
  isOpen,
  onClose,
  query,
  graph,
  result,
  sensitivity,
  onLoad,
  onSave,
}: SaveLoadModalProps) {
  const [activeTab, setActiveTab] = useState<Tab>("save");
  const [analyses, setAnalyses] = useState<AnalysisSummary[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchAnalyses = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const res = await fetch("/api/analyses");
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(getApiErrorMessage(body, `Failed to fetch analyses (${res.status})`));
      }
      const data = await res.json();
      setAnalyses(data.analyses ?? []);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Failed to fetch analyses");
    } finally {
      setLoadingList(false);
    }
  }, []);

  // Fetch list when modal opens on the Load tab, or when switching to Load tab
  useEffect(() => {
    if (isOpen && activeTab === "load") {
      fetchAnalyses();
    }
  }, [isOpen, activeTab, fetchAnalyses]);

  // Reset transient state when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setSaveError(null);
      setSavedId(null);
    }
  }, [isOpen]);

  const handleSave = useCallback(async () => {
    if (!query || !graph) return;

    setSaving(true);
    setSaveError(null);
    setSavedId(null);

    try {
      const res = await fetch("/api/analyses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          graph,
          result,
          sensitivity,
          seed: result?.seed ?? null,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(getApiErrorMessage(body, `Save failed (${res.status})`));
      }

      const data = await res.json();
      setSavedId(data.id);
      onSave?.(data.id);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save analysis");
    } finally {
      setSaving(false);
    }
  }, [query, graph, result, sensitivity, onSave]);

  const handleLoad = useCallback(
    async (id: string) => {
      setLoadingId(id);
      try {
        const res = await fetch(`/api/analyses/${id}`);
        if (!res.ok) {
          const body = await res.json().catch(() => null);
        throw new Error(getApiErrorMessage(body, `Load failed (${res.status})`));
        }
        const data = await res.json();
        onLoad({
          id: data.id,
          query: data.query,
          graph: data.graph,
          result: data.result ?? null,
          sensitivity: data.sensitivity ?? null,
          seed: data.seed ?? null,
        });
        onClose();
      } catch (err) {
        setListError(err instanceof Error ? err.message : "Failed to load analysis");
      } finally {
        setLoadingId(null);
      }
    },
    [onLoad, onClose]
  );

  const handleDelete = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      setDeletingId(id);
      try {
        const res = await fetch(`/api/analyses/${id}`, { method: "DELETE" });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(getApiErrorMessage(body, `Delete failed (${res.status})`));
        }
        setAnalyses((prev) => prev.filter((a) => a.id !== id));
      } catch (err) {
        setListError(err instanceof Error ? err.message : "Failed to delete analysis");
      } finally {
        setDeletingId(null);
      }
    },
    []
  );

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const canSave = Boolean(query && graph);

  const formatDate = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return iso;
    }
  };

  const truncate = (text: string, max: number) =>
    text.length > max ? text.slice(0, max) + "..." : text;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-[#0f1629] border border-[#1e293b] rounded-lg shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1e293b]">
          <h2 className="text-sm font-medium text-[#e2e8f0]">
            Save / Load Analysis
          </h2>
          <button
            onClick={onClose}
            className="text-[#64748b] hover:text-[#e2e8f0] transition-colors text-sm leading-none"
            aria-label="Close modal"
          >
            &#x2715;
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-[#1e293b]">
          {(["save", "load"] as Tab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 px-4 py-2 text-xs font-medium uppercase tracking-wider transition-colors ${
                activeTab === tab
                  ? "text-[#3b82f6] border-b-2 border-[#3b82f6] bg-[#1e293b]/40"
                  : "text-[#64748b] hover:text-[#94a3b8]"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="p-4 min-h-[280px] max-h-[420px] flex flex-col">
          {activeTab === "save" ? (
            /* ===== SAVE TAB ===== */
            <div className="flex flex-col gap-3">
              <div>
                <label className="text-xs text-[#64748b] uppercase tracking-wider block mb-1">
                  Query
                </label>
                <div className="bg-[#1e293b]/60 border border-[#1e293b] rounded px-3 py-2 text-sm text-[#e2e8f0] min-h-[40px]">
                  {query || (
                    <span className="text-[#64748b] italic">No query provided</span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-3 text-xs text-[#64748b]">
                <span>
                  Graph:{" "}
                  <span className={graph ? "text-[#e2e8f0]" : "text-[#64748b]"}>
                    {graph
                      ? `${graph.nodes.length} node${graph.nodes.length !== 1 ? "s" : ""}, ${graph.edges.length} edge${graph.edges.length !== 1 ? "s" : ""}`
                      : "none"}
                  </span>
                </span>
                <span>
                  Result:{" "}
                  <span className={result ? "text-[#e2e8f0]" : "text-[#64748b]"}>
                    {result ? `mean ${result.mean.toFixed(3)}` : "none"}
                  </span>
                </span>
                <span>
                  Sensitivity:{" "}
                  <span className={sensitivity ? "text-[#e2e8f0]" : "text-[#64748b]"}>
                    {sensitivity
                      ? `${sensitivity.length} node${sensitivity.length !== 1 ? "s" : ""}`
                      : "none"}
                  </span>
                </span>
              </div>

              {!canSave && (
                <p className="text-xs text-[#64748b]">
                  A query and graph are required before saving.
                </p>
              )}

              <button
                onClick={handleSave}
                disabled={!canSave || saving}
                className={`mt-1 px-4 py-2 rounded text-sm font-medium transition-colors ${
                  canSave && !saving
                    ? "bg-[#3b82f6] text-white hover:bg-[#2563eb] active:bg-[#1d4ed8]"
                    : "bg-[#1e293b] text-[#64748b] cursor-not-allowed"
                }`}
              >
                {saving ? "Saving..." : "Save Analysis"}
              </button>

              {savedId && (
                <p className="text-xs text-green-400">
                  Saved successfully. ID: {savedId}
                </p>
              )}

              {saveError && (
                <p className="text-xs text-red-400">{saveError}</p>
              )}
            </div>
          ) : (
            /* ===== LOAD TAB ===== */
            <div className="flex flex-col gap-2 flex-1 min-h-0">
              {listError && (
                <p className="text-xs text-red-400 flex-shrink-0">{listError}</p>
              )}

              {loadingList ? (
                <div className="flex-1 flex items-center justify-center">
                  <span className="text-xs text-[#64748b]">
                    Loading saved analyses...
                  </span>
                </div>
              ) : analyses.length === 0 ? (
                <div className="flex-1 flex items-center justify-center">
                  <span className="text-xs text-[#64748b]">
                    No saved analyses
                  </span>
                </div>
              ) : (
                <div className="flex-1 overflow-y-auto space-y-1 pr-1">
                  {analyses.map((a) => {
                    const isLoading = loadingId === a.id;
                    const isDeleting = deletingId === a.id;

                    return (
                      <button
                        key={a.id}
                        onClick={() => handleLoad(a.id)}
                        disabled={isLoading || isDeleting}
                        className={`w-full text-left px-3 py-2.5 rounded border transition-colors group ${
                          isLoading
                            ? "border-[#3b82f6]/50 bg-[#3b82f6]/10"
                            : "border-[#1e293b] bg-[#1e293b]/40 hover:bg-[#1e293b] hover:border-[#334155]"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm text-[#e2e8f0] truncate">
                              {truncate(a.query, 80)}
                            </p>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="text-xs text-[#64748b]">
                                {formatDate(a.createdAt)}
                              </span>
                              {a.seed !== null && (
                                <span className="text-xs text-[#64748b]">
                                  seed: {a.seed}
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 flex-shrink-0 mt-0.5">
                            {isLoading && (
                              <span className="text-xs text-[#3b82f6]">
                                Loading...
                              </span>
                            )}
                            <button
                              onClick={(e) => handleDelete(a.id, e)}
                              disabled={isDeleting}
                              className={`px-1.5 py-0.5 rounded text-xs transition-colors ${
                                isDeleting
                                  ? "text-[#64748b] cursor-not-allowed"
                                  : "text-[#64748b] hover:text-red-400 hover:bg-red-400/10 opacity-0 group-hover:opacity-100"
                              }`}
                              aria-label={`Delete analysis ${a.id}`}
                            >
                              {isDeleting ? "..." : "Delete"}
                            </button>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
