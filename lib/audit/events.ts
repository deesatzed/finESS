import { prisma } from "@/lib/db";
import type { LocalAuthContext } from "@/lib/auth/local-session";

export type AuditEventType =
  | "analysis.list"
  | "analysis.create"
  | "analysis.load"
  | "analysis.delete"
  | "analysis.access_denied"
  | "calibration.read"
  | "calibration.record"
  | "calibration.access_denied"
  | "real_data.assist"
  | "real_data.assist_denied"
  | "ai_provider_call"
  | "analyze_multi_proposed"
  | "forecast_request"
  | "forecast_outcome_recorded"
  // Phase A2: Semantic Mode persistence + API surface. Metadata for these
  // events follows the cross-cutting PII rules — no API keys, no raw CSV,
  // no LLM response bodies, no user query free-text, no RAG chunk content.
  // Only IDs, counts, status enums, and error codes.
  | "semantic.created"
  | "semantic.listed"
  | "semantic.loaded"
  | "semantic.event_applied"
  | "semantic.event_rejected"
  | "semantic.deleted"
  | "semantic.access_denied"
  // Phase B3: RAG-over-user-documents events. Same PII guarantees as the
  // other semantic.* events: NO chunk text, NO file bytes, NO LLM
  // response body; only documentId / chunkCount / mechanism / cost /
  // latency / error codes are permitted in metadata.
  | "semantic.document_uploaded"
  | "semantic.document_deleted"
  | "semantic.research_rag"
  // Phase D2: per-research-step audit events. One event per mechanism
  // dispatch; emitted from the PATCH route after autoAdvance returns.
  // Metadata contract (same PII rules):
  //   dispatched  → { conversationId, componentId, mechanism }
  //   completed   → { conversationId, componentId, mechanism, latencyMs, costUsd, citationCount }
  //   failed      → { conversationId, componentId, mechanism, latencyMs, errorSummary }
  // errorSummary is truncated to 256 chars (same as sanitizeValue for strings).
  | "semantic.research_dispatched"
  | "semantic.research_completed"
  | "semantic.research_failed";

interface AuditEventInput {
  type: AuditEventType;
  auth?: LocalAuthContext | null;
  subjectType?: string;
  subjectId?: string;
  metadata?: Record<string, unknown>;
}

export async function recordAuditEvent({
  type,
  auth,
  subjectType,
  subjectId,
  metadata,
}: AuditEventInput) {
  await prisma.auditEvent.create({
    data: {
      userId: auth?.userId ?? null,
      workspaceId: auth?.workspaceId ?? null,
      sessionId: auth?.sessionId ?? null,
      eventType: type,
      subjectType: subjectType ?? null,
      subjectId: subjectId ?? null,
      metadataJson: metadata ? JSON.stringify(sanitizeMetadata(metadata)) : null,
    },
  });
}

export const FORBIDDEN_AUDIT_METADATA_KEYS = new Set([
  "apiKey",
  "api_key",
  "OPENROUTER_API_KEY",
  "authorization",
  "cookie",
  "sessionToken",
  "session_token",
  "rawRows",
  "csvRows",
  "rows",
  "csv",
  "query",
  "prompt",
  "freeText",
  // B3 additions: never let raw chunk text or file bytes hit the audit log.
  "chunkText",
  "chunk_text",
  "text",
  "fileBytes",
  "file_bytes",
  "documentBytes",
  "document_bytes",
]);

function sanitizeMetadata(metadata: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([key]) => !FORBIDDEN_AUDIT_METADATA_KEYS.has(key))
      .map(([key, value]) => [key, sanitizeValue(value)])
  );
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, 256);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 10).map(sanitizeValue);
  if (typeof value === "object" && value !== null) {
    return sanitizeMetadata(value as Record<string, unknown>);
  }
  return null;
}
