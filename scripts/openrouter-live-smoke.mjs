#!/usr/bin/env node

import dotenv from "dotenv";

dotenv.config({ path: ".env", quiet: true });
dotenv.config({ path: ".env.local", override: false, quiet: true });

const liveEnabled = process.env.OPENROUTER_LIVE_SMOKE === "1";
const apiKey = process.env.OPENROUTER_API_KEY?.trim();
const model =
  process.env.OPENROUTER_DEFAULT_MODEL?.trim() ||
  process.env.OPENROUTER_MODEL?.trim() ||
  firstConfiguredModel(process.env.OPENROUTER_MODELS) ||
  "openrouter/auto";

if (!apiKey) {
  console.log(
    liveEnabled
      ? "OPENROUTER_LIVE_SMOKE_BLOCKED: OPENROUTER_API_KEY is not set or is empty."
      : "OPENROUTER_LIVE_SMOKE_BLOCKED: configure OPENROUTER_API_KEY and set OPENROUTER_LIVE_SMOKE=1 to run the live provider check."
  );
  process.exit(liveEnabled ? 1 : 0);
}

if (!liveEnabled) {
  console.log(
    "OPENROUTER_LIVE_SMOKE_SKIPPED: key is configured, but OPENROUTER_LIVE_SMOKE=1 was not set."
  );
  process.exit(0);
}

const startedAt = Date.now();
const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://finess.app",
    "X-Title": "finESS Pre-Production Smoke",
  },
  body: JSON.stringify({
    model,
    messages: [
      {
        role: "system",
        content:
          "Return strict JSON only. Do not give advice. Use the supplied empirical statistics as authoritative.",
      },
      {
        role: "user",
        content:
          'Interpret this local smoke summary as JSON with keys summary, cautions, nextChecks: rows=4, missing=1, mean=0.75, interval=[0.075,1], threshold=0.5, pAboveThreshold=0.75.',
      },
    ],
    temperature: 0,
    max_tokens: 300,
    response_format: { type: "json_object" },
  }),
});

if (!response.ok) {
  console.log(
    `OPENROUTER_LIVE_SMOKE_FAILED: provider returned HTTP ${response.status}.`
  );
  process.exit(1);
}

const data = await response.json();
const content = data?.choices?.[0]?.message?.content;
if (typeof content !== "string" || content.trim() === "") {
  console.log("OPENROUTER_LIVE_SMOKE_FAILED: provider returned no content.");
  process.exit(1);
}

const insight = parseJsonObject(content);
for (const key of ["summary", "cautions", "nextChecks"]) {
  if (!(key in insight)) {
    console.log(`OPENROUTER_LIVE_SMOKE_FAILED: missing JSON key ${key}.`);
    process.exit(1);
  }
}

console.log(
  `OPENROUTER_LIVE_SMOKE_OK: model=${model}; latencyMs=${Date.now() - startedAt}; jsonKeys=summary,cautions,nextChecks`
);

function firstConfiguredModel(raw) {
  if (!raw?.trim()) return null;
  const first = raw.split(",").map((item) => item.trim()).find(Boolean);
  if (!first) return null;
  return first.split("|")[0]?.trim() || null;
}

function parseJsonObject(content) {
  const trimmed = content.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  const jsonText = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
  try {
    return JSON.parse(jsonText);
  } catch {
    console.log("OPENROUTER_LIVE_SMOKE_FAILED: response was not valid JSON.");
    process.exit(1);
  }
}
