"use client";

import { useCallback, useState } from "react";
import { ForecastInputForm, type ForecastFormSubmit } from "@/components/ForecastInputForm";
import { ForecastResultView } from "@/components/ForecastResultView";
import CalibrationModal from "@/components/CalibrationModal";
import type { ForecastResponse } from "@/lib/forecast/types";

type LoadingPhase = "idle" | "training" | "predicting";

interface ForecastPanelProps {
  /** Optional override for tests; defaults to /api/forecast. */
  apiPath?: string;
}

/**
 * ForecastPanel — Forecast Mode entry point.
 *
 * Owns the full flow:
 *   1. Renders the positive honesty banner.
 *   2. Renders the input form OR the loading state OR the result view.
 *   3. Calls POST /api/forecast.
 *   4. Opens the CalibrationModal in forecast mode when the user clicks
 *      "Save outcome" — this is what closes the R6-06 learning loop.
 *   5. Tracks the observation_count returned by /api/calibration so the
 *      next forecast view can show "learning active" without re-polling.
 */
export function ForecastPanel({ apiPath = "/api/forecast" }: ForecastPanelProps) {
  const [phase, setPhase] = useState<LoadingPhase>("idle");
  const [result, setResult] = useState<ForecastResponse | null>(null);
  const [targetColumn, setTargetColumn] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [calibrationOpen, setCalibrationOpen] = useState<boolean>(false);
  const [observationCountByColumn, setObservationCountByColumn] = useState<
    Record<string, number>
  >({});

  const handleSubmit = useCallback(
    async (input: ForecastFormSubmit) => {
      setPhase("training");
      setError(null);
      setResult(null);
      setTargetColumn(input.targetColumn);

      // Switch the loading caption shortly after the request kicks off
      // so the user sees the two-stage nature of the workload.
      const predictTimer = setTimeout(() => {
        setPhase((current) => (current === "training" ? "predicting" : current));
      }, 1200);

      try {
        const response = await fetch(apiPath, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        const data = await response.json();
        if (!response.ok) {
          const message =
            (data && data.error && typeof data.error.message === "string"
              ? data.error.message
              : null) ?? `Forecast failed (${response.status})`;
          setError(message);
          setPhase("idle");
          return;
        }
        const parsed = data as ForecastResponse;
        setResult(parsed);
        // Cache the sidecar-reported observation_count for this column so
        // we can render the "Learning active" indicator even if the user
        // navigates away and comes back to a fresh forecast.
        if (parsed.forecast?.observation_count !== undefined) {
          setObservationCountByColumn((prev) => ({
            ...prev,
            [input.targetColumn]: parsed.forecast.observation_count ?? 0,
          }));
        }
        setPhase("idle");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Forecast request failed");
        setPhase("idle");
      } finally {
        clearTimeout(predictTimer);
      }
    },
    [apiPath],
  );

  const handleReset = useCallback(() => {
    setResult(null);
    setTargetColumn("");
    setError(null);
    setPhase("idle");
  }, []);

  const handleOpenCalibration = useCallback(() => {
    setCalibrationOpen(true);
  }, []);

  const handleForecastOutcomeRecorded = useCallback(
    (count: number) => {
      // Mark this forecast id as saved + bump the per-column counter so
      // the "learning active" indicator updates immediately.
      if (result) {
        setSavedIds((prev) => {
          if (prev.has(result.forecastId)) return prev;
          const next = new Set(prev);
          next.add(result.forecastId);
          return next;
        });
      }
      if (targetColumn) {
        setObservationCountByColumn((prev) => ({
          ...prev,
          [targetColumn]: count,
        }));
      }
    },
    [result, targetColumn],
  );

  const loading = phase !== "idle";
  const currentObservationCount = targetColumn
    ? observationCountByColumn[targetColumn] ?? 0
    : 0;

  return (
    <div className="h-full overflow-y-auto px-4 py-4">
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        <ForecastHonestyBanner />

        <div className="space-y-1">
          <p className="text-xs uppercase tracking-[0.18em] text-[#64748b]">
            Forecast Mode
          </p>
          <h2 className="text-2xl font-semibold text-white">
            Real ensemble forecast
          </h2>
          <p className="text-sm leading-5 text-[#94a3b8]">
            Upload a time-series CSV, choose the date and target columns, and
            run the production ensemble against your data.
          </p>
        </div>

        {!result && (
          <ForecastInputForm
            onSubmit={handleSubmit}
            disabled={loading}
            serverError={error}
          />
        )}

        {loading && (
          <div className="rounded-md border border-[#1e293b] bg-[#0f1629] p-4 text-sm text-[#94a3b8]">
            {phase === "training" ? "Training ensemble..." : "Predicting..."}
          </div>
        )}

        {result && !loading && (
          <>
            <ForecastResultView
              response={result}
              targetColumn={targetColumn}
              onOpenCalibration={handleOpenCalibration}
              savedForCalibration={savedIds.has(result.forecastId)}
              observationCount={currentObservationCount}
            />
            <div>
              <button
                type="button"
                onClick={handleReset}
                className="rounded border border-[#334155] bg-[#1e293b] px-4 py-2 text-sm font-medium text-[#cbd5e1] hover:text-white"
              >
                Run another forecast
              </button>
            </div>
          </>
        )}
      </div>

      {result && (
        <CalibrationModal
          isOpen={calibrationOpen}
          onClose={() => setCalibrationOpen(false)}
          forecast={{
            forecastId: result.forecastId,
            targetColumn,
            ensemblePrediction: result.forecast.prediction,
            modelPredictions: result.forecast.individual_predictions,
          }}
          onForecastOutcomeRecorded={handleForecastOutcomeRecorded}
        />
      )}
    </div>
  );
}

/**
 * Positive honesty banner for Forecast Mode.
 *
 * Mirrors PathADraftBanner's pattern but is GREEN, role="status", and
 * highlights what the ensemble IS doing (real models, real disagreement)
 * instead of warning what an LLM-drafted graph isn't. The contrast with
 * the amber Path A banner is intentional product copy.
 */
export function ForecastHonestyBanner({ className = "" }: { className?: string }) {
  return (
    <div
      role="status"
      className={`rounded-md border-l-4 border-emerald-500 bg-emerald-100 px-3 py-2 text-xs text-emerald-900 ${className}`}
    >
      <p className="leading-5">
        <span className="font-semibold">Real ensemble forecast.</span>{" "}
        This uses 7 base forecasters trained on your data, not an LLM. The
        per-model weights and individual predictions show where the models
        agree and disagree — disagreement is the honest uncertainty.
      </p>
    </div>
  );
}

export default ForecastPanel;
