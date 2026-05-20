import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { prisma } from "@/lib/db";
import { apiError, validationError } from "@/lib/api/errors";
import { getAuthenticatedContext } from "@/lib/auth/local-session";
import { recordAuditEvent } from "@/lib/audit/events";
import { validateUploadFields } from "@/lib/validation/semantic-documents";
import { extractText, ExtractError } from "@/lib/rag/extract";
import { chunkText } from "@/lib/rag/chunker";
import { embed, EmbedError } from "@/lib/rag/embed";
import { addChunks } from "@/lib/rag/store";

/**
 * GET /api/semantic/documents — list the requester's uploaded reference
 * documents in the current workspace.
 *
 * Scoped by userId AND workspaceId — same ownership-guard pattern as the
 * rest of the semantic API. Ordered by createdAt desc so the most-
 * recently-uploaded document surfaces first. Audit emits only the count.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedContext(request);
    if (!auth) {
      await recordAuditEvent({
        type: "semantic.access_denied",
        metadata: {
          route: "/api/semantic/documents",
          method: "GET",
          reason: "missing_identity",
        },
      });
      return apiError("UNAUTHENTICATED", "Authentication required", 401);
    }

    const rows = await prisma.semanticDocument.findMany({
      where: { userId: auth.userId, workspaceId: auth.workspaceId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        userId: true,
        workspaceId: true,
        filename: true,
        mimeType: true,
        sizeBytes: true,
        chunkCount: true,
        createdAt: true,
      },
    });

    await recordAuditEvent({
      type: "semantic.listed",
      auth,
      metadata: { count: rows.length, scope: "documents" },
    });

    return NextResponse.json({
      documents: rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        workspaceId: r.workspaceId,
        filename: r.filename,
        mimeType: r.mimeType,
        sizeBytes: r.sizeBytes,
        chunkCount: r.chunkCount,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch {
    return apiError("DATABASE_ERROR", "Failed to list documents", 500);
  }
}

/**
 * POST /api/semantic/documents — upload a reference document.
 *
 * Accepts multipart/form-data with a single `file` field. The handler:
 *   1. Validates auth + reads the FormData file.
 *   2. Validates filename / mimeType / size via validateUploadFields.
 *   3. Hashes the bytes (sha256) and rejects duplicates per-user via the
 *      (userId, sha256) unique index — returns 409 with the existing
 *      document's id.
 *   4. Extracts plain text via lib/rag/extract (mime-aware).
 *   5. Chunks via lib/rag/chunker.
 *   6. Embeds via lib/rag/embed (lazy-loads BAAI/bge-small-en-v1.5).
 *   7. Persists chunks to LanceDB via lib/rag/store.addChunks.
 *   8. Creates the SemanticDocument row (Prisma).
 *   9. Audit-logs the upload (NEVER the bytes, NEVER the text — only
 *      filename, mime, size, chunkCount).
 *
 * Error codes:
 *   - 400 if any validation fails or extraction yields no text
 *   - 401 if unauthenticated
 *   - 409 if the (userId, sha256) pair already exists (idempotent dedup)
 *   - 500 on unexpected upstream failure
 */
