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
import { FirstRunPanel } from "@/components/FirstRunPanel";
import NodeNetwork from "@/components/panels/NodeNetwork";
import LiveDistribution from "@/components/panels/LiveDistribution";
import SensitivityRadar from "@/components/panels/SensitivityRadar";
import GaugePanel from "@/components/panels/GaugePanel";
import SpectrumBars from "@/components/panels/SpectrumBars";
import { useSimulation } from "@/lib/engine/use-simulation";
import { PE_EXAMPLE_GRAPH } from "@/lib/examples/pe-scenario";
import { getAnalysisStatus } from "@/lib/ui/analysis-status";
import type { UncertaintyGraph, SimulationResult, SensitivityResult } from "@/lib/types";

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
    sim.phase === "complete" && sim.result
      ? sim.result.samples
      : allSamples;

  const analysisStatus = useMemo(
    () =>
      getAnalysisStatus({
        hasGraph: graph !== null,
        hasResult: sim.result !== null,
        phase: sim.phase,
        savedAnalysisId,
        hasUnsavedChanges,
      }),
    [graph, sim.result, sim.phase, savedAnalysisId, hasUnsavedChanges]
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
          body: JSON.stringify({ query, model }),
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
    [model, runSimulation]
  );

  const handleRunExample = useCallback(() => {
      setCurrentQuery("PE clinical scenario (pre-built demo)");
      setSavedAnalysisId(null);
      setHasUnsavedChanges(true);
      runSimulation(PE_EXAMPLE_GRAPH);
  }, [runSimulation]);

  const handleFocusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);

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
      if (data.result) {
        setAllSamples(data.result.samples);
        samplesRef.current = data.result.samples;
      }
      // Run the simulation fresh with the loaded graph
      runSimulation(data.graph, { seed: data.seed, markUnsaved: false });
    },
    [runSimulation]
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

      {/* Model Selector */}
      <ModelSelector selectedModel={model} onModelChange={setModel} />

      <AnalysisStatusStrip
        status={analysisStatus}
        query={currentQuery}
        seed={sim.result?.seed ?? null}
        onSaveLoad={() => setShowSaveLoad(true)}
        onCalibration={() => {
          if (analysisStatus.canCalibrate) setShowCalibration(true);
        }}
      />

      {/* Dashboard */}
      <Dashboard
        nodeNetwork={
          graph === null && sim.phase === "idle" ? (
            <FirstRunPanel
              onRunExample={handleRunExample}
              onFocusInput={handleFocusInput}
            />
          ) : (
            <NodeNetwork
              graph={graph}
              sensitivity={sim.sensitivity}
              phase={sim.phase}
              progress={sim.progress}
              onNodeClick={handleNodeClick}
            />
          )
        }
        liveDistribution={
          <LiveDistribution
            samples={displaySamples}
            result={sim.result}
            phase={sim.phase}
            threshold={graph?.threshold}
          />
        }
        sensitivityRadar={
          <SensitivityRadar
            sensitivity={sim.sensitivity}
            phase={sim.phase}
          />
        }
        gaugePanel={
          <GaugePanel
            result={sim.result}
            sensitivity={sim.sensitivity}
            phase={sim.phase}
            progress={sim.progress}
          />
        }
        spectrumBars={
          <SpectrumBars
            graph={graph}
            nodeSamples={sim.result?.nodeSamples ?? null}
            phase={sim.phase}
          />
        }
        narrationStream={
          <NarrationStream
            phase={sim.phase}
            progress={sim.progress}
            narration={graph?.narration ?? null}
            result={sim.result}
            sensitivity={sim.sensitivity}
            threshold={graph?.threshold}
          />
        }
      />

      {/* Input Bar */}
      <InputBar
        onSubmit={handleSubmit}
        isLoading={isAnalyzing || sim.phase === "running"}
        onRunExample={handleRunExample}
        inputRef={inputRef}
      />

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
        result={sim.result}
        sensitivity={sim.sensitivity}
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
        predictedProbability={sim.result?.pAboveThreshold ?? null}
      />
    </div>
  );
}
