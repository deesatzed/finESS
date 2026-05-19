import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { apiError, readJsonBody, validationError } from "@/lib/api/errors";
import { getAuthenticatedContext } from "@/lib/auth/local-session";
import { recordAuditEvent } from "@/lib/audit/events";
import { validateCalibrationOutcomeRequest } from "@/lib/validation/schemas";
import {
  EnsembleClient,
  EnsembleClientError,
} from "@/lib/services/ensemble-client";
import { getCalibrationTestOptions } from "@/lib/calibration/test-hooks";
import { computeReliability } from "@/lib/calibration/reliability";
import { computeBrierScore } from "@/lib/calibration/brier";

const MIN_OUTCOMES_FOR_CURVE = 20;

// GET /api/calibration — get calibration data
export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedContext(request);
    if (!auth) {
      await recordAuditEvent({
        type: "calibration.access_denied",
        metadata: { route: "/api/calibration", method: "GET", reason: "missing_identity" },
      });
      return apiError("UNAUTHENTICATED", "Authentication required", 401);
    }

    const outcomes = await prisma.calibrationOutcome.findMany({
      where: {
        userId: auth.userId,
        workspaceId: auth.workspaceId,
      },
      orderBy: { recordedAt: "desc" },
    });

    if (outcomes.length < MIN_OUTCOMES_FOR_CURVE) {
      await recordAuditEvent({
        type: "calibration.read",
        auth,
        metadata: { count: outcomes.length, ready: false },
      });
      return NextResponse.json({
        ready: false,
        count: outcomes.length,
        needed: MIN_OUTCOMES_FOR_CURVE,
        message: `Calibration requires at least ${MIN_OUTCOMES_FOR_CURVE} real outcomes. You have ${outcomes.length}. Record more outcomes to see your calibration curve.`,
      });
    }

    // Build calibration curve: bin predictions into deciles
    const bins = Array.from({ length: 10 }, (_, i) => ({
      binStart: i * 0.1,
      binEnd: (i + 1) * 0.1,
      predicted: 0,
      actual: 0,
      count: 0,
    }));

    for (const outcome of outcomes) {
      const binIdx = Math.min(
        9,
        Math.floor(outcome.predictedProbability * 10)
      );
      bins[binIdx].count++;
      bins[binIdx].predicted += outcome.predictedProbability;
      bins[binIdx].actual += outcome.actualOutcome ? 1 : 0;
    }

    const calibrationCurve = bins
      .filter((b) => b.count > 0)
      .map((b) => ({
        predicted: b.predicted / b.count,
        actual: b.actual / b.count,
        count: b.count,
      }));

    // C5a/C5b: also expose the full reliability report (with empty bins
    // preserved per Principle 6) and Brier score. The legacy
    // `calibrationCurve` field is kept verbatim so the existing canvas
    // renderer in CalibrationModal stays working; the new fields drive
    // the Brier display and the empty-state messaging.
    const reliability = computeReliability(
      outcomes.map((o) => ({
        id: o.id,
        analysisId: o.analysisId ?? "",
        predictedProbability: o.predictedProbability,
        actualOutcome: o.actualOutcome,
        recordedAt:
          o.recordedAt instanceof Date
            ? o.recordedAt.toISOString()
            : String(o.recordedAt),
      }))
    );
    const brier = computeBrierScore(
      outcomes.map((o) => ({
        id: o.id,
        analysisId: o.analysisId ?? "",
        predictedProbability: o.predictedProbability,
        actualOutcome: o.actualOutcome,
        recordedAt:
          o.recordedAt instanceof Date
            ? o.recordedAt.toISOString()
            : String(o.recordedAt),
      }))
    );

    await recordAuditEvent({
      type: "calibration.read",
      auth,
      metadata: { count: outcomes.length, ready: true, binCount: calibrationCurve.length },
    });

    return NextResponse.json({
      ready: true,
      count: outcomes.length,
      calibrationCurve,
      reliability,
      brierScore: brier.score,
      brierCount: brier.count,
    });
  } catch {
    return apiError("DATABASE_ERROR", "Failed to get calibration data", 500);
  }
}

