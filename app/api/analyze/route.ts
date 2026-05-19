import { NextRequest, NextResponse } from "next/server";
import { buildSystemPrompt, buildUserMessage } from "@/lib/ai/prompt";
import { parseAIResponse } from "@/lib/ai/parse-response";
import { callChat, OpenRouterCallError } from "@/lib/ai/openrouter-client";
import { apiError, readJsonBody, validationError } from "@/lib/api/errors";
import { recordAuditEvent } from "@/lib/audit/events";
import { validateAnalyzeRequest } from "@/lib/validation/schemas";
import { isPathAEnabled } from "@/lib/feature-flags";

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

function safeAudit(metadata: Record<string, unknown>) {
  // Audit failures must never mask the real upstream outcome.
  return recordAuditEvent({ type: "ai_provider_call", metadata }).catch(() => undefined);
}

export async function POST(request: NextRequest) {
  try {
    if (!isPathAEnabled()) {
      return apiError(
        "PATH_A_DISABLED",
        "Path A (LLM-drafted uncertainty graphs) is disabled in this deployment. Set LEGACY_PATH_A_ENABLED=true to re-enable.",
        404
      );
    }

    const { query, model, apiKey: sessionApiKey } = validateAnalyzeRequest(
      await readJsonBody(request)
    );

    if (isRateLimited()) {
      return apiError(
        "RATE_LIMITED",
        "Too many custom AI requests. Wait a minute and try again.",
        429
      );
    }

    const apiKey = sessionApiKey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return apiError(
        "MISSING_API_KEY",
        "OPENROUTER_API_KEY is not configured for custom AI queries.",
        500
      );
    }

    let result;
    try {
      result = await callChat({
        model,
        apiKey,
        messages: [
          { role: "system", content: buildSystemPrompt(query) },
          { role: "user", content: buildUserMessage(query) },
        ],
        temperature: 0.7,
        referer: "https://finess.app",
        title: "finESS Uncertainty Intelligence",
      });
    } catch (error) {
      if (error instanceof OpenRouterCallError) {
        await safeAudit({
          route: "analyze",
          outcome: "error",
          errorCode: error.code,
          httpStatus: error.httpStatus ?? null,
          latencyMs: error.latencyMs ?? null,
          costUsd: error.costUsd ?? 0,
          model,
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
            return apiError(
              "UPSTREAM_EMPTY_RESPONSE",
              "AI provider returned no content.",
              502
            );
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

    await safeAudit({
      route: "analyze",
      outcome: "ok",
      model: result.model,
      latencyMs: result.latencyMs,
      costUsd: result.costUsd,
      retryCount: result.retryCount,
    });

    const content = result.content;
    if (!content) {
      return apiError("UPSTREAM_EMPTY_RESPONSE", "AI provider returned no content.", 502);
    }

    const graph = parseAIResponse(content);
    return NextResponse.json({ graph, rawResponse: content });
  } catch (error) {
    const validation = validationError(error);
    if (validation) return validation;

    if (error instanceof Error && error.message.includes("AI response")) {
      return apiError("AI_RESPONSE_INVALID", error.message, 422);
    }

    return apiError("INTERNAL_ERROR", "Internal server error", 500);
  }
}
