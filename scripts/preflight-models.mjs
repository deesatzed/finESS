#!/usr/bin/env node

// Preflight check: verify every model listed in OPENROUTER_MODELS is
// reachable via the OpenRouter chat-completions endpoint at boot/deploy time,
// so typos or discontinued IDs surface immediately rather than at first user
// click. Companion to scripts/check-env.mjs and scripts/openrouter-live-smoke.mjs.

import dotenv from "dotenv";
import { callChat, OpenRouterCallError } from "./lib/openrouter-client.mjs";

dotenv.config({ path: ".env", quiet: true });
dotenv.config({ path: ".env.local", override: false, quiet: true });

const PER_CALL_TIMEOUT_MS = 30_000;

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
  try {
    const result = await callChat({
      model: modelId,
      apiKey,
      referer: "https://finess.app",
      title: "finESS Model Preflight",
      temperature: 0,
      timeoutMs: PER_CALL_TIMEOUT_MS,
      // Preflight intentionally disables the per-call budget guard: a probe
      // that returns content or tool_calls is "reachable" regardless of cost,
      // and the runtime routes are where we enforce the budget gate.
      costBudgetUsd: 0,
      messages: [{ role: "user", content: "ping" }],
    });

    // The legacy preflight also accepted tool_calls as a sign of life;
    // callChat already treats either content or tool_calls as success.
    if (
      (!result.content || result.content.trim() === "") &&
      !(Array.isArray(result.toolCalls) && result.toolCalls.length > 0)
    ) {
      return { ok: false, reason: "empty content and no tool_calls" };
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof OpenRouterCallError) {
      if (error.code === "TIMEOUT") {
        return { ok: false, reason: `timeout after ${PER_CALL_TIMEOUT_MS}ms` };
      }
      if (error.code === "HTTP_ERROR") {
        return { ok: false, reason: `HTTP ${error.httpStatus ?? "?"}` };
      }
      if (error.code === "EMPTY_RESPONSE") {
        return { ok: false, reason: "empty content and no tool_calls" };
      }
      return { ok: false, reason: `${error.code}: ${error.message}` };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `network error: ${message}` };
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
