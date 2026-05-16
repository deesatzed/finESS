import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { apiError } from "@/lib/api/errors";
import { getAuthenticatedContext } from "@/lib/auth/local-session";
import { recordAuditEvent } from "@/lib/audit/events";

// GET /api/analyses/:id — load a single analysis
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await getAuthenticatedContext(request);
    if (!auth) {
      await recordAuditEvent({
        type: "analysis.access_denied",
        subjectType: "analysis",
        subjectId: params.id,
        metadata: { route: "/api/analyses/[id]", method: "GET", reason: "missing_identity" },
      });
      return apiError("UNAUTHENTICATED", "Authentication required", 401);
    }

    const analysis = await prisma.analysis.findFirst({
      where: {
        id: params.id,
        userId: auth.userId,
        workspaceId: auth.workspaceId,
      },
    });

    if (!analysis) {
      await recordAuditEvent({
        type: "analysis.access_denied",
        auth,
        subjectType: "analysis",
        subjectId: params.id,
        metadata: { route: "/api/analyses/[id]", method: "GET", reason: "not_found_or_cross_owner" },
      });
      return apiError("NOT_FOUND", "Analysis not found", 404);
    }

    await recordAuditEvent({
      type: "analysis.load",
      auth,
      subjectType: "analysis",
      subjectId: analysis.id,
      metadata: { hasResult: Boolean(analysis.resultJson), hasSeed: analysis.seed !== null },
    });

    return NextResponse.json({
      id: analysis.id,
      userId: analysis.userId,
      workspaceId: analysis.workspaceId,
      query: analysis.query,
      graph: JSON.parse(analysis.graphJson),
      result: analysis.resultJson ? JSON.parse(analysis.resultJson) : null,
      sensitivity: analysis.sensitivityJson
        ? JSON.parse(analysis.sensitivityJson)
        : null,
      seed: analysis.seed,
      createdAt: analysis.createdAt,
    });
  } catch {
    return apiError("DATABASE_ERROR", "Failed to load analysis", 500);
  }
}

// DELETE /api/analyses/:id — delete an analysis
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await getAuthenticatedContext(request);
    if (!auth) {
      await recordAuditEvent({
        type: "analysis.access_denied",
        subjectType: "analysis",
        subjectId: params.id,
        metadata: { route: "/api/analyses/[id]", method: "DELETE", reason: "missing_identity" },
      });
      return apiError("UNAUTHENTICATED", "Authentication required", 401);
    }

    const analysis = await prisma.analysis.findFirst({
      where: {
        id: params.id,
        userId: auth.userId,
        workspaceId: auth.workspaceId,
      },
    });

    if (!analysis) {
      await recordAuditEvent({
        type: "analysis.access_denied",
        auth,
        subjectType: "analysis",
        subjectId: params.id,
        metadata: { route: "/api/analyses/[id]", method: "DELETE", reason: "not_found_or_cross_owner" },
      });
      return apiError("NOT_FOUND", "Analysis not found", 404);
    }

    await prisma.analysis.delete({
      where: { id: params.id },
    });

    await recordAuditEvent({
      type: "analysis.delete",
      auth,
      subjectType: "analysis",
      subjectId: params.id,
    });

    return NextResponse.json({ success: true });
  } catch {
    return apiError("DATABASE_ERROR", "Failed to delete analysis", 500);
  }
}
