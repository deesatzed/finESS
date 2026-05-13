"use client";

import { useState, useRef, useCallback } from "react";
import type {
  UncertaintyGraph,
  SimulationConfig,
  SimulationResult,
  SimulationBatch,
  SimulationPhase,
  SensitivityResult,
  WorkerMessage,
  WorkerResponse,
} from "@/lib/types";

const DEFAULT_CONFIG: SimulationConfig = {
  numSamples: 15000,
  batchSize: 500,
};

export interface UseSimulationReturn {
  phase: SimulationPhase;
  currentBatch: SimulationBatch | null;
  result: SimulationResult | null;
  sensitivity: SensitivityResult[] | null;
  error: string | null;
  progress: number;
  start: (graph: UncertaintyGraph, config?: Partial<SimulationConfig>) => void;
  cancel: () => void;
}

export function useSimulation(): UseSimulationReturn {
  const [phase, setPhase] = useState<SimulationPhase>("idle");
  const [currentBatch, setCurrentBatch] = useState<SimulationBatch | null>(
    null
  );
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [sensitivity, setSensitivity] = useState<SensitivityResult[] | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const workerRef = useRef<Worker | null>(null);

  const cancel = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    setPhase("idle");
    setProgress(0);
  }, []);

  const start = useCallback(
    (graph: UncertaintyGraph, configOverrides?: Partial<SimulationConfig>) => {
      // Clean up previous worker
      if (workerRef.current) {
        workerRef.current.terminate();
      }

      const config: SimulationConfig = {
        ...DEFAULT_CONFIG,
        ...configOverrides,
      };

      const totalBatches = Math.ceil(config.numSamples / config.batchSize);

      setPhase("running");
      setResult(null);
      setSensitivity(null);
      setError(null);
      setProgress(0);
      setCurrentBatch(null);

      const worker = new Worker(
        new URL("./worker.ts", import.meta.url)
      );
      workerRef.current = worker;

      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const msg = event.data;

        switch (msg.type) {
          case "batch":
            setCurrentBatch(msg.batch);
            setProgress((msg.batch.batchIndex + 1) / totalBatches);
            break;

          case "complete":
            setResult(msg.result);
            setSensitivity(msg.sensitivity);
            setPhase("complete");
            setProgress(1);
            worker.terminate();
            workerRef.current = null;
            break;

          case "error":
            setError(msg.message);
            setPhase("error");
            worker.terminate();
            workerRef.current = null;
            break;
        }
      };

      worker.onerror = (event) => {
        setError(event.message || "Worker error");
        setPhase("error");
        worker.terminate();
        workerRef.current = null;
      };

      const message: WorkerMessage = { type: "start", graph, config };
      worker.postMessage(message);
    },
    []
  );

  return {
    phase,
    currentBatch,
    result,
    sensitivity,
    error,
    progress,
    start,
    cancel,
  };
}
