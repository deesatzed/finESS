"use client";

import { useMemo } from "react";
import {
  describeRegime,
  type ForecastResponse,
} from "@/lib/forecast/types";

interface ForecastResultViewProps {
  response: ForecastResponse;
  targetColumn: string;
  /** Click handler for "Save outcome" — parent owns the modal lifecycle. */
  onOpenCalibration?: (forecastId: string) => void;
  /** True if the user has already recorded an outcome for this forecast. */
  savedForCalibration?: boolean;
  /** R6-06: number of outcomes accumulated for this column on the sidecar. */
  observationCount?: number;
}

function formatNumber(value: number, fractionDigits = 2): string {
  if (!Number.isFinite(value)) return String(value);
  if (Math.abs(value) >= 1000) {
    return value.toLocaleString(undefined, {
      maximumFractionDigits: fractionDigits,
    });
  }
  return value.toFixed(fractionDigits);
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function ForecastResultView({
  response,
  targetColumn,
  onOpenCalibration,
  savedForCalibration = false,
  observationCount = 0,
}: ForecastResultViewProps) {
  const { forecast, forecastId, slsqpWeights } = response;

  const sortedWeights = useMemo(
    () =>
      Object.entries(forecast.model_weights).sort((a, b) => b[1] - a[1]),
    [forecast.model_weights],
  );

  const maxWeight = sortedWeights.length > 0 ? sortedWeights[0][1] : 1;

  const individualPredictions = useMemo(
    () =>
      Object.entries(forecast.individual_predictions).sort((a, b) => b[1] - a[1]),
    [forecast.individual_predictions],
  );

  const slsqpEntries = useMemo(() => Object.entries(slsqpWeights), [slsqpWeights]);

  // R6-06: prefer the live observation_count attached to the forecast
  // response (when /predict reports it) over the one polled from /priors.
  const liveObservationCount =
    forecast.observation_count !== undefined
      ? forecast.observation_count
      : observationCount;
  const priorsApplied = forecast.priors_applied === true;

  return (
    <div className="flex flex-col gap-4 text-[#e2e8f0]">
      <section className="rounded-lg border border-[#1e293b] bg-[#0f1629] p-4">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-[#64748b]">
              Ensemble forecast
            </p>
            <p className="text-sm text-[#94a3b8]">{targetColumn}</p>
          </div>
          <div className="text-right">
            <p className="text-3xl font-semibold text-white">
              {formatNumber(forecast.prediction)}
            </p>
            <p className="text-xs text-[#94a3b8]">
              95% CI [{formatNumber(forecast.lower_95)}, {formatNumber(forecast.upper_95)}]
            </p>
          </div>
        </div>
      </section>

      {liveObservationCount > 0 && (
        <section
          className="rounded-lg border border-emerald-700 bg-emerald-900/20 px-4 py-3 text-xs text-emerald-200"
          role="status"
        >
          <p className="leading-5">
            <span className="font-semibold">Learning active.</span>{" "}
            {priorsApplied
              ? `Weights re-optimised against ${liveObservationCount} recorded outcome${liveObservationCount === 1 ? "" : "s"} for ${targetColumn}.`
              : `${liveObservationCount} outcome${liveObservationCount === 1 ? "" : "s"} recorded for ${targetColumn}; weights will re-optimise on next forecast once enough per-model history accumulates.`}
          </p>
        </section>
      )}

      <section className="rounded-lg border border-[#1e293b] bg-[#0f1629] p-4">
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-[#64748b]">
          Per-model weights (SLSQP optimised)
        </h4>
        <p className="mb-3 text-xs text-[#94a3b8]">
          Weights show which base models drive the ensemble prediction. They
          are constrained to sum to 1.
        </p>
        <div className="flex flex-col gap-1.5">
          {sortedWeights.map(([model, weight]) => (
            <div key={model} className="grid grid-cols-[120px_1fr_60px] items-center gap-2 text-xs">
              <span className="font-[family-name:var(--font-geist-mono)] text-[#cbd5e1]">
                {model}
              </span>
              <div className="h-2 rounded bg-[#1e293b]">
                <div
                  className="h-2 rounded bg-[#3b82f6]"
                  style={{
                    width: `${Math.max(2, (weight / Math.max(maxWeight, 1e-9)) * 100)}%`,
                  }}
                />
              </div>
              <span className="text-right font-[family-name:var(--font-geist-mono)] text-[#94a3b8]">
                {percentage(weight)}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-[#1e293b] bg-[#0f1629] p-4">
        <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-[#64748b]">
          Individual model predictions
        </h4>
        <p className="mb-3 text-xs text-[#94a3b8]">
          What each base model predicted on its own. Spread across this list is
          the honest model-disagreement uncertainty.
        </p>
        <table className="w-full text-xs">
          <thead className="text-[#64748b]">
            <tr>
              <th className="py-1 text-left font-normal">Model</th>
              <th className="py-1 text-right font-normal">Prediction</th>
            </tr>
          </thead>
          <tbody>
            {individualPredictions.map(([model, pred]) => (
              <tr key={model} className="border-t border-[#1e293b]">
                <td className="py-1 font-[family-name:var(--font-geist-mono)] text-[#cbd5e1]">
                  {model}
                </td>
                <td className="py-1 text-right font-[family-name:var(--font-geist-mono)] text-[#e2e8f0]">
                  {formatNumber(pred)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="rounded-lg border border-[#1e293b] bg-[#0f1629] p-4">
        <h4 className="mb-1 text-xs font-medium uppercase tracking-wider text-[#64748b]">
          Regime detection (AR(1))
        </h4>
        <p className="text-sm text-white">
          {forecast.regime_type}{" "}
          <span className="text-xs text-[#94a3b8]">(rho = {forecast.rho.toFixed(3)})</span>
        </p>
        <p className="mt-1 text-xs text-[#94a3b8]">
          {describeRegime(forecast.regime_type)}
        </p>
      </section>

      {slsqpEntries.length > 0 && (
        <details className="rounded-lg border border-[#1e293b] bg-[#0f1629] p-4">
          <summary className="cursor-pointer text-xs font-medium uppercase tracking-wider text-[#64748b]">
            Trained SLSQP weights (for transparency)
          </summary>
          <table className="mt-2 w-full text-xs">
            <tbody>
              {slsqpEntries.map(([model, weight]) => (
                <tr key={model} className="border-t border-[#1e293b]">
                  <td className="py-1 font-[family-name:var(--font-geist-mono)] text-[#cbd5e1]">
                    {model}
                  </td>
                  <td className="py-1 text-right font-[family-name:var(--font-geist-mono)] text-[#94a3b8]">
                    {percentage(weight)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      <section className="flex flex-wrap items-center gap-3 rounded-lg border border-[#1e293b] bg-[#0f1629] p-4 text-xs text-[#94a3b8]">
        <span className="font-[family-name:var(--font-geist-mono)] text-[#cbd5e1]">
          forecastId: {forecastId}
        </span>
        <button
          type="button"
          onClick={() => onOpenCalibration?.(forecastId)}
          disabled={savedForCalibration || !onOpenCalibration}
          className="rounded border border-[#334155] bg-[#1e293b] px-3 py-1.5 text-xs font-medium text-[#cbd5e1] hover:text-white disabled:cursor-not-allowed disabled:text-[#64748b]"
        >
          {savedForCalibration ? "Outcome saved" : "Save outcome"}
        </button>
        <span className="text-[10px] text-[#64748b]">
          Recording the real observed value updates the ensemble&apos;s
          learned weights via the calibration loop.
        </span>
      </section>
    </div>
  );
}

export default ForecastResultView;
