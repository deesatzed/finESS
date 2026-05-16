import { NextRequest, NextResponse } from "next/server";
import { apiError, readJsonBody } from "@/lib/api/errors";
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

export async function POST(request: NextRequest) {
  try {
    const assistRequest = validateRealDataAssistRequest(await readJsonBody(request));

    if (isRateLimited()) {
      return apiError("RATE_LIMITED", "Too many AI assist requests.", 429);
    }

    const apiKey = assistRequest.apiKey ?? process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) {
      return apiError(
        "MISSING_API_KEY",
        "Provide a session API key or configure OPENROUTER_API_KEY locally.",
        400
      );
    }

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://finess.app",
        "X-Title": "finESS Real Data Mode",
      },
      body: JSON.stringify({
        model: assistRequest.model,
        messages: buildRealDataAssistMessages({
          ...assistRequest,
          apiKey: undefined,
        }),
        temperature: 0.2,
        max_tokens: 900,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      return apiError(
        "UPSTREAM_ERROR",
        `AI provider request failed with status ${response.status}.`,
        502
      );
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      return apiError("UPSTREAM_EMPTY_RESPONSE", "AI provider returned no content.", 502);
    }

    return NextResponse.json({ insight: parseRealDataInsight(content) });
  } catch (error) {
    if (error instanceof RealDataAssistError) {
      return apiError("VALIDATION_ERROR", error.message, 400);
    }
    return apiError("INTERNAL_ERROR", "Internal server error", 500);
  }
}
