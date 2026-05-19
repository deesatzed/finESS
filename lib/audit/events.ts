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
  | "ai_provider_call";

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
  "query",
  "prompt",
  "freeText",
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