export async function POST(request: NextRequest) {
  let auth: Awaited<ReturnType<typeof getAuthenticatedContext>>;
  try {
    auth = await getAuthenticatedContext(request);
  } catch {
    return apiError("DATABASE_ERROR", "Failed to authenticate", 500);
  }
  if (!auth) {
    await recordAuditEvent({
      type: "semantic.access_denied",
      metadata: {
        route: "/api/semantic/documents",
        method: "POST",
        reason: "missing_identity",
      },
    });
    return apiError("UNAUTHENTICATED", "Authentication required", 401);
  }

  // FormData parsing
  let form: FormData;
  try {
    form = await request.formData();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return apiError("VALIDATION_ERROR", `Invalid multipart body: ${message}`, 400);
  }

  const fileField = form.get("file");
  if (!fileField || typeof fileField === "string") {
    return apiError(
      "VALIDATION_ERROR",
      "Multipart body must contain a 'file' field with the document bytes",
      400,
    );
  }
  const file = fileField as File;

  let validated;
  try {
    validated = validateUploadFields({
      filename: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
    });
  } catch (err) {
    const v = validationError(err);
    if (v) return v;
    return apiError("VALIDATION_ERROR", "Upload validation failed", 400);
  }

  // Read bytes once. The buffer is held only for the lifetime of this
  // request — never written to disk.
  let buffer: Buffer;
  try {
    const arrayBuffer = await file.arrayBuffer();
    buffer = Buffer.from(arrayBuffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return apiError("VALIDATION_ERROR", `Failed to read upload: ${message}`, 400);
  }

  const sha256 = createHash("sha256").update(buffer).digest("hex");

  // Dedup check up front — fail fast before we spend embedding cost.
  const existing = await prisma.semanticDocument.findUnique({
    where: { userId_sha256: { userId: auth.userId, sha256 } },
  });
  if (existing) {
    return NextResponse.json(
      {
        error: {
          code: "DUPLICATE_DOCUMENT",
          message: "A document with these contents already exists for this user",
          documentId: existing.id,
        },
      },
      { status: 409 },
    );
  }

  // Extract
  let extracted;
  try {
    extracted = await extractText(buffer, validated.mimeType, validated.filename);
  } catch (err) {
    if (err instanceof ExtractError) {
      const status = err.code === "EXTRACT_FAILED" ? 500 : 400;
      return apiError(err.code, err.message, status);
    }
    const message = err instanceof Error ? err.message : String(err);
    return apiError("EXTRACT_FAILED", message, 500);
  }

  // Chunk
  let chunks;
  try {
    chunks = chunkText(extracted.text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return apiError("VALIDATION_ERROR", `Chunking failed: ${message}`, 400);
  }
  if (chunks.length === 0) {
    return apiError(
      "EMPTY_EXTRACT",
      "Extracted text produced no chunks (document may be effectively empty)",
      400,
    );
  }

  // Embed all chunks. embed() lazy-loads the BGE model on first call.
  let vectors: number[][];
  try {
    vectors = await embed(chunks.map((c) => c.text));
  } catch (err) {
    if (err instanceof EmbedError) {
      return apiError(err.code, `Embedding failed: ${err.message}`, 500);
    }
    const message = err instanceof Error ? err.message : String(err);
    return apiError("EMBED_FAILED", message, 500);
  }
  if (vectors.length !== chunks.length) {
    return apiError(
      "EMBED_FAILED",
      `Embedder returned ${vectors.length} vectors for ${chunks.length} chunks`,
      500,
    );
  }

  // Persist Prisma row FIRST so we have a documentId to link the
  // LanceDB rows to. If LanceDB insertion fails we delete the Prisma
  // row to maintain consistency.
  let row;
  try {
    row = await prisma.semanticDocument.create({
      data: {
        userId: auth.userId,
        workspaceId: auth.workspaceId,
        filename: validated.filename,
        mimeType: validated.mimeType,
        sha256,
        sizeBytes: validated.sizeBytes,
        chunkCount: chunks.length,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return apiError("DATABASE_ERROR", `Failed to record document: ${message}`, 500);
  }

  try {
    await addChunks(
      auth.workspaceId,
      row.id,
      validated.filename,
      chunks.map((c, i) => ({
        chunkId: c.chunkId,
        text: c.text,
        vector: vectors[i],
      })),
    );
  } catch (err) {
    // Best-effort rollback: delete the Prisma row so the user can retry.
    await prisma.semanticDocument
      .delete({ where: { id: row.id } })
      .catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    return apiError(
      "STORE_FAILED",
      `Failed to persist chunks to vector store: ${message}`,
      500,
    );
  }

  await recordAuditEvent({
    type: "semantic.document_uploaded",
    auth,
    subjectType: "semantic_document",
    subjectId: row.id,
    metadata: {
      documentId: row.id,
      mimeType: validated.mimeType,
      sizeBytes: validated.sizeBytes,
      chunkCount: chunks.length,
      pageCount: extracted.pageCount ?? null,
    },
  });

  return NextResponse.json(
    {
      id: row.id,
      userId: row.userId,
      workspaceId: row.workspaceId,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      chunkCount: row.chunkCount,
      createdAt: row.createdAt.toISOString(),
    },
    { status: 201 },
  );
}
