"use client";

import { useState, useCallback, useMemo, useRef } from "react";
import { AnalysisStatusStrip } from "@/components/AnalysisStatusStrip";
import { Dashboard } from "@/components/Dashboard";
import { InputBar } from "@/components/InputBar";
import { ModelSelector } from "@/components/ModelSelector";
import { NarrationStream } from "@/components/NarrationStream";
import { NodeEditor } from "@/components/NodeEditor";
import { SaveLoadModal } from "@/components/SaveLoadModal";
import CalibrationModal from "@/components/CalibrationModal";
import { RealDataPanel } from "@/components/RealDataPanel";
import { ForecastPanel } from "@/components/ForecastPanel";
import { MultiProposalsPanel } from "@/components/MultiProposalsPanel";
import NodeNetwork from "@/components/panels/NodeNetwork";
import LiveDistribution from "@/components/panels/LiveDistribution";
import SensitivityRadar from "@/components/panels/SensitivityRadar";
import GaugePanel from "@/components/panels/GaugePanel";
import SpectrumBars from "@/components/panels/SpectrumBars";
import { useSimulation } from "@/lib/engine/use-simulation";
import { PE_EXAMPLE_GRAPH } from "@/lib/examples/pe-scenario";
import { getAnalysisStatus } from "@/lib/ui/analysis-status";
import type { ObservedAnalysisResult } from "@/lib/real-data/analyze";
import type { RealDataInsight } from "@/lib/real-data/assist";
import type { UncertaintyGraph, SimulationResult, SensitivityResult } from "@/lib/types";
import type { ProposalResult } from "@/lib/ai/multi-proposer";

// R6-02: "simulation-multi" is a sibling of "simulation" that fans out the
// query to every configured proposer and renders MultiProposalsPanel in
// place of the Dashboard. Dashboard.tsx itself stays untouched.
type DashboardMode = "simulation" | "simulation-multi" | "observed" | "forecast";

interface MultiSummary {
  successCount: number;
  errorCount: number;
  totalCostUsd: number;
  wallTimeMs: number;
}

function getApiErrorMessage(data: unknown, fallback: string) {
  if (
    typeof data === "object" &&
    data !== null &&
    "error" in data
  ) {
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
  }
  return fallback;
}