// POST /api/calibration — record a real outcome
//
// R6-06 — when the payload carries a forecastId AND the forecast-feedback
// trio (targetColumn, modelPredictions, actualValue), the handler:
//   1. Persists the calibration row to SQLite (as always).
//   2. Forwards the outcome to the ensemble sidecar's /outcome endpoint.
//      The sidecar updates its EMA learner; the next /api/forecast for
//      the same column will re-optimise SLSQP weights against the new
//      Beta priors.
//   3. The SQLite save is NEVER blocked by sidecar failures. The response
//      carries `sidecarStatus: "updated" | "down" | "error" | "skipped"`
//      so the client can render an honest status.
//   4. Sidecar interactions are audited separately as
//      `forecast_outcome_recorded` so calibration.record metadata stays
//      backwards-compatible.
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthenticatedContext(request);
    if (!auth) {
      await recordAuditEvent({
        type: "calibration.access_denied",
        metadata: { route: "/api/calibration", method: "POST", reason: "missing_identity" },
      });
      return apiError("UNAUTHENTICATED", "Authentication required", 401);
    }

    const parsed = validateCalibrationOutcomeRequest(await readJsonBody(request));
    const {
      analysisId,
      forecastId,
      predictedProbability,
      actualOutcome,
      targetColumn,
      modelPredictions,
      actualValue,
    } = parsed;

    // Analysis-branch: enforce ownership before writing.
    if (analysisId) {
      const analysis = await prisma.analysis.findFirst({
        where: {
          id: analysisId,
          userId: auth.userId,
          workspaceId: auth.workspaceId,
        },
      });

      if (!analysis) {
        await recordAuditEvent({
          type: "calibration.access_denied",
          auth,
          subjectType: "analysis",
          subjectId: analysisId,
          metadata: {
            route: "/api/calibration",
            method: "POST",
            reason: "analysis_not_found_or_cross_owner",
          },
        });
        return apiError("NOT_FOUND", "Analysis not found", 404);
      }
    }

    const outcome = await prisma.calibrationOutcome.create({
      data: {
        userId: auth.userId,
        workspaceId: auth.workspaceId,
        analysisId: analysisId ?? null,
        forecastId: forecastId ?? null,
        predictedProbability,
        actualOutcome,
      },
    });

    await recordAuditEvent({
      type: "calibration.record",
      auth,
      subjectType: "calibrationOutcome",
      subjectId: outcome.id,
      metadata: {
        analysisId: analysisId ?? null,
        forecastId: forecastId ?? null,
        predictedProbability,
        actualOutcome,
      },
    });

    // R6-06 forecast-feedback hook. Only when ALL the prerequisites are
    // present: forecastId + the prediction trio. SQLite is already saved
    // at this point; sidecar failure does NOT roll the outcome back.
    let sidecarStatus: "updated" | "down" | "error" | "skipped" = "skipped";
    let priorsUpdated:
      | Record<string, { type: string; params: Record<string, number> }>
      | undefined;
    let observationCount: number | undefined;
    let sidecarReason: string | undefined;

    if (forecastId && targetColumn && modelPredictions && actualValue !== undefined) {
      const client = resolveClient();
      try {
        const sidecarResponse = await client.recordOutcome({
          column: targetColumn,
          modelPredictions,
          actual: actualValue,
        });
        sidecarStatus = "updated";
        priorsUpdated = sidecarResponse.updated_priors;
        observationCount = sidecarResponse.observation_count;

        await recordAuditEvent({
          type: "forecast_outcome_recorded",
          auth,
          subjectType: "calibrationOutcome",
          subjectId: outcome.id,
          metadata: {
            forecastId,
            targetColumn,
            modelCount: Object.keys(modelPredictions).length,
            observationCount,
            outcome: "updated",
          },
        });
      } catch (error) {
        if (error instanceof EnsembleClientError) {
          sidecarStatus = "error";
          sidecarReason = `sidecar returned ${error.status}`;
        } else {
          sidecarStatus = "down";
          sidecarReason =
            error instanceof Error
              ? error.message.slice(0, 200)
              : "unknown error contacting ensemble sidecar";
        }
        await recordAuditEvent({
          type: "forecast_outcome_recorded",
          auth,
          subjectType: "calibrationOutcome",
          subjectId: outcome.id,
          metadata: {
            forecastId,
            targetColumn,
            modelCount: Object.keys(modelPredictions).length,
            outcome: sidecarStatus,
            reason: sidecarReason,
          },
        });
      }
    }

    return NextResponse.json(
      {
        id: outcome.id,
        sidecarStatus,
        priorsUpdated,
        observationCount,
        sidecarReason,
      },
      { status: 201 },
    );
  } catch (error) {
    const validation = validationError(error);
    if (validation) return validation;
    return apiError("DATABASE_ERROR", "Failed to record outcome", 500);
  }
}

function resolveClient(): EnsembleClient {
  const testOptions = getCalibrationTestOptions();
  if (testOptions.ensembleClient) return testOptions.ensembleClient;
  return new EnsembleClient(testOptions.clientOptions);
}
