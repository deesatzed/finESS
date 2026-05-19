#!/usr/bin/env node

/**
 * R6-02 — Live verification helper for the multi-proposer lane.
 *
 * Mirrors `scripts/openrouter-live-smoke.mjs` (which already has sandbox
 * access patterns approved): loads .env / .env.local, calls every
 * configured OpenRouter model in parallel for the same PE-style query,
 * and prints a one-line summary so the orchestrator can verify two real,
 * distinct proposals came back.
 *
 * Each call goes through the same `callChat` wrapper used by the product
 * code (script-side mirror at scripts/lib/openrouter-client.mjs). No mock
 * data is involved — this is the real OpenRouter API on the real configured
 * models.
 *
 * Usage:
 *   OPENROUTER_LIVE_SMOKE=1 node scripts/multi-proposer-live-check.mjs
 */

import dotenv from "dotenv";
import { callChat, OpenRouterCallError } from "./lib/openrouter-client.mjs";

dotenv.config({ path: ".env", quiet: true });
dotenv.config({ path: ".env.local", override: false, quiet: true });

const liveEnabled = process.env.OPENROUTER_LIVE_SMOKE === "1";
const apiKey = process.env.OPENROUTER_API_KEY?.trim();

if (!apiKey) {
  console.log(
    "MULTI_PROPOSER_LIVE_BLOCKED: OPENROUTER_API_KEY is not set or is empty."
  );
  process.exit(liveEnabled ? 1 : 0);
}

if (!liveEnabled) {
  console.log(
    "MULTI_PROPOSER_LIVE_SKIPPED: OPENROUTER_LIVE_SMOKE=1 not set."
  );
  process.exit(0);
}

const models = (process.env.OPENROUTER_MODELS ?? "")
  .split(",")
  .map((entry) => entry.split("|")[0]?.trim())
  .filter(Boolean);

if (models.length < 2) {
  console.log(
    `MULTI_PROPOSER_LIVE_BLOCKED: need >= 2 configured models, got ${models.length} (${models.join(",") || "none"}).`
  );
  process.exit(1);
}

const QUERY =
  "A 52-year-old patient presents with sudden-onset pleuritic chest pain and dyspnea. Build an uncertainty graph for the probability of pulmonary embolism given D-dimer and imaging considerations.";

const SYSTEM_PROMPT = `You are an expert uncertainty modeler. Given a user's decision problem described in natural language, you build a probabilistic uncertainty graph.

Return ONLY a JSON object with this shape:
{
  "nodes": [{"id":"snake_case","name":"...","description":"...","distribution":"beta|normal|uniform|lognormal","mean":number,"sd":number_positive,"range":[min,max],"unit":"..."}],
  "edges": [{"id":"e1","source":"node_id","target":"target_id","method":"additive|subtractive|multiplicative|bayesian_update"}],
  "outputNodeId": "final_node_id",
  "threshold": 0.3,
  "narration": "..."
}

Use 4-8 nodes, mean MUST lie inside range, sd MUST be positive. Output JSON only.`;

const USER_MSG = `Analyze this decision problem and build an uncertainty graph:\n\n${QUERY}`;

async function callOne(model) {
  const startedAt = Date.now();
  try {
    const result = await callChat({
      model,
      apiKey,
      referer: "https://finess.app",
      title: "finESS Multi-Proposer Live Check",
      temperature: 0.7,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: USER_MSG },
      ],
    });
    return {
      model,
      ok: true,
      content: result.content,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    if (err instanceof OpenRouterCallError) {
      return {
        model,
        ok: false,
        error: `${err.code}${err.httpStatus ? ` HTTP ${err.httpStatus}` : ""}`,
        costUsd: err.costUsd ?? 0,
        latencyMs: err.latencyMs ?? latencyMs,
      };
    }
    return {
      model,
      ok: false,
      error: `UNKNOWN ${err?.message ?? String(err)}`,
      costUsd: 0,
      latencyMs,
    };
  }
}

function parseFirstNodeId(content) {
  try {
    const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    const obj = JSON.parse(trimmed);
    return obj?.nodes?.[0]?.id ?? "?";
  } catch {
    return "PARSE_FAILED";
  }
}

const results = await Promise.all(models.map(callOne));

const successes = results.filter((r) => r.ok);
const errors = results.filter((r) => !r.ok);
const totalCost = results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);

const breakdown = results
  .map((r) => {
    const firstNode = r.ok ? parseFirstNodeId(r.content) : r.error;
    return `${r.model} firstNode=${firstNode} cost=$${(r.costUsd ?? 0).toFixed(4)} latency=${r.latencyMs}ms`;
  })
  .join(" | ");

const firstNodeIds = successes.map((r) => parseFirstNodeId(r.content));
const distinctFirstNodes = new Set(firstNodeIds).size > 1;

const status = errors.length === 0 ? "OK" : "PARTIAL";

console.log(
  `MULTI_PROPOSER_LIVE_${status}: proposers=${results.length} ok=${successes.length} errors=${errors.length} totalCost=$${totalCost.toFixed(4)} distinctFirstNodes=${distinctFirstNodes} | ${breakdown}`
);

process.exit(errors.length === 0 ? 0 : 1);
