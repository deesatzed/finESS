"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { ensureLocalSession } from "@/lib/auth/client";

// ============================================================
// CalibrationModal — Record outcomes & view calibration curve
// ============================================================
//
// Two modes, picked by which props are supplied:
//
//   * "analysis" — the default; pass `analysisId` + `predictedProbability`.
//     The legacy Path A flow. POSTs {analysisId, predictedProbability,
//     actualOutcome:true|false}.
//
//   * "forecast" — pass the `forecast` prop instead. The user enters the
//     real observed numeric value; the modal forwards it together with the
//     per-base-model predictions to /api/calibration, which in turn calls
//     the ensemble sidecar's /outcome so the next forecast on the same
//     column re-optimises SLSQP weights against the new Beta priors.

interface ForecastCalibrationContext {
  forecastId: string;
  targetColumn: string;
  /** The ensemble's combined prediction (informational only). */
  ensemblePrediction: number;
  /** Per-base-model predictions returned by /api/forecast. Required. */
  modelPredictions: Record<string, number>;
}

interface CalibrationModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Analysis branch — supply both for Path A graphs. */
  analysisId?: string | null;
  predictedProbability?: number | null;
  /** Forecast branch (R6-06) — supply for Forecast Mode results. */
  forecast?: ForecastCalibrationContext | null;
  /** Called after a successful forecast outcome save with the new observation count. */
  onForecastOutcomeRecorded?: (observationCount: number) => void;
}

// -- API response types ---------------------------------------

interface CalibrationNotReady {
  ready: false;
  count: number;
  needed: number;
  message: string;
}

interface CalibrationBin {
  predicted: number;
  actual: number;
  count: number;
}

interface ReliabilityBin {
  lowerBin: number;
  upperBin: number;
  count: number;
  predictedMean: number;
  observedFrequency: number;
}

interface ReliabilityReport {
  bins: ReliabilityBin[];
  totalCount: number;
  isReliable: boolean;
}

interface CalibrationReady {
  ready: true;
  count: number;
  calibrationCurve: CalibrationBin[];
  // C5a: full reliability report including empty bins (count===0). Used by
  // the canvas to render empty-bin indicators transparently (D — P2 fix).
  reliability?: ReliabilityReport;
  // C5b: Brier score for the same outcome set. NaN when count===0 (defensive
  // — the ready=true branch implies count>=20 so brierScore should always be
  // finite here). brierCount is the number of outcomes that contributed.
  brierScore?: number;
  brierCount?: number;
}

type CalibrationData = CalibrationNotReady | CalibrationReady;

interface RecordOutcomeResponse {
  id: string;
  sidecarStatus?: "updated" | "down" | "error" | "skipped";
  observationCount?: number;
  sidecarReason?: string;
}

// -- Color constants ------------------------------------------

const BG = "#0f1629";
const BORDER = "#1e293b";
const TEXT_PRIMARY = "#e2e8f0";
const TEXT_SECONDARY = "#94a3b8";
const TEXT_DIM = "#64748b";
const ACCENT_BLUE = "#3b82f6";
const ACCENT_GREEN = "#22c55e";
const ACCENT_RED = "#ef4444";
const ACCENT_AMBER = "#f59e0b";
const CANVAS_BG = "#0f1629";
const GRID_LINE = "#1e293b";
const DOT_COLOR = "#3b82f6";
const PERFECT_LINE = "#334155";

// -- Canvas drawing constants ---------------------------------

const PAD = { top: 32, right: 24, bottom: 40, left: 48 };
const DOT_RADIUS = 5;
const DOT_RADIUS_MIN = 3;
const DOT_RADIUS_MAX = 10;

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

// =============================================================
// Component
// =============================================================

