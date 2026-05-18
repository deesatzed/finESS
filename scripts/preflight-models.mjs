#!/usr/bin/env node

// Preflight check: verify every model listed in OPENROUTER_MODELS is
// reachable via the OpenRouter chat-completions endpoint at boot/deploy time,
// so typos or discontinued IDs surface immediately rather than at first user
// click. Companion to scripts/check-env.mjs and scripts/openrouter-live-smoke.mjs.

import dotenv from "dotenv";

dotenv.config({ path: ".env", quiet: true });
dotenv.config({ path: ".env.local", override: false, quiet: true });

const PER_CALL_TIMEOUT_MS = 30_000;
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
const rawModels = process.env.OPENROUTER_MODELS;

const models = parseModelOptions(rawModels);

if (!apiKey) {
  console.log("PREFLIGHT_MODELS_SKIPPED: no API key configured");
  process.exit(0);
}

if (models.length === 0) {
  console.log(
    "PREFLIGHT_MODELS_SKIPPED: OPENROUTER_MODELS is empty or unparseable"
  );
  process.exit(0);
}

const failures = [];
const successes = [];

for (const model of models) {
  const result = await probeModel(model.id);
  if (result.ok) {
    successes.push(model.id);
  } else {
    failures.push({ id: model.id, reason: result.reason });
  }
}

if (failures.length === 0) {
  console.log(
    `PREFLIGHT_MODELS_OK: ${successes.length} models verified (${successes.join(",")})`
  );
  process.exit(0);
}

for (const failure of failures) {
  console.log(`PREFLIGHT_MODELS_FAILED: ${failure.id} (${failure.reason})`);
}
process.exit(1);

async function probeModel(modelId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_CALL_TIMEOUT_MS);
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://finess.app",
        "X-Title": "finESS Model Preflight",
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "ping" }],
        temperature: 0,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await safeReadShortText(response);
      const reasonSuffix = detail ? `: ${detail}` : "";
      return {
        ok: false,
        reason: `HTTP ${response.status}${reasonSuffix}`,
      };
    }

    let data;
    try {
      data = await response.json();
    } catch {
      return { ok: false, reason: "response body was not valid JSON" };
    }

    const choice = data?.choices?.[0]?.message;
    const content = choice?.content;
    const toolCalls = choice?.tool_calls;

    const hasContent = typeof content === "string" && content.trim() !== "";
    const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;

    if (!hasContent && !hasToolCalls) {
      return { ok: false, reason: "empty content and no tool_calls" };
    }

    return { ok: true };
  } catch (error) {
    if (error?.name === "AbortError") {
      return { ok: false, reason: `timeout after ${PER_CALL_TIMEOUT_MS}ms` };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `network error: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function safeReadShortText(response) {
  try {
    const text = await response.text();
    const trimmed = text.trim().replace(/\s+/g, " ");
    return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
  } catch {
    return "";
  }
}

// Inlined to keep this script dependency-free (no TS transpilation in .mjs).
// Mirrors lib/ai/model-config.ts:parseModelOptions; kept in sync manually.
function parseModelOptions(raw) {
  if (!raw || !raw.trim()) return [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map(normalizeModel).filter((m) => m !== null);
    }
  } catch {
    // fall through to comma-separated form
  }

  return raw.split(",").map(normalizeModel).filter((m) => m !== null);
}

function normalizeModel(value) {
  if (typeof value === "string") {
    const [idPart, labelPart] = value.split("|");
    const id = idPart?.trim();
    if (!id) return null;
    return { id, label: labelPart?.trim() || labelFromModelId(id) };
  }

  if (typeof value === "object" && value !== null) {
    const id = typeof value.id === "string" ? value.id.trim() : "";
    if (!id) return null;
    const label =
      typeof value.label === "string" && value.label.trim() !== ""
        ? value.label.trim()
        : labelFromModelId(id);
    return { id, label };
  }

  return null;
}

function labelFromModelId(id) {
  return (
    id
      .split("/")
      .pop()
      ?.replace(/[-_]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase()) ?? id
  );
}