export default function Home() {
  const [model, setModel] = useState("");
  const [sessionApiKey, setSessionApiKey] = useState("");
  const [hasUsableAiKey, setHasUsableAiKey] = useState(false);
  const [mode, setMode] = useState<DashboardMode>("observed");
  const [graph, setGraph] = useState<UncertaintyGraph | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allSamples, setAllSamples] = useState<number[]>([]);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [currentQuery, setCurrentQuery] = useState<string | null>(null);
  const [showSaveLoad, setShowSaveLoad] = useState(false);
  const [showCalibration, setShowCalibration] = useState(false);
  const [savedAnalysisId, setSavedAnalysisId] = useState<string | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [observedResult, setObservedResult] = useState<SimulationResult | null>(null);
  const [observedSensitivity, setObservedSensitivity] = useState<SensitivityResult[] | null>(null);
  const [observedMeta, setObservedMeta] = useState<{
    targetColumn: string;
    rowCount: number;
    missingCount: number;
  } | null>(null);
  const [aiInsight, setAiInsight] = useState<RealDataInsight | null>(null);
  const [aiAssistError, setAiAssistError] = useState<string | null>(null);
  const [aiAssistLoading, setAiAssistLoading] = useState(false);
  const [multiProposals, setMultiProposals] = useState<ProposalResult[] | null>(null);
  const [multiSummary, setMultiSummary] = useState<MultiSummary | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const sim = useSimulation();

  // Accumulate samples from batches
  const samplesRef = useRef<number[]>([]);

  const runSimulation = useCallback(
    (
      g: UncertaintyGraph,
      options: { seed?: number | null; markUnsaved?: boolean } = {}
    ) => {
      setGraph(g);
      setError(null);
      setObservedResult(null);
      setObservedSensitivity(null);
      setObservedMeta(null);
      setAiInsight(null);
      setAiAssistError(null);
      setHasUnsavedChanges(options.markUnsaved ?? true);
      samplesRef.current = [];
      setAllSamples([]);

      sim.start(g, {
        seed: options.seed ?? (g === PE_EXAMPLE_GRAPH ? 42 : undefined),
      });
    },
    [sim]
  );

  // Update accumulated samples when batch arrives
  if (sim.currentBatch && sim.phase === "running") {
    const newSamples = [...samplesRef.current, ...sim.currentBatch.samples];
    if (newSamples.length !== samplesRef.current.length) {
      samplesRef.current = newSamples;
      if (samplesRef.current.length % 1000 < 500) {
        setTimeout(() => setAllSamples([...samplesRef.current]), 0);
      }
    }
  }

  const displaySamples =
    observedResult
      ? observedResult.samples
      : sim.phase === "complete" && sim.result
        ? sim.result.samples
        : allSamples;

  const activePhase = observedResult ? "complete" : sim.phase;
  const activeResult = observedResult ?? sim.result;
  const activeSensitivity = observedSensitivity ?? sim.sensitivity;

  // analysisMode passed to Dashboard:
  // - "forecast" takes precedence so the ForecastPanel renders in place of
  //   the six-panel grid.
  // - "simulation-multi" intentionally maps to undefined here — the
  //   MultiProposalsPanel renders ABOVE the Dashboard region (Dashboard is
  //   short-circuited), so no banner from the regular path is needed.
  // - Otherwise we defer to the active graph's analysisMode (set by Path A
  //   or Path B flows).
  const dashboardAnalysisMode: "simulation" | "observed" | "forecast" | undefined =
    mode === "forecast" ? "forecast" : graph?.analysisMode;

  const analysisStatus = useMemo(
    () =>
      getAnalysisStatus({
        hasGraph: graph !== null,
        hasResult: activeResult !== null,
        phase: activePhase,
        savedAnalysisId,
        hasUnsavedChanges,
        analysisMode: graph?.analysisMode,
      }),
    [graph, activeResult, activePhase, savedAnalysisId, hasUnsavedChanges]
  );

  const handleSubmit = useCallback(
    async (query: string) => {
      if (!model) {
        setError("Select a model in AI setup before running a custom question.");
        return;
      }

      setIsAnalyzing(true);
      setError(null);
      setCurrentQuery(query);
      setSavedAnalysisId(null);

      try {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query,
            model,
            apiKey: sessionApiKey || undefined,
          }),
        });

        const data = await res.json();

        if (!res.ok) {
          setError(getApiErrorMessage(data, "Analysis failed"));
          return;
        }

        runSimulation(data.graph);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Network error");
      } finally {
        setIsAnalyzing(false);
      }
    },
    [model, runSimulation, sessionApiKey]
  );

  const handleMultiSubmit = useCallback(
    async (query: string) => {
      setIsAnalyzing(true);
      setError(null);
      setCurrentQuery(query);
      setMultiProposals(null);
      setMultiSummary(null);
      try {
        const res = await fetch("/api/analyze/multi", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query,
            apiKey: sessionApiKey || undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(getApiErrorMessage(data, "Multi-proposer failed"));
          return;
        }
        setMultiProposals(data.proposals as ProposalResult[]);
        setMultiSummary(data.summary as MultiSummary);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Network error");
      } finally {
        setIsAnalyzing(false);
      }
    },
    [sessionApiKey]
  );

  const handleUseProposerGraph = useCallback(
    (proposerModel: string, proposerGraph: UncertaintyGraph) => {
      setMode("simulation");
      setCurrentQuery(
        currentQuery
          ? `${currentQuery} (from ${proposerModel})`
          : `Multi-proposer pick: ${proposerModel}`
      );
      runSimulation(proposerGraph);
    },
    [currentQuery, runSimulation]
  );

  const handleRunExample = useCallback(() => {
      setCurrentQuery("PE clinical scenario (pre-built demo)");
      setSavedAnalysisId(null);
      setHasUnsavedChanges(true);
      runSimulation(PE_EXAMPLE_GRAPH);
  }, [runSimulation]);

  const handleRunObservedData = useCallback(
    (analysis: ObservedAnalysisResult) => {
      sim.cancel();
      setGraph(analysis.graph);
      setObservedResult(analysis.result);
      setObservedSensitivity(analysis.sensitivity);
      setObservedMeta({
        targetColumn: analysis.targetColumn,
        rowCount: analysis.rowCount,
        missingCount: analysis.missingCount,
      });
      setAiInsight(null);
      setAiAssistError(null);
      setCurrentQuery(`Observed CSV: ${analysis.targetColumn} (${analysis.rowCount} rows)`);
      setSavedAnalysisId(null);
      setHasUnsavedChanges(true);
      setError(null);
      samplesRef.current = analysis.result.samples;
      setAllSamples(analysis.result.samples);
    },
    [sim]
  );

  const handleAiAssist = useCallback(async () => {
    if (!observedResult || !graph || graph.analysisMode !== "observed") return;
    setAiAssistLoading(true);
    setAiAssistError(null);
    setAiInsight(null);
    try {
      const res = await fetch("/api/real-data/assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: currentQuery ?? "Observed data analysis",
          targetColumn:
            observedMeta?.targetColumn ??
            graph.nodes.find((node) => node.id === "observed_values")?.unit ??
            graph.outputNodeId,
          rowCount: observedMeta?.rowCount ?? observedResult.samples.length,
          missingCount: observedMeta?.missingCount ?? 0,
          mean: observedResult.mean,
          median: observedResult.median,
          ciLow: observedResult.ciLow,
          ciHigh: observedResult.ciHigh,
          pAboveThreshold: observedResult.pAboveThreshold,
          threshold: graph.threshold ?? null,
          model,
          apiKey: sessionApiKey || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAiAssistError(getApiErrorMessage(data, `AI assist failed (${res.status})`));
        return;
      }
      setAiInsight(data.insight);
    } catch (err) {
      setAiAssistError(err instanceof Error ? err.message : "AI assist failed");
    } finally {
      setAiAssistLoading(false);
    }
  }, [currentQuery, graph, model, observedMeta, observedResult, sessionApiKey]);

  const handleNodeClick = useCallback((nodeId: string) => {
    setEditingNodeId(nodeId);
  }, []);

  const handleLoad = useCallback(
    (data: {
      query: string;
      graph: UncertaintyGraph;
      result: SimulationResult | null;
      sensitivity: SensitivityResult[] | null;
      seed: number | null;
      id: string;
    }) => {
      setCurrentQuery(data.query);
      setSavedAnalysisId(data.id);
      setHasUnsavedChanges(false);
      if (data.graph.analysisMode === "observed" && data.result) {
        sim.cancel();
        setGraph(data.graph);
        setObservedResult(data.result);
        setObservedSensitivity(data.sensitivity ?? []);
        setObservedMeta({
          targetColumn:
            data.graph.nodes.find((node) => node.id === "observed_values")?.unit ??
            data.graph.outputNodeId,
          rowCount: data.result.samples.length,
          missingCount: 0,
        });
        setAiInsight(null);
        setAiAssistError(null);
        setAllSamples(data.result.samples);
        samplesRef.current = data.result.samples;
        return;
      }
      runSimulation(data.graph, { seed: data.seed, markUnsaved: false });
    },
    [runSimulation, sim]
  );

  const handleGraphUpdate = useCallback(
    (updatedGraph: UncertaintyGraph) => {
      setHasUnsavedChanges(true);
      runSimulation(updatedGraph);
    },
    [runSimulation]
  );

  return (
    <div className="h-screen flex flex-col bg-[#0a0e1a] relative">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-[#1e293b] flex-shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold text-white font-[family-name:var(--font-geist-sans)]">
            finESS
          </h1>
          <span className="text-xs text-[#64748b]">
            Uncertainty Intelligence
          </span>
        </div>
        {error && (
          <span className="text-xs text-red-400 max-w-md truncate">
            {error}
          </span>
        )}
      </header>

      {/* Mode toggle: simulation | simulation-multi | observed | forecast */}
      <div
        role="tablist"
        aria-label="Analysis mode"
        className="flex items-center gap-1 border-b border-[#1e293b] bg-[#0f1629] px-4 py-2"
      >
        {(
          [
            { id: "observed", label: "Real Data Mode" },
            { id: "forecast", label: "Forecast Mode" },
            { id: "simulation", label: "Simulation (Path A)" },
            { id: "simulation-multi", label: "Multi-Proposer (Path A)" },
          ] as Array<{ id: DashboardMode; label: string }>
        ).map((option) => {
          const active = mode === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setMode(option.id)}
              className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                active
                  ? "bg-[#3b82f6] text-white"
                  : "bg-[#1e293b] text-[#94a3b8] hover:text-white"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {/* Model Selector */}
      <ModelSelector
        selectedModel={model}
        onModelChange={setModel}
        sessionApiKey={sessionApiKey}
        onSessionApiKeyChange={setSessionApiKey}
        onApiKeyAvailabilityChange={setHasUsableAiKey}
      />

      <AnalysisStatusStrip
        status={analysisStatus}
        query={currentQuery}
        seed={graph?.analysisMode === "observed" ? null : sim.result?.seed ?? null}
        onSaveLoad={() => setShowSaveLoad(true)}
        onCalibration={() => {
          if (analysisStatus.canCalibrate) setShowCalibration(true);
        }}
        onAiAssist={handleAiAssist}
        canAiAssist={
          graph?.analysisMode === "observed" &&
          activeResult !== null &&
          Boolean(model) &&
          hasUsableAiKey
        }
        aiAssistLoading={aiAssistLoading}
      />

      {/* Multi-proposer view replaces the Dashboard when active. */}
      {mode === "simulation-multi" ? (
        <div className="flex-1 min-h-0 overflow-y-auto p-2">
          {multiProposals ? (
            <MultiProposalsPanel
              proposals={multiProposals}
              summary={multiSummary ?? undefined}
              onUseGraph={handleUseProposerGraph}
            />
          ) : (
            <div className="rounded-md border border-[#1e293b] bg-[#0f1629] p-6 text-center text-xs text-[#64748b]">
              Enter a query below to fan it out to every configured proposer.
              Each LLM will return a graph (or an error); disagreement is
              surfaced explicitly.
            </div>
          )}
        </div>
      ) : (
        <Dashboard
          nodeNetwork={
            graph === null && sim.phase === "idle" ? (
              <RealDataPanel
                onAnalyze={handleRunObservedData}
                onRunLegacyDemo={handleRunExample}
              />
            ) : (
              <NodeNetwork
                graph={graph}
                sensitivity={activeSensitivity}
                phase={activePhase}
                progress={observedResult ? 1 : sim.progress}
                onNodeClick={handleNodeClick}
              />
            )
          }
          liveDistribution={
            <LiveDistribution
              samples={displaySamples}
              result={activeResult}
              phase={activePhase}
              threshold={graph?.threshold}
            />
          }
          sensitivityRadar={
            <SensitivityRadar
              sensitivity={activeSensitivity}
              phase={activePhase}
            />
          }
          gaugePanel={
            <GaugePanel
              result={activeResult}
              sensitivity={activeSensitivity}
              phase={activePhase}
              progress={observedResult ? 1 : sim.progress}
            />
          }
          spectrumBars={
            <SpectrumBars
              graph={graph}
              nodeSamples={activeResult?.nodeSamples ?? null}
              phase={activePhase}
            />
          }
          narrationStream={
            <NarrationStream
              phase={activePhase}
              progress={observedResult ? 1 : sim.progress}
              narration={graph?.narration ?? null}
              result={activeResult}
              sensitivity={activeSensitivity}
              threshold={graph?.threshold}
              analysisMode={graph?.analysisMode}
              aiInsight={aiInsight}
              aiError={aiAssistError}
            />
          }
          analysisMode={dashboardAnalysisMode}
          forecastPanel={mode === "forecast" ? <ForecastPanel /> : null}
        />
      )}

      {/* Input Bar (hidden in forecast mode; forecast has its own form) */}
      {mode !== "forecast" && (
        <InputBar
          onSubmit={mode === "simulation-multi" ? handleMultiSubmit : handleSubmit}
          isLoading={isAnalyzing || sim.phase === "running"}
          onRunExample={handleRunExample}
          inputRef={inputRef}
        />
      )}

      {/* Node Editor Modal */}
      {editingNodeId && graph && (
        <NodeEditor
          graph={graph}
          selectedNodeId={editingNodeId}
          onGraphUpdate={handleGraphUpdate}
          onClose={() => setEditingNodeId(null)}
        />
      )}

      {/* Save/Load Modal */}
      <SaveLoadModal
        isOpen={showSaveLoad}
        onClose={() => setShowSaveLoad(false)}
        query={currentQuery}
        graph={graph}
        result={activeResult}
        sensitivity={activeSensitivity}
        onLoad={handleLoad}
        onSave={(id) => {
          setSavedAnalysisId(id);
          setHasUnsavedChanges(false);
        }}
      />

      {/* Calibration Modal */}
      <CalibrationModal
        isOpen={showCalibration}
        onClose={() => setShowCalibration(false)}
        analysisId={savedAnalysisId}
        predictedProbability={activeResult?.pAboveThreshold ?? null}
      />
    </div>
  );
}
