import { NextRequest, NextResponse } from "next/server";
import { apiError, readJsonBody } from "@/lib/api/errors";
import { recordAuditEvent } from "@/lib/audit/events";
import {
  callChat,
  OpenRouterCallError,
  type CallChatMessage,
} from "@/lib/ai/openrouter-client";
import {
  buildRealDataAssistMessages,
  parseRealDataInsight,
  RealDataAssistError,
  validateRealDataAssistRequest,
} from "@/lib/real-data/assist";

export const dynamic = "force-dynamic";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const requestTimes: number[] = [];

function isRateLimited() {
  const now = Date.now();
  while (requestTimes.length > 0 && now - requestTimes[0] > RATE_LIMIT_WINDOW_MS) {
    requestTimes.shift();
  }
  if (requestTimes.length >= RATE_LIMIT_MAX_REQUESTS) return true;
  requestTimes.push(now);
  return false;
}

function safeProviderAudit(metadata: Record<string, unknown>) {
  return recordAuditEvent({ type: "ai_provider_call", metadata }).catch(() => undefined);
}

export async function POST(request: NextRequest) {
  try {
    const assistRequest = validateRealDataAssistRequest(await readJsonBody(request));

    if (isRateLimited()) {
      return apiError("RATE_LIMITED", "Too many AI assist requests.", 429);
    }

    const apiKey = assistRequest.apiKey ?? process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) {
      await recordAuditEvent({
        type: "real_data.assist_denied",
        metadata: {
          reason: "missing_api_key",
          model: assistRequest.model,
          rowCount: assistRequest.rowCount,
          missingCount: assistRequest.missingCount,
          hasThreshold: assistRequest.threshold !== null,
        },
      });
      return apiError(
        "MISSING_API_KEY",
        "Provide a session API key or configure OPENROUTER_API_KEY locally.",
        400
      );
    }

    // buildRealDataAssistMessages returns role widened to `string`; the message
    // shape is identical to CallChatMessage so we narrow at the call site.
    const messages = buildRealDataAssistMessages({
      ...assistRequest,
      apiKey: undefined,
    }) as CallChatMessage[];

    let result;
    try {
      result = await callChat({
        model: assistRequest.model,
        apiKey,
        messages,
        temperature: 0.2,
        responseFormat: { type: "json_object" },
        referer: "https://finess.app",
        title: "finESS Real Data Mode",
      });
    } catch (error) {
      if (error instanceof OpenRouterCallError) {
        await safeProviderAudit({
          route: "real_data.assist",
          outcome: "error",
          errorCode: error.code,
          httpStatus: error.httpStatus ?? null,
          latencyMs: error.latencyMs ?? null,
          costUsd: error.costUsd ?? 0,
          model: assistRequest.model,
        });
        await recordAuditEvent({
          type: "real_data.assist_denied",
          metadata: {
            reason: error.code === "BUDGET_EXCEEDED" ? "budget_exceeded" : "upstream_error",
            upstreamStatus: error.httpStatus ?? null,
            errorCode: error.code,
            model: assistRequest.model,
            rowCount: assistRequest.rowCount,
            missingCount: assistRequest.missingCount,
            hasThreshold: assistRequest.threshold !== null,
          },
        });
        switch (error.code) {
          case "TIMEOUT":
            return apiError("UPSTREAM_TIMEOUT", "AI provider request timed out.", 504);
          case "BUDGET_EXCEEDED":
            return apiError(
              "UPSTREAM_BUDGET_EXCEEDED",
              `AI provider call exceeded per-call budget (cost=$${(error.costUsd ?? 0).toFixed(4)}).`,
              402
            );
          case "EMPTY_RESPONSE":
            return apiError("UPSTREAM_EMPTY_RESPONSE", "AI provider returned no content.", 502);
          case "HTTP_ERROR":
            return apiError(
              "UPSTREAM_ERROR",
              `AI provider request failed with status ${error.httpStatus ?? "unknown"}.`,
              502
            );
          case "NETWORK":
          default:
            return apiError("UPSTREAM_ERROR", "AI provider request failed.", 502);
        }
      }
      throw error;
    }

    await safeProviderAudit({
      route: "real_data.assist",
      outcome: "ok",
      model: result.model,
      latencyMs: result.latencyMs,
      costUsd: result.costUsd,
      retryCount: result.retryCount,
    });

    const content = result.content;
    if (typeof content !== "string" || content.trim() === "") {
      return apiError("UPSTREAM_EMPTY_RESPONSE", "AI provider returned no content.", 502);
    }

    const insight = parseRealDataInsight(content);
    await recordAuditEvent({
      type: "real_data.assist",
      metadata: {
        model: assistRequest.model,
        rowCount: assistRequest.rowCount,
        missingCount: assistRequest.missingCount,
        hasThreshold: assistRequest.threshold !== null,
      },
    });

    return NextResponse.json({ insight });
  } catch (error) {
    if (error instanceof RealDataAssistError) {
      return apiError("VALIDATION_ERROR", error.message, 400);
    }
    return apiError("INTERNAL_ERROR", "Internal server error", 500);
  }
}
