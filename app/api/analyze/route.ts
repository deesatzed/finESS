import { NextRequest, NextResponse } from "next/server";
import { SYSTEM_PROMPT, buildUserMessage } from "@/lib/ai/prompt";
import { parseAIResponse } from "@/lib/ai/parse-response";
import { apiError, readJsonBody, validationError } from "@/lib/api/errors";
import { validateAnalyzeRequest } from "@/lib/validation/schemas";

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
    const { query, model } = validateAnalyzeRequest(await readJsonBody(request));

    if (isRateLimited()) {
      return apiError(
        "RATE_LIMITED",
        "Too many custom AI requests. Wait a minute and try again.",
        429
      );
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return apiError(
        "MISSING_API_KEY",
        "OPENROUTER_API_KEY is not configured for custom AI queries.",
        500
      );
    }

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://finess.app",
        "X-Title": "finESS Uncertainty Intelligence",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserMessage(query) },
        ],
        temperature: 0.7,
        max_tokens: 4096,
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
