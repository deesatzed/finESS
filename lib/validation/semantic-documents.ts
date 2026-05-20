/**
 * Validators for the Semantic Mode B3 documents API surface.
 *
 * Two pieces:
 *   - validateUploadFields: cross-checks the multipart fields (filename,
 *     mimeType, sizeBytes) against allowlists. Used by
 *     `POST /api/semantic/documents` after FormData parsing.
 *   - validateDocumentId: validates the URL param for
 *     `GET/DELETE /api/semantic/documents/[id]`.
 *
 * The actual byte-validation (extract + chunk + embed) lives in the
 * lib/rag adapters; this module only validates the boundary metadata.
 * Mirrors the typed-throw pattern in lib/validation/semantic.ts and
 * lib/validation/schemas.ts.
 *
 * No mock data: the validators reject empties, oversize uploads, and
 * unknown mime types so the route can return a clean 400 instead of
 * passing junk into the embedding pipeline.
 */

import { ValidationError } from "@/lib/validation/schemas";
import { getSupportedMimeTypes } from "@/lib/rag/extract";

/**
 * Hard upload size cap. 10 MB is large enough for typical reference PDFs
 * / markdown manuals; we reject anything larger because @xenova
 * embedding cost scales linearly with chunk count and a 50 MB PDF would
 * embed for minutes and bloat the local LanceDB.
 *
 * Override via env for power-users.
 */
const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export function getMaxUploadBytes(): number {
  const raw = process.env.FINESS_RAG_MAX_UPLOAD_BYTES;
  if (raw && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_MAX_UPLOAD_BYTES;
}

export interface ValidatedUploadFields {
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Validate the multipart upload fields.
 *
 * The caller has already pulled the File / Blob off FormData; we only
 * see the trio (filename, mimeType, sizeBytes). Bytes are validated by
 * `lib/rag/extract.extractText` downstream.
 */
export function validateUploadFields(input: {
  filename: unknown;
  mimeType: unknown;
  sizeBytes: unknown;
}): ValidatedUploadFields {
  if (typeof input.filename !== "string" || input.filename.trim() === "") {
    throw new ValidationError("filename is required and must be a non-empty string");
  }
  const filename = input.filename.trim();
  if (filename.length > 512) {
    throw new ValidationError("filename is too long (max 512 chars)");
  }
  // Reject path separators in the filename so we never accidentally
  // write to / read from a path the client controls.
  if (/[\\/\0]/.test(filename)) {
    throw new ValidationError("filename may not contain slashes or NUL bytes");
  }

  if (typeof input.mimeType !== "string" || input.mimeType.trim() === "") {
    throw new ValidationError("mimeType is required and must be a non-empty string");
  }
  const mimeType = input.mimeType.trim();
  const normalized = mimeType.toLowerCase().split(";")[0].trim();
  const allowed = new Set(getSupportedMimeTypes());
  if (!allowed.has(normalized)) {
    throw new ValidationError(
      `mimeType "${mimeType}" is not supported. Allowed: ${[...allowed].join(", ")}`,
    );
  }

  if (typeof input.sizeBytes !== "number" || !Number.isInteger(input.sizeBytes)) {
    throw new ValidationError("sizeBytes must be an integer");
  }
  if (input.sizeBytes <= 0) {
    throw new ValidationError("sizeBytes must be positive");
  }
  const maxBytes = getMaxUploadBytes();
  if (input.sizeBytes > maxBytes) {
    throw new ValidationError(
      `sizeBytes ${input.sizeBytes} exceeds maximum ${maxBytes} bytes`,
    );
  }

  return { filename, mimeType: normalized, sizeBytes: input.sizeBytes };
}

/**
 * Validate the `id` URL param for documents/[id] routes. Rejects empty
 * or non-cuid-shaped ids to avoid filesystem-shape surprises in the
 * downstream LanceDB query path.
 */
export function validateDocumentId(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError("document id is required");
  }
  const id = value.trim();
  if (id.length > 64) {
    throw new ValidationError("document id is too long");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new ValidationError("document id contains unsafe characters");
  }
  return id;
}