export default function CalibrationModal({
  isOpen,
  onClose,
  analysisId = null,
  predictedProbability = null,
  forecast = null,
  onForecastOutcomeRecorded,
}: CalibrationModalProps) {
  const mode: "forecast" | "analysis" = forecast ? "forecast" : "analysis";

  // -- State --------------------------------------------------

  const [calibrationData, setCalibrationData] = useState<CalibrationData | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [isFetching, setIsFetching] = useState(false);

  const [isRecording, setIsRecording] = useState(false);
  const [recordSuccess, setRecordSuccess] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [recordedThisOpen, setRecordedThisOpen] = useState(false);
  const [sidecarBanner, setSidecarBanner] = useState<
    null | { status: "updated" | "down" | "error" | "skipped"; observationCount?: number; reason?: string }
  >(null);

  // Forecast-mode input.
  const [actualValueStr, setActualValueStr] = useState<string>("");

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // -- Fetch calibration data on mount / open -----------------

  const fetchCalibration = useCallback(async () => {
    setIsFetching(true);
    setFetchError(null);
    try {
      await ensureLocalSession();
      const res = await fetch("/api/calibration");
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(getApiErrorMessage(body, `Server responded with ${res.status}`));
      }
      const data: CalibrationData = await res.json();
      setCalibrationData(data);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Failed to fetch calibration data");
    } finally {
      setIsFetching(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchCalibration();
      // Reset recording state when modal opens
      setRecordSuccess(false);
      setRecordError(null);
      setRecordedThisOpen(false);
      setSidecarBanner(null);
      // Default the forecast actual to the ensemble's own prediction so the
      // user can tweak it instead of typing from scratch.
      setActualValueStr(
        forecast ? formatNumberInput(forecast.ensemblePrediction) : "",
      );
    }
  }, [isOpen, fetchCalibration, forecast]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  // -- Record outcome (analysis branch) -----------------------

  const recordAnalysisOutcome = async (actualOutcome: boolean) => {
    if (!analysisId || predictedProbability === null || recordedThisOpen) return;

    setIsRecording(true);
    setRecordError(null);
    setRecordSuccess(false);

    try {
      await ensureLocalSession();
      const res = await fetch("/api/calibration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          analysisId,
          predictedProbability,
          actualOutcome,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(getApiErrorMessage(body, `Server responded with ${res.status}`));
      }

      setRecordSuccess(true);
      setRecordedThisOpen(true);
      await fetchCalibration();
    } catch (err) {
      setRecordError(err instanceof Error ? err.message : "Failed to record outcome");
    } finally {
      setIsRecording(false);
    }
  };

  // -- Record outcome (forecast branch) -----------------------

  const recordForecastOutcome = async () => {
    if (!forecast || recordedThisOpen) return;

    const trimmed = actualValueStr.trim();
    const numeric = Number(trimmed);
    if (!trimmed || !Number.isFinite(numeric)) {
      setRecordError("Enter the observed numeric value for the target column.");
      return;
    }

    setIsRecording(true);
    setRecordError(null);
    setRecordSuccess(false);
    setSidecarBanner(null);

    try {
      await ensureLocalSession();
      // Derive a boolean for the calibration curve from the numeric value.
      // "Hit within 10% of the ensemble prediction" is the convention. This
      // is informational only — the load-bearing signal is the numeric
      // actualValue forwarded to the sidecar.
      const tolerance = Math.max(Math.abs(forecast.ensemblePrediction) * 0.1, 0.5);
      const actualOutcome =
        Math.abs(numeric - forecast.ensemblePrediction) <= tolerance;
      const predictedProb = clamp01(0.5);

      const res = await fetch("/api/calibration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          forecastId: forecast.forecastId,
          predictedProbability: predictedProb,
          actualOutcome,
          targetColumn: forecast.targetColumn,
          modelPredictions: forecast.modelPredictions,
          actualValue: numeric,
        }),
      });
      const body = (await res.json().catch(() => null)) as RecordOutcomeResponse | null;
      if (!res.ok) {
        throw new Error(
          getApiErrorMessage(body, `Server responded with ${res.status}`),
        );
      }

      setRecordSuccess(true);
      setRecordedThisOpen(true);
      setSidecarBanner({
        status: body?.sidecarStatus ?? "skipped",
        observationCount: body?.observationCount,
        reason: body?.sidecarReason,
      });
      if (body?.sidecarStatus === "updated" && body.observationCount !== undefined) {
        onForecastOutcomeRecorded?.(body.observationCount);
      }
      await fetchCalibration();
    } catch (err) {
      setRecordError(err instanceof Error ? err.message : "Failed to record outcome");
    } finally {
      setIsRecording(false);
    }
  };

  // -- Canvas drawing -----------------------------------------

  const drawCalibrationCurve = useCallback(
    (curve: CalibrationBin[], reliability?: ReliabilityReport) => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;

      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = rect.width;
      const h = rect.height;

      if (w === 0 || h === 0) return;

      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Clear
      ctx.fillStyle = CANVAS_BG;
      ctx.fillRect(0, 0, w, h);

      const chartX = PAD.left;
      const chartY = PAD.top;
      const chartW = w - PAD.left - PAD.right;
      const chartH = h - PAD.top - PAD.bottom;

      if (chartW <= 0 || chartH <= 0) return;

      // -- Grid lines ------------------------------------------

      ctx.strokeStyle = GRID_LINE;
      ctx.lineWidth = 1;

      const gridSteps = 5; // 0.0, 0.2, 0.4, 0.6, 0.8, 1.0
      for (let i = 0; i <= gridSteps; i++) {
        const frac = i / gridSteps;

        // Vertical grid line
        const gx = chartX + frac * chartW;
        ctx.beginPath();
        ctx.moveTo(gx, chartY);
        ctx.lineTo(gx, chartY + chartH);
        ctx.stroke();

        // Horizontal grid line
        const gy = chartY + chartH - frac * chartH;
        ctx.beginPath();
        ctx.moveTo(chartX, gy);
        ctx.lineTo(chartX + chartW, gy);
        ctx.stroke();
      }

      // -- Perfect calibration diagonal -------------------------

      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = PERFECT_LINE;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(chartX, chartY + chartH);
      ctx.lineTo(chartX + chartW, chartY);
      ctx.stroke();
      ctx.restore();

      // -- Plot data points -------------------------------------

      // Determine max count for scaling dot size
      const maxCount = Math.max(...curve.map((b) => b.count), 1);

      for (const bin of curve) {
        const px = chartX + bin.predicted * chartW;
        const py = chartY + chartH - bin.actual * chartH;

        // Scale dot radius by count
        const sizeT = bin.count / maxCount;
        const radius =
          DOT_RADIUS_MIN + (DOT_RADIUS_MAX - DOT_RADIUS_MIN) * sizeT;

        // Outer glow
        ctx.save();
        ctx.shadowColor = DOT_COLOR;
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(px, py, radius, 0, Math.PI * 2);
        ctx.fillStyle = DOT_COLOR;
        ctx.fill();
        ctx.restore();

        // Inner bright center
        ctx.beginPath();
        ctx.arc(px, py, radius * 0.5, 0, Math.PI * 2);
        ctx.fillStyle = "#93c5fd";
        ctx.fill();

        // Count label near the dot (if enough room)
        if (bin.count >= 2 && radius >= DOT_RADIUS) {
          ctx.fillStyle = TEXT_DIM;
          ctx.font = "9px ui-monospace, monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          ctx.fillText(`n=${bin.count}`, px, py - radius - 3);
        }
      }

      // -- Empty-bin indicators (D — P2) -----------------------
      // Render bins with no data as small hollow tick marks on the
      // x-axis so the operator can see "we have no calibration data
      // in the 0.4–0.5 range" rather than a silent gap.

      if (reliability) {
        const emptyBins = reliability.bins.filter((b) => b.count === 0);
        ctx.save();
        ctx.strokeStyle = "#475569"; // slate-600 — muted, not distracting
        ctx.lineWidth = 1;
        for (const b of emptyBins) {
          const binMid = (b.lowerBin + b.upperBin) / 2;
          const bx = chartX + binMid * chartW;
          const by = chartY + chartH;
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.lineTo(bx, by - 6);
          ctx.stroke();
          // Hollow circle at the tick top to visually distinguish from data
          ctx.beginPath();
          ctx.arc(bx, by - 8, 3, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      }

      // -- Axis labels ------------------------------------------

      ctx.fillStyle = TEXT_DIM;
      ctx.font = "10px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";

      // X-axis tick labels
      for (let i = 0; i <= gridSteps; i++) {
        const frac = i / gridSteps;
        const x = chartX + frac * chartW;
        ctx.fillText(frac.toFixed(1), x, chartY + chartH + 6);
      }

      // X-axis title
      ctx.fillStyle = TEXT_SECONDARY;
      ctx.font = "11px ui-monospace, monospace";
      ctx.fillText("Predicted Probability", chartX + chartW / 2, chartY + chartH + 22);

      // Y-axis tick labels
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillStyle = TEXT_DIM;
      ctx.font = "10px ui-monospace, monospace";
      for (let i = 0; i <= gridSteps; i++) {
        const frac = i / gridSteps;
        const y = chartY + chartH - frac * chartH;
        ctx.fillText(frac.toFixed(1), chartX - 8, y);
      }

      // Y-axis title
      ctx.save();
      ctx.fillStyle = TEXT_SECONDARY;
      ctx.font = "11px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.translate(14, chartY + chartH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText("Actual Frequency", 0, 0);
      ctx.restore();

      // -- Chart title ------------------------------------------

      ctx.fillStyle = TEXT_PRIMARY;
      ctx.font = "12px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText("Calibration Curve", chartX + chartW / 2, 8);

      // -- Legend: diagonal line label ---------------------------

      ctx.fillStyle = TEXT_DIM;
      ctx.font = "9px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText("perfect calibration", chartX + chartW * 0.55, chartY + chartH * 0.4);
    },
    []
  );

  // -- Redraw canvas when data changes or container resizes ----

  useEffect(() => {
    if (!isOpen) return;
    if (!calibrationData || !calibrationData.ready) return;

    const curve = calibrationData.calibrationCurve;
    const reliability = calibrationData.reliability;
    drawCalibrationCurve(curve, reliability);

    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      drawCalibrationCurve(curve, reliability);
    });
    observer.observe(container);

    return () => observer.disconnect();
  }, [isOpen, calibrationData, drawCalibrationCurve]);

  // -- Render -------------------------------------------------

  if (!isOpen) return null;

  const hasAnalysis = mode === "analysis" && analysisId !== null;
  const hasPrediction = mode === "analysis" && predictedProbability !== null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg border"
        style={{
          background: BG,
          borderColor: BORDER,
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3 border-b"
          style={{ borderColor: BORDER }}
        >
          <h2
            className="text-sm font-semibold uppercase tracking-wider"
            style={{ color: TEXT_DIM }}
          >
            Calibration
          </h2>
          <button
            onClick={onClose}
            className="text-sm px-2 py-1 rounded transition-colors"
            style={{ color: TEXT_DIM }}
            onMouseEnter={(e) => (e.currentTarget.style.color = TEXT_PRIMARY)}
            onMouseLeave={(e) => (e.currentTarget.style.color = TEXT_DIM)}
          >
            Close
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-6">
          {/* ---- Section 1: Record Outcome ---- */}
          <section>
            <h3
              className="text-xs font-medium uppercase tracking-wider mb-3"
              style={{ color: TEXT_DIM }}
            >
              {mode === "forecast" ? "Record Real Outcome" : "Record Outcome"}
            </h3>

            {mode === "forecast" && forecast ? (
              <ForecastOutcomeForm
                forecast={forecast}
                actualValueStr={actualValueStr}
                onActualValueChange={setActualValueStr}
                isRecording={isRecording}
                recordedThisOpen={recordedThisOpen}
                recordError={recordError}
                recordSuccess={recordSuccess}
                sidecarBanner={sidecarBanner}
                onSubmit={recordForecastOutcome}
              />
            ) : !hasAnalysis ? (
              <div
                className="rounded px-4 py-3 text-sm border"
                style={{
                  background: "#1e293b",
                  borderColor: BORDER,
                  color: TEXT_SECONDARY,
                }}
              >
                Save your analysis first to record outcomes
              </div>
            ) : recordSuccess ? (
              <div
                className="rounded px-4 py-3 text-sm border"
                style={{
                  background: "rgba(34, 197, 94, 0.1)",
                  borderColor: ACCENT_GREEN,
                  color: ACCENT_GREEN,
                }}
              >
                Outcome recorded successfully.
              </div>
            ) : (
              <div className="space-y-3">
                {/* Show predicted probability */}
                {hasPrediction && predictedProbability !== null && (
                  <div
                    className="text-sm"
                    style={{ color: TEXT_SECONDARY }}
                  >
                    Predicted probability:{" "}
                    <span
                      className="font-mono font-semibold"
                      style={{ color: TEXT_PRIMARY }}
                    >
                      {(predictedProbability * 100).toFixed(1)}%
                    </span>
                  </div>
                )}

                {/* Error message */}
                {recordError && (
                  <div
                    className="rounded px-3 py-2 text-xs border"
                    style={{
                      background: "rgba(239, 68, 68, 0.1)",
                      borderColor: ACCENT_RED,
                      color: ACCENT_RED,
                    }}
                  >
                    {recordError}
                  </div>
                )}

                {/* Outcome buttons */}
                <div className="flex gap-3">
                  <button
                    onClick={() => recordAnalysisOutcome(true)}
                    disabled={isRecording || !hasPrediction || recordedThisOpen}
                    className="flex-1 rounded px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{
                      background: isRecording
                        ? "rgba(34, 197, 94, 0.2)"
                        : "rgba(34, 197, 94, 0.15)",
                      border: `1px solid ${ACCENT_GREEN}`,
                      color: ACCENT_GREEN,
                    }}
                    onMouseEnter={(e) => {
                      if (!isRecording) {
                        e.currentTarget.style.background =
                          "rgba(34, 197, 94, 0.25)";
                      }
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background =
                        "rgba(34, 197, 94, 0.15)";
                    }}
                  >
                    {isRecording ? "Recording..." : "It happened"}
                  </button>

                  <button
                    onClick={() => recordAnalysisOutcome(false)}
                    disabled={isRecording || !hasPrediction || recordedThisOpen}
                    className="flex-1 rounded px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{
                      background: isRecording
                        ? "rgba(239, 68, 68, 0.2)"
                        : "rgba(239, 68, 68, 0.15)",
                      border: `1px solid ${ACCENT_RED}`,
                      color: ACCENT_RED,
                    }}
                    onMouseEnter={(e) => {
                      if (!isRecording) {
                        e.currentTarget.style.background =
                          "rgba(239, 68, 68, 0.25)";
                      }
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background =
                        "rgba(239, 68, 68, 0.15)";
                    }}
                  >
                    {isRecording ? "Recording..." : "It didn't happen"}
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* Divider */}
          <div style={{ borderTop: `1px solid ${BORDER}` }} />

          {/* ---- Section 2: Calibration Curve ---- */}
          <section>
            <h3
              className="text-xs font-medium uppercase tracking-wider mb-3"
              style={{ color: TEXT_DIM }}
            >
              Calibration Curve
            </h3>

            {isFetching && !calibrationData ? (
              <div
                className="text-sm py-4 text-center"
                style={{ color: TEXT_DIM }}
              >
                Loading calibration data...
              </div>
            ) : fetchError ? (
              <div
                className="rounded px-4 py-3 text-sm border"
                style={{
                  background: "rgba(239, 68, 68, 0.1)",
                  borderColor: ACCENT_RED,
                  color: ACCENT_RED,
                }}
              >
                {fetchError}
              </div>
            ) : calibrationData && !calibrationData.ready ? (
              <div className="space-y-3">
                <div
                  className="text-sm"
                  style={{ color: TEXT_SECONDARY }}
                >
                  {calibrationData.message}
                </div>

                {/* Progress bar */}
                <div className="space-y-1">
                  <div className="flex justify-between text-xs" style={{ color: TEXT_DIM }}>
                    <span>Progress</span>
                    <span>
                      {calibrationData.count} / {calibrationData.needed}
                    </span>
                  </div>
                  <div
                    className="w-full h-2 rounded-full overflow-hidden"
                    style={{ background: "#1e293b" }}
                  >
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${Math.min(100, (calibrationData.count / calibrationData.needed) * 100)}%`,
                        background: ACCENT_BLUE,
                      }}
                    />
                  </div>
                </div>
              </div>
            ) : calibrationData && calibrationData.ready ? (
              <div className="space-y-2">
                <div
                  className="text-xs"
                  style={{ color: TEXT_DIM }}
                >
                  Based on {calibrationData.count} recorded outcomes
                </div>

                {/* C5b: Brier score badge. Lower is better; 0 is perfect, 0.25
                    is the always-predicts-0.5 baseline. We only show it when
                    the API actually returned a finite score. */}
                {typeof calibrationData.brierScore === "number" &&
                  Number.isFinite(calibrationData.brierScore) && (
                    <div
                      className="flex items-center gap-2 rounded border px-3 py-2 text-xs"
                      style={{
                        background: "#0b1220",
                        borderColor: BORDER,
                        color: TEXT_SECONDARY,
                      }}
                      title="Brier score: mean((predicted - actual)^2). 0 is perfect, 0.25 is the always-0.5 baseline, 1 is worst."
                    >
                      <span style={{ color: TEXT_DIM }}>Brier score:</span>
                      <span
                        style={{
                          color:
                            calibrationData.brierScore <= 0.1
                              ? ACCENT_GREEN
                              : calibrationData.brierScore <= 0.25
                              ? ACCENT_AMBER
                              : ACCENT_RED,
                          fontWeight: 600,
                        }}
                      >
                        {calibrationData.brierScore.toFixed(3)}
                      </span>
                      <span style={{ color: TEXT_DIM }}>
                        (lower is better; 0.25 = always-0.5 baseline)
                      </span>
                    </div>
                  )}

                {/* Canvas container */}
                <div
                  ref={containerRef}
                  className="w-full rounded border overflow-hidden"
                  style={{
                    height: "300px",
                    background: CANVAS_BG,
                    borderColor: BORDER,
                  }}
                >
                  <canvas
                    ref={canvasRef}
                    className="block w-full h-full"
                  />
                </div>

                {/* Interpretation guide */}
                <div
                  className="text-xs leading-relaxed"
                  style={{ color: TEXT_DIM }}
                >
                  Points near the diagonal indicate well-calibrated predictions.
                  Points above the line mean events happened more often than
                  predicted; below means less often. Dot size reflects the number
                  of predictions in each bin.
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}

// =============================================================
// Forecast-mode form (extracted for readability)
// =============================================================

function ForecastOutcomeForm({
  forecast,
  actualValueStr,
  onActualValueChange,
  isRecording,
  recordedThisOpen,
  recordError,
  recordSuccess,
  sidecarBanner,
  onSubmit,
}: {
  forecast: ForecastCalibrationContext;
  actualValueStr: string;
  onActualValueChange: (next: string) => void;
  isRecording: boolean;
  recordedThisOpen: boolean;
  recordError: string | null;
  recordSuccess: boolean;
  sidecarBanner:
    | null
    | { status: "updated" | "down" | "error" | "skipped"; observationCount?: number; reason?: string };
  onSubmit: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="text-sm" style={{ color: TEXT_SECONDARY }}>
        Target column:{" "}
        <span className="font-mono font-semibold" style={{ color: TEXT_PRIMARY }}>
          {forecast.targetColumn}
        </span>
      </div>
      <div className="text-sm" style={{ color: TEXT_SECONDARY }}>
        Ensemble prediction:{" "}
        <span className="font-mono" style={{ color: TEXT_PRIMARY }}>
          {forecast.ensemblePrediction.toFixed(2)}
        </span>
      </div>

      <label className="block text-xs" style={{ color: TEXT_DIM }}>
        Observed value
        <input
          type="text"
          inputMode="decimal"
          value={actualValueStr}
          onChange={(e) => onActualValueChange(e.target.value)}
          disabled={isRecording || recordedThisOpen}
          className="mt-1 w-full rounded px-3 py-2 text-sm font-mono"
          style={{
            background: "#1e293b",
            border: `1px solid ${BORDER}`,
            color: TEXT_PRIMARY,
          }}
          placeholder="e.g. 612.5"
        />
      </label>

      {recordError && (
        <div
          className="rounded px-3 py-2 text-xs border"
          style={{
            background: "rgba(239, 68, 68, 0.1)",
            borderColor: ACCENT_RED,
            color: ACCENT_RED,
          }}
        >
          {recordError}
        </div>
      )}

      {recordSuccess && sidecarBanner && (
        <div
          className="rounded px-3 py-2 text-xs border"
          style={{
            background:
              sidecarBanner.status === "updated"
                ? "rgba(34, 197, 94, 0.1)"
                : "rgba(245, 158, 11, 0.1)",
            borderColor:
              sidecarBanner.status === "updated" ? ACCENT_GREEN : ACCENT_AMBER,
            color: sidecarBanner.status === "updated" ? ACCENT_GREEN : ACCENT_AMBER,
          }}
        >
          {sidecarBanner.status === "updated"
            ? `Outcome saved. Sidecar updated weights based on ${sidecarBanner.observationCount} outcomes for ${forecast.targetColumn}.`
            : sidecarBanner.status === "down"
            ? `Outcome saved locally. Sidecar unreachable (${sidecarBanner.reason ?? "no reason"}). Weights will update on next sidecar contact.`
            : sidecarBanner.status === "error"
            ? `Outcome saved locally. Sidecar error (${sidecarBanner.reason ?? "no reason"}).`
            : "Outcome saved locally."}
        </div>
      )}

      <button
        type="button"
        onClick={onSubmit}
        disabled={isRecording || recordedThisOpen}
        className="rounded px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        style={{
          background: "rgba(59, 130, 246, 0.15)",
          border: `1px solid ${ACCENT_BLUE}`,
          color: ACCENT_BLUE,
        }}
      >
        {isRecording ? "Saving..." : recordedThisOpen ? "Saved" : "Save outcome"}
      </button>
    </div>
  );
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function formatNumberInput(value: number): string {
  if (!Number.isFinite(value)) return "";
  // Trim to a reasonable number of decimals to keep the input field tidy.
  return value.toFixed(2);
}
