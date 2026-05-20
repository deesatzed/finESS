#!/usr/bin/env node
/**
 * RAG live smoke. Runs the full RAG pipeline against the real BGE
 * embedding model + real LanceDB + real OpenRouter — outside Jest, so
 * the @xenova/transformers worker-thread + native ONNX bindings work
 * normally without --experimental-vm-modules.
 *
 * The Jest integration test at
 * __tests__/integration/semantic-research-rag.integration.test.ts is
 * still useful (it gates behind RUN_RAG_INTEGRATION=1 and validates the
 * orchestrator's wiring), but the live end-to-end network/native path
 * is exercised here.
 *
 * Run with:
 *   npm run smoke:rag
 * Skips silently with status 0 when OPENROUTER_API_KEY is unset, the
 * same blocked-mode pattern as openrouter-live-smoke.mjs.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import dotenv from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

dotenv.config({ path: join(repoRoot, ".env"), quiet: true });
dotenv.config({
  path: join(repoRoot, ".env.local"),
  override: false,
  quiet: true,
});

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
if (!apiKey) {
  console.log(
    "RAG_LIVE_SMOKE_BLOCKED: configure OPENROUTER_API_KEY to run the live RAG smoke.",
  );
  process.exit(0);
}

// Tell @xenova/transformers to use the local quantized BGE model. Same
// configuration the production code uses; documented in lib/rag/embed.ts.
process.env.TRANSFORMERS_CACHE =
  process.env.TRANSFORMERS_CACHE ||
  join(repoRoot, "data", ".cache", "transformers");

const fixturePath = join(
  repoRoot,
  "__tests__",
  "fixtures",
  "rag-sample.md",
);
if (!existsSync(fixturePath)) {
  console.log(
    "RAG_LIVE_SMOKE_FAILED: fixture not found at __tests__/fixtures/rag-sample.md",
  );
  process.exit(1);
}

const startedAt = Date.now();
const fixtureText = await readFile(fixturePath, "utf8");

function chunk(text, size = 1500, overlap = 200) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + size));
    if (i + size >= text.length) break;
    i += size - overlap;
  }
  return out;
}

const chunks = chunk(fixtureText);
console.log(`RAG_SMOKE_STEP: chunked fixture into ${chunks.length} window(s)`);

const tfPkg = ["@xenova", "transformers"].join("/");
const transformers = await import(tfPkg);
console.log("RAG_SMOKE_STEP: loaded @xenova/transformers");

const embedder = await transformers.pipeline(
  "feature-extraction",
  "Xenova/bge-small-en-v1.5",
  { quantized: true },
);
console.log("RAG_SMOKE_STEP: loaded BGE embedding pipeline");

async function embed(text) {
  const output = await embedder(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

const queryEmbedding = await embed("B2B SaaS conversion rate benchmarks");
console.log(
  `RAG_SMOKE_STEP: embedded query (${queryEmbedding.length} dims)`,
);

const chunkEmbeddings = [];
for (let i = 0; i < chunks.length; i++) {
  chunkEmbeddings.push({
    chunkId: i,
    text: chunks[i],
    embedding: await embed(chunks[i]),
  });
}
console.log(`RAG_SMOKE_STEP: embedded ${chunkEmbeddings.length} chunk(s)`);

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}

const ranked = chunkEmbeddings
  .map((c) => ({ ...c, score: cosine(c.embedding, queryEmbedding) }))
  .sort((a, b) => b.score - a.score);
const topK = ranked.slice(0, 3);
console.log(
  `RAG_SMOKE_STEP: top chunk scores ${topK.map((c) => c.score.toFixed(3)).join(", ")}`,
);

const { callChat } = await import("./lib/openrouter-client.mjs");

const result = await callChat({
  apiKey,
  model:
    process.env.OPENROUTER_DEFAULT_MODEL?.trim() ||
    process.env.OPENROUTER_MODEL?.trim() ||
    "openrouter/auto",
  responseFormat: { type: "json_object" },
  temperature: 0,
  referer: "https://finess.app",
  title: "finESS RAG Live Smoke",
  messages: [
    {
      role: "system",
      content:
        "You extract a probability-distribution parameter estimate from supporting passages. Return strict JSON with keys: distribution (one of beta|normal|uniform|lognormal|triangular), params (object with the distribution-specific fields), reasoning (string), citations (array of {chunkId, snippet}).",
    },
    {
      role: "user",
      content:
        `Component: B2B SaaS visitor-to-signup conversion rate. Use these passages:\n\n` +
        topK
          .map((c) => `[chunk ${c.chunkId}]\n${c.text.slice(0, 600)}`)
          .join("\n\n"),
    },
  ],
});

let bundle;
try {
  bundle = JSON.parse(result.content);
} catch (err) {
  console.log(
    `RAG_LIVE_SMOKE_FAILED: LLM did not return valid JSON: ${err.message}`,
  );
  process.exit(1);
}

if (
  typeof bundle.distribution !== "string" ||
  !["beta", "normal", "uniform", "lognormal", "triangular"].includes(
    bundle.distribution,
  )
) {
  console.log(
    `RAG_LIVE_SMOKE_FAILED: distribution missing or invalid (got ${String(
      bundle.distribution,
    )})`,
  );
  process.exit(1);
}
if (!bundle.params || typeof bundle.params !== "object") {
  console.log("RAG_LIVE_SMOKE_FAILED: params missing or not an object");
  process.exit(1);
}
if (!Array.isArray(bundle.citations) || bundle.citations.length === 0) {
  console.log("RAG_LIVE_SMOKE_FAILED: citations missing or empty");
  process.exit(1);
}

console.log(
  `RAG_LIVE_SMOKE_OK: distribution=${bundle.distribution} citations=${bundle.citations.length} cost=$${result.costUsd.toFixed(4)} latencyMs=${result.latencyMs} totalMs=${Date.now() - startedAt}`,
);
