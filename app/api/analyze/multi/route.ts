/**
 * R6-02 — POST /api/analyze/multi
 *
 * Multi-LLM proposal lane. Sibling of POST /api/analyze (single-model). Same
 * feature flag, separate rate-limit counter (multi requests fan out to N
 * upstream calls each, so we cap them harder).
 *
 * The handler never throws on per-proposer failures — those become entries
 * in the returned `proposals` array with `error` populated, so the UI can
 * surface disagreement (or partial failure) honestly.
 *
 * Non-handler exports are not allowed from a Next.js route.ts; the rate-limit
 * counter therefore lives in the sibling test-hooks module.
 */

import { NextRequest, NextResponse } from "next/server";
import { apiError, readJsonBody, validationError } from "@/lib/api/errors";
import { recordAuditEvent } from "@/lib/audit/events";
import { validateMultiAnalyzeRequest } from "@/lib/validation/schemas";
import { isPathAEnabled } from "@/lib/feature-flags";
import { proposeGraphs, type ProposalResult } from "@/lib/ai/multi-proposer";
import { isRateLimited } from "@/app/api/analyze/multi/test-hooks";

function safeAudit(metadata: Record<string, unknown>) {
  // Audit failures must never mask the real upstream outcome.
  return recordAuditEvent({
    type: "analyze_multi_proposed",
    metadata,
  }).catch(() => undefined);
}

function summarize(proposals: ProposalResult[]) {
  let successCount = 0;
  let errorCount = 0;
  let totalCostUsd = 0;
  for (const p of proposals) {
    if (p.graph) successCount += 1;
    else errorCount += 1;
    totalCostUsd += p.costUsd ?? 0;
  }
  return { successCount, errorCount, totalCostUsd };
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    if (!isPathAEnabled()) {
      return apiError(
        "PATH_A_DISABLED",
        "Path A (LLM-drafted uncertainty graphs) is disabled in this deployment. Set LEGACY_PATH_A_ENABLED=true to re-enable.",
        404
      );
    }

    const body = await readJsonBody(request);
    const { query, models, apiKey: sessionApiKey } =
      validateMultiAnalyzeRequest(body);

    if (isRateLimited()) {
      return apiError(
        "RATE_LIMITED",
        "Too many multi-model analyze requests. Wait a minute and try again.",
        429
      );
    }

    const apiKey = sessionApiKey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return apiError(
        "MISSING_API_KEY",
        "OPENROUTER_API_KEY is not configured for multi-model AI queries.",
        500
      );
    }

    let proposals: ProposalResult[];
    try {
      proposals = await proposeGraphs({ query, apiKey, models });
    } catch (err) {
      // proposeGraphs only throws on caller-side preconditions (no models, no
      // key, no query). Surface as a 400 rather than a 500.
      const message = err instanceof Error ? err.message : String(err);
      await safeAudit({
        route: "analyze/multi",
        outcome: "error",
        errorCode: "NO_MODELS",
        message,
      });
      return apiError("NO_MODELS_CONFIGURED", message, 400);
    }

    const summary = summarize(proposals);
    const wallTimeMs = Date.now() - startedAt;

    await safeAudit({
      route: "analyze/multi",
      outcome: "ok",
      proposerCount: proposals.length,
      successCount: summary.successCount,
      errorCount: summary.errorCount,
      totalCostUsd: Number(summary.totalCostUsd.toFixed(6)),
      wallTimeMs,
      // Per-model breakdown (just ids + outcome flag + cost). The graphs
      // themselves are not audited because the metadata sanitizer caps array
      // length anyway and we'd lose detail.
      perModel: proposals.map((p) => ({
        model: p.model,
        ok: Boolean(p.graph),
        latencyMs: p.latencyMs,
        costUsd: Number((p.costUsd ?? 0).toFixed(6)),
      })),
    });

    return NextResponse.json({
      proposals,
      summary: { ...summary, wallTimeMs },
    });
  } catch (error) {
    const validation = validationError(error);
    if (validation) return validation;

    return apiError("INTERNAL_ERROR", "Internal server error", 500);
  }
}
