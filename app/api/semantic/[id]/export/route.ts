import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { apiError } from "@/lib/api/errors";
import { getAuthenticatedContext } from "@/lib/auth/local-session";
import { recordAuditEvent } from "@/lib/audit/events";
import { deserializeState } from "@/lib/semantic/persistence";
import type { PersistedSemanticConversation } from "@/lib/semantic/persistence";
import { exportToJson, exportToMarkdown } from "@/lib/semantic/export";

/**
 * GET /api/semantic/[id]/export — export a conversation as JSON or Markdown.
 *
 * Query params:
 *   format=json  (default) — returns application/json with SemanticConversationExport
 *   format=md    — returns text/markdown with the defensibility document
 *
 * Same ownership-guard pattern as the parent GET: 404 (not 403) on
 * cross-user attempts so existence is not leaked.
 *
 * The response Content-Disposition suggests a filename so the browser
 * download dialog shows something meaningful.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const auth = await getAuthenticatedContext(request);
    if (!auth) {
      await recordAuditEvent({
        type: "semantic.access_denied",
        subjectType: "semantic_conversation",
        subjectId: params.id,
        metadata: {
          route: "/api/semantic/[id]/export",
          method: "GET",
          reason: "missing_identity",
        },
      });
      return apiError("UNAUTHENTICATED", "Authentication required", 401);
    }

    const row = await prisma.semanticConversation.findFirst({
      where: {
        id: params.id,
        userId: auth.userId,
        workspaceId: auth.workspaceId,
      },
    });

    if (!row) {
      await recordAuditEvent({
        type: "semantic.access_denied",
        auth,
        subjectType: "semantic_conversation",
        subjectId: params.id,
        metadata: {
          route: "/api/semantic/[id]/export",
          method: "GET",
          reason: "not_found_or_cross_owner",
        },
      });
      return apiError("NOT_FOUND", "Conversation not found", 404);
    }

    const state = deserializeState(row.stateJson);
    const conversation: PersistedSemanticConversation = {
      id: row.id,
      userId: row.userId,
      workspaceId: row.workspaceId,
      query: row.query,
      state,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };

    const format = request.nextUrl.searchParams.get("format") ?? "json";

    await recordAuditEvent({
      type: "semantic.loaded",
      auth,
      subjectType: "semantic_conversation",
      subjectId: row.id,
      metadata: {
        conversationId: row.id,
        stateKind: state.kind,
        exportFormat: format,
      },
    });

    if (format === "md") {
      const md = exportToMarkdown(conversation);
      const slug = row.id.slice(0, 8);
      return new NextResponse(md, {
        status: 200,
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="conversation-${slug}.md"`,
        },
      });
    }

    // Default: JSON
    const exported = exportToJson(conversation);
    const slug = row.id.slice(0, 8);
    return new NextResponse(JSON.stringify(exported, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="conversation-${slug}.json"`,
      },
    });
  } catch {
    return apiError("DATABASE_ERROR", "Failed to export conversation", 500);
  }
}
