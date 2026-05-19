/**
 * POST /api/forecast — Real-ensemble forecast (R6-05).
 *
 * Flow:
 *   1. Validate JSON body via validateForecastRequest.
 *   2. Parse + validate the CSV via lib/forecast/csv-time-series.
 *   3. Call the Python ensemble sidecar (services/ensemble) twice:
 *        POST /train  -> trains the unified ACE ensemble on user data.
 *        POST /predict -> returns the EnsemblePrediction shape.
 *   4. Emit a forecast_request audit event (no CSV / no PII).
 *   5. Return the EnsemblePrediction plus a server-generated forecastId
 *      that the client can later attach a CalibrationOutcome to (R6-06).
 *
 * NO MOCK DATA. If the sidecar is unreachable we return a 502 with an
 * actionable message instead of falling back to fake data.
 */

import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { apiError, readJsonBody, validationError } from "@/lib/api/errors";
import { recordAuditEvent } from "@/lib/audit/events";
import { validateForecastRequest } from "@/lib/validation/schemas";
import {
  TimeSeriesValidationError,
  validateTimeSeriesCsv,
} from "@/lib/forecast/csv-time-series";
import {
  EnsembleClient,
  EnsembleClientError,
  type EnsemblePrediction,
} from "@/lib/services/ensemble-client";
import { CsvParseError } from "@/lib/real-data/csv";
import { getForecastTestOptions } from "@/lib/forecast/test-hooks";
import type { ForecastResponse } from "@/lib/forecast/types";

function resolveClient(): EnsembleClient {
  const testOptions = getForecastTestOptions();
  if (testOptions.ensembleClient) return testOptions.ensembleClient;
  return new EnsembleClient(testOptions.clientOptions);
}

function safeAudit(metadata: Record<string, unknown>) {
  return recordAuditEvent({ type: "forecast_request", metadata }).catch(() => undefined);
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  let dateColumn = "";
  let targetColumn = "";
  let horizon = 0;
  let rowCount = 0;

  try {
    const parsed = validateForecastRequest(await readJsonBody(request));
    dateColumn = parsed.dateColumn;
    targetColumn = parsed.targetColumn;
    horizon = parsed.horizon;

    let validated;
    try {
      validated = validateTimeSeriesCsv(parsed.csv, dateColumn, targetColumn);
    } catch (error) {
      if (error instanceof TimeSeriesValidationError || error instanceof CsvParseError) {
        await safeAudit({
          outcome: "validation_error",
          dateColumn,
          targetColumn,
          horizon,
          errorCode: "INVALID_TIME_SERIES",
          latencyMs: Date.now() - startedAt,
        });
        return apiError("INVALID_TIME_SERIES", error.message, 400);
      }
      throw error;
    }

    rowCount = validated.rowCount;
    const client = resolveClient();

    let trained;
    let prediction: EnsemblePrediction;
    try {
      trained = await client.train({
        csvRows: validated.rows,
        dateColumn,
        targetColumns: [targetColumn],
      });
      prediction = await client.predict({
        csvRows: validated.rows,
        dateColumn,
        targetColumn,
        nSteps: horizon,
      });
    } catch (error) {
      const latencyMs = Date.now() - startedAt;

      if (error instanceof EnsembleClientError) {
        await safeAudit({
          outcome: "sidecar_error",
          dateColumn,
          targetColumn,
          horizon,
          rowCount,
          errorCode: "ENSEMBLE_SIDECAR_ERROR",
          sidecarStatus: error.status,
          latencyMs,
        });
        return apiError(
          "ENSEMBLE_SIDECAR_ERROR",
          `Ensemble sidecar returned ${error.status}: ${describeSidecarError(error)}`,
          502,
        );
      }

      const networkMessage =
        error instanceof Error
          ? error.message
          : "unknown error contacting ensemble sidecar";
      await safeAudit({
        outcome: "sidecar_unreachable",
        dateColumn,
        targetColumn,
        horizon,
        rowCount,
        errorCode: "ENSEMBLE_SIDECAR_UNREACHABLE",
        latencyMs,
      });
      return apiError(
        "ENSEMBLE_SIDECAR_UNREACHABLE",
        `Ensemble sidecar unreachable (${networkMessage}). Check 'docker compose ps' and confirm the 'ensemble' service is healthy.`,
        502,
      );
    }

    const forecastId = randomUUID();
    const slsqpWeights = trained.slsqp_weights[targetColumn] ?? {};
    const latencyMs = Date.now() - startedAt;

    await safeAudit({
      outcome: "ok",
      dateColumn,
      targetColumn,
      horizon,
      rowCount,
      modelCount: Object.keys(prediction.model_weights).length,
      trainingSeconds: trained.training_seconds,
      latencyMs,
    });

    const response: ForecastResponse = {
      forecast: prediction,
      forecastId,
      trainedAt: new Date().toISOString(),
      slsqpWeights,
      trainingSeconds: trained.training_seconds,
      rowCount: trained.n_rows,
    };
    return NextResponse.json(response);
  } catch (error) {
    const validation = validationError(error);
    if (validation) {
      await safeAudit({
        outcome: "validation_error",
        dateColumn,
        targetColumn,
        horizon,
        errorCode: "VALIDATION_ERROR",
        latencyMs: Date.now() - startedAt,
      });
      return validation;
    }
    return apiError("INTERNAL_ERROR", "Internal server error", 500);
  }
}

function describeSidecarError(error: EnsembleClientError): string {
  const detail = error.detail;
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object" && "detail" in detail) {
    const inner = (detail as { detail?: unknown }).detail;
    if (typeof inner === "string") return inner;
  }
  return "see sidecar logs for detail";
}
