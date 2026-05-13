"use client";

import { useState, useCallback, useRef } from "react";
import { Dashboard } from "@/components/Dashboard";
import { InputBar } from "@/components/InputBar";
import { ModelSelector } from "@/components/ModelSelector";
import { NarrationStream } from "@/components/NarrationStream";
import { NodeEditor } from "@/components/NodeEditor";
import NodeNetwork from "@/components/panels/NodeNetwork";
import LiveDistribution from "@/components/panels/LiveDistribution";
import SensitivityRadar from "@/components/panels/SensitivityRadar";
import GaugePanel from "@/components/panels/GaugePanel";
import SpectrumBars from "@/components/panels/SpectrumBars";
import { useSimulation } from "@/lib/engine/use-simulation";
import { PE_EXAMPLE_GRAPH } from "@/lib/examples/pe-scenario";
import type { UncertaintyGraph } from "@/lib/types";

export default function Home() {
  const [model, setModel] = useState("");
  const [graph, setGraph] = useState<UncertaintyGraph | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allSamples, setAllSamples] = useState<number[]>([]);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);

  const sim = useSimulation();

  // Accumulate samples from batches
  const samplesRef = useRef<number[]>([]);

  const runSimulation = useCallback(
    (g: UncertaintyGraph) => {
      setGraph(g);
      setError(null);
      samplesRef.current = [];
      setAllSamples([]);

      sim.start(g, { seed: g === PE_EXAMPLE_GRAPH ? 42 : undefined });
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

  const handleSubmit = useCallback(
    async (query: string) => {
      if (!model) {
        setError("Please select an AI model first.");
        return;
      }

      setIsAnalyzing(true);
      setError(null);

      try {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, model }),
        });

        const data = await res.json();

        if (!res.ok) {
          setError(data.error || "Analysis failed");
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
    runSimulation(PE_EXAMPLE_GRAPH);
  }, [runSimulation]);

  const handleNodeClick = useCallback((nodeId: string) => {
    setEditingNodeId(nodeId);
  }, []);

  const handleGraphUpdate = useCallback(
    (updatedGraph: UncertaintyGraph) => {
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

      {/* Dashboard */}
      <Dashboard
        nodeNetwork={
          <NodeNetwork
            graph={graph}
            sensitivity={sim.sensitivity}
            phase={sim.phase}
            progress={sim.progress}
            onNodeClick={handleNodeClick}
          />
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
    </div>
  );
}
