"use client";

import { useState, useRef, useEffect, useCallback } from "react";

// ============================================================
// CalibrationModal — Record outcomes & view calibration curve
// ============================================================

interface CalibrationModalProps {
  isOpen: boolean;
  onClose: () => void;
  analysisId: string | null;
  predictedProbability: number | null;
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

interface CalibrationReady {
  ready: true;
  count: number;
  calibrationCurve: CalibrationBin[];
}

type CalibrationData = CalibrationNotReady | CalibrationReady;

// -- Color constants ------------------------------------------

const BG = "#0f1629";
const BORDER = "#1e293b";
const TEXT_PRIMARY = "#e2e8f0";
const TEXT_SECONDARY = "#94a3b8";
const TEXT_DIM = "#64748b";
const ACCENT_BLUE = "#3b82f6";
const ACCENT_GREEN = "#22c55e";
const ACCENT_RED = "#ef4444";
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
  analysisId,
  predictedProbability,
}: CalibrationModalProps) {
  // -- State --------------------------------------------------

  const [calibrationData, setCalibrationData] = useState<CalibrationData | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [isFetching, setIsFetching] = useState(false);

  const [isRecording, setIsRecording] = useState(false);
  const [recordSuccess, setRecordSuccess] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [recordedThisOpen, setRecordedThisOpen] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // -- Fetch calibration data on mount / open -----------------

  const fetchCalibration = useCallback(async () => {
    setIsFetching(true);
    setFetchError(null);
    try {
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
    }
  }, [isOpen, fetchCalibration]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  // -- Record outcome -----------------------------------------

  const recordOutcome = async (actualOutcome: boolean) => {
    if (!analysisId || predictedProbability === null || recordedThisOpen) return;

    setIsRecording(true);
    setRecordError(null);
    setRecordSuccess(false);

    try {
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
      // Refresh calibration data after recording
      await fetchCalibration();
    } catch (err) {
      setRecordError(err instanceof Error ? err.message : "Failed to record outcome");
    } finally {
      setIsRecording(false);
    }
  };

  // -- Canvas drawing -----------------------------------------

  const drawCalibrationCurve = useCallback(
    (curve: CalibrationBin[]) => {
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
    drawCalibrationCurve(curve);

    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      drawCalibrationCurve(curve);
    });
    observer.observe(container);

    return () => observer.disconnect();
  }, [isOpen, calibrationData, drawCalibrationCurve]);

  // -- Render -------------------------------------------------

  if (!isOpen) return null;

  const hasAnalysis = analysisId !== null;
  const hasPrediction = predictedProbability !== null;

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
              Record Outcome
            </h3>

            {!hasAnalysis ? (
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
                {hasPrediction && (
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
                    onClick={() => recordOutcome(true)}
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
                    onClick={() => recordOutcome(false)}
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
