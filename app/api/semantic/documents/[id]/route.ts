import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { apiError, validationError } from "@/lib/api/errors";
import { getAuthenticatedContext } from "@/lib/auth/local-session";
import { recordAuditEvent } from "@/lib/audit/events";
import { validateDocumentId } from "@/lib/validation/semantic-documents";
import { removeDocument } from "@/lib/rag/store";

/**
 * GET /api/semantic/documents/[id] — load metadata for one document.
 *
 * Ownership guard: returns 404 (not 403) when the row exists but is
 * owned by someone else — leaking existence would let a hostile client
 * probe for valid ids across users.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  let id: string;
  try {
    id = validateDocumentId(params.id);
  } catch (err) {
    const v = validationError(err);
    if (v) return v;
    return apiError("VALIDATION_ERROR", "Invalid document id", 400);
  }

  try {
    const auth = await getAuthenticatedContext(request);
    if (!auth) {
      await recordAuditEvent({
        type: "semantic.access_denied",
        subjectType: "semantic_document",
        subjectId: id,
        metadata: {
          route: "/api/semantic/documents/[id]",
          method: "GET",
          reason: "missing_identity",
        },
      });
      return apiError("UNAUTHENTICATED", "Authentication required", 401);
    }

    const row = await prisma.semanticDocument.findFirst({
      where: {
        id,
        userId: auth.userId,
        workspaceId: auth.workspaceId,
      },
    });
    if (!row) {
      await recordAuditEvent({
        type: "semantic.access_denied",
        auth,
        subjectType: "semantic_document",
        subjectId: id,
        metadata: {
          route: "/api/semantic/documents/[id]",
          method: "GET",
          reason: "not_found_or_cross_owner",
        },
      });
      return apiError("NOT_FOUND", "Document not found", 404);
    }

    await recordAuditEvent({
      type: "semantic.loaded",
      auth,
      subjectType: "semantic_document",
      subjectId: row.id,
      metadata: {
        documentId: row.id,
        chunkCount: row.chunkCount,
        scope: "documents",
      },
    });

    return NextResponse.json({
      id: row.id,
      userId: row.userId,
      workspaceId: row.workspaceId,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      chunkCount: row.chunkCount,
      createdAt: row.createdAt.toISOString(),
    });
  } catch {
    return apiError("DATABASE_ERROR", "Failed to load document", 500);
  }
}

/**
 * DELETE /api/semantic/documents/[id] — remove document + its chunks.
 *
 * Sequencing:
 *   1. Look up row scoped by (id, userId, workspaceId). If absent,
 *      return 404 (ownership guard).
 *   2. Delete chunks from the workspace's LanceDB table. We do this
 *      BEFORE the Prisma delete so a LanceDB failure leaves the Prisma
 *      row in place — the user can retry. If we deleted Prisma first
 *      and LanceDB failed, we'd have orphaned chunks with no way for
 *      the user to find/delete them.
 *   3. Delete the Prisma row.
 *   4. Audit-log the deletion (documentId + chunkCount only — no text).
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  let id: string;
  try {
    id = validateDocumentId(params.id);
  } catch (err) {
    const v = validationError(err);
    if (v) return v;
    return apiError("VALIDATION_ERROR", "Invalid document id", 400);
  }

  try {
    const auth = await getAuthenticatedContext(request);
    if (!auth) {
      await recordAuditEvent({
        type: "semantic.access_denied",
        subjectType: "semantic_document",
        subjectId: id,
        metadata: {
          route: "/api/semantic/documents/[id]",
          method: "DELETE",
          reason: "missing_identity",
        },
      });
      return apiError("UNAUTHENTICATED", "Authentication required", 401);
    }

    const row = await prisma.semanticDocument.findFirst({
      where: {
        id,
        userId: auth.userId,
        workspaceId: auth.workspaceId,
      },
    });
    if (!row) {
      await recordAuditEvent({
        type: "semantic.access_denied",
        auth,
        subjectType: "semantic_document",
        subjectId: id,
        metadata: {
          route: "/api/semantic/documents/[id]",
          method: "DELETE",
          reason: "not_found_or_cross_owner",
        },
      });
      return apiError("NOT_FOUND", "Document not found", 404);
    }

    // LanceDB delete first so a failure doesn't orphan rows in the
    // vector store. If LanceDB is unreachable we surface 500 and
    // leave both rows in place.
    try {
      await removeDocument(auth.workspaceId, row.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return apiError(
        "STORE_FAILED",
        `Failed to remove chunks from vector store: ${message}`,
        500,
      );
    }

    await prisma.semanticDocument.delete({ where: { id: row.id } });

    await recordAuditEvent({
      type: "semantic.document_deleted",
      auth,
      subjectType: "semantic_document",
      subjectId: row.id,
      metadata: {
        documentId: row.id,
        chunkCount: row.chunkCount,
      },
    });

    return NextResponse.json({ success: true });
  } catch {
    return apiError("DATABASE_ERROR", "Failed to delete document", 500);
  }
}
