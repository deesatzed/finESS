/**
 * Web Worker for Monte Carlo simulation.
 * Runs simulation in a background thread and streams batches via postMessage.
 *
 * Usage: new Worker(new URL('./worker.ts', import.meta.url))
 */
import { runSimulationBatched } from "./monte-carlo";
import { computeSensitivity } from "./sensitivity";
import type { WorkerMessage, WorkerResponse } from "@/lib/types";

// Web Worker context
const ctx = self as unknown as Worker;

ctx.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data;

  if (msg.type === "start") {
    try {
      const result = runSimulationBatched(msg.graph, msg.config, (batch) => {
        const response: WorkerResponse = { type: "batch", batch };
        ctx.postMessage(response);
      });

      const sensitivity = computeSensitivity(msg.graph, {
        ...msg.config,
        // Use fewer samples for sensitivity (it runs N * numNodes simulations)
        numSamples: Math.min(msg.config.numSamples, 5000),
      });

      const response: WorkerResponse = {
        type: "complete",
        result,
        sensitivity,
      };
      ctx.postMessage(response);
    } catch (error) {
      const response: WorkerResponse = {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      };
      ctx.postMessage(response);
    }
  }
};
