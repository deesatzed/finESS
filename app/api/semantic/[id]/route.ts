import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { apiError, readJsonBody, validationError } from "@/lib/api/errors";
import { getAuthenticatedContext } from "@/lib/auth/local-session";
import { recordAuditEvent } from "@/lib/audit/events";
import { validateSemanticPatchRequest } from "@/lib/validation/semantic";
import {
  deserializeState,
  serializeState,
  type PersistedSemanticConversation,
} from "@/lib/semantic/persistence";
import { reduce, SemanticStateError } from "@/lib/semantic/state-machine";
import { autoAdvance } from "@/lib/semantic/auto-advance";

/**
 * GET /api/semantic/[id] — load one semantic conversation by id.
 *
 * Ownership guard: returns 404 (not 403) when the row exists but is
 * owned by someone else — leaking existence would let a hostile client
 * probe for valid ids across users. Audit emits the conversationId
 * only.
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
          route: "/api/semantic/[id]",
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
          route: "/api/semantic/[id]",
          method: "GET",
          reason: "not_found_or_cross_owner",
        },
      });
      return apiError("NOT_FOUND", "Conversation not found", 404);
    }

    const state = deserializeState(row.stateJson);
    await recordAuditEvent({
      type: "semantic.loaded",
      auth,
      subjectType: "semantic_conversation",
      subjectId: row.id,
      metadata: { conversationId: row.id, stateKind: state.kind },
    });

    const response: PersistedSemanticConversation = {
      id: row.id,
      userId: row.userId,
      workspaceId: row.workspaceId,
      query: row.query,
      state,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
    return NextResponse.json(response);
  } catch {
    return apiError("DATABASE_ERROR", "Failed to load conversation", 500);
  }
}

/**
 * PATCH /api/semantic/[id] — apply a typed event to the conversation.
 *
 * Loads the current state, hands it to the A1 reducer along with the
 * validated event, and saves the new state. Returns the updated
 * PersistedSemanticConversation.
 *
 * Status codes:
 *  - 400 if the event body is structurally malformed (caught by the
 *    validator).
 *  - 401 if the requester is not authenticated.
 *  - 404 if the conversation does not exist OR is not owned by the
 *    requester (ownership guard; do NOT leak existence).
 *  - 422 if the reducer throws `SemanticStateError` — the event is
 *    syntactically valid but illegal in the current state. This is a
 *    deterministic client bug, not auth.
 *
 * Audit emits the event type and the from/to state kinds — NEVER the
 * event payload, which could carry user query free-text or LLM
 * response bodies.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  let auth: Awaited<ReturnType<typeof getAuthenticatedContext>>;
  try {
    auth = await getAuthenticatedContext(request);
  } catch {
    return apiError("DATABASE_ERROR", "Failed to update conversation", 500);
  }
  if (!auth) {
    await recordAuditEvent({
      type: "semantic.access_denied",
      subjectType: "semantic_conversation",
      subjectId: params.id,
      metadata: {
        route: "/api/semantic/[id]",
        method: "PATCH",
        reason: "missing_identity",
      },
    });
    return apiError("UNAUTHENTICATED", "Authentication required", 401);
  }

  let eventBody;
  try {
    eventBody = validateSemanticPatchRequest(await readJsonBody(request));
  } catch (error) {
    const validation = validationError(error);
    if (validation) return validation;
    return apiError("DATABASE_ERROR", "Failed to update conversation", 500);
  }

  try {
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
          route: "/api/semantic/[id]",
          method: "PATCH",
          reason: "not_found_or_cross_owner",
        },
      });
      return apiError("NOT_FOUND", "Conversation not found", 404);
    }

    const currentState = deserializeState(row.stateJson);

    let nextState;
    try {
      nextState = reduce(currentState, eventBody.event);
    } catch (err) {
      if (err instanceof SemanticStateError) {
        await recordAuditEvent({
          type: "semantic.event_rejected",
          auth,
          subjectType: "semantic_conversation",
          subjectId: row.id,
          metadata: {
            conversationId: row.id,
            eventType: eventBody.event.type,
            fromState: currentState.kind,
            reason: "state_error",
          },
        });
        return apiError("UNPROCESSABLE_ENTITY", err.message, 422);
      }
      throw err;
    }

    // Auto-advance: if the new state requires an LLM call (CLARIFYING or
    // PROPOSING_COMPONENTS), fire the adapter and apply its result-event
    // before responding. The reducer itself never makes I/O — auto-advance
    // is the only place an LLM call happens inside the PATCH handler.
    const apiKey =
      eventBody.apiKey ?? process.env.OPENROUTER_API_KEY;
    const model =
      eventBody.model ??
      process.env.OPENROUTER_DEFAULT_MODEL ??
      "openrouter/auto";
    let autoAdvanceSteps: Array<{
      eventType: string;
      fromState: string;
      toState: string;
      failed: boolean;
      costUsd?: number;
      latencyMs?: number;
    }> = [];
    if (apiKey) {
      const result = await autoAdvance(nextState, { model, apiKey });
      nextState = result.state;
      autoAdvanceSteps = result.steps;
    }

    const updated = await prisma.semanticConversation.update({
      where: { id: row.id },
      data: {
        stateKind: nextState.kind,
        stateJson: serializeState(nextState),
      },
    });

    await recordAuditEvent({
      type: "semantic.event_applied",
      auth,
      subjectType: "semantic_conversation",
      subjectId: row.id,
      metadata: {
        conversationId: row.id,
        eventType: eventBody.event.type,
        fromState: currentState.kind,
        toState: nextState.kind,
        autoAdvanceSteps: autoAdvanceSteps.length,
        autoAdvanceCostUsd: autoAdvanceSteps.reduce(
          (sum, s) => sum + (s.costUsd ?? 0),
          0,
        ),
      },
    });

    const response: PersistedSemanticConversation = {
      id: updated.id,
      userId: updated.userId,
      workspaceId: updated.workspaceId,
      query: updated.query,
      state: nextState,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
    return NextResponse.json(response);
  } catch {
    return apiError("DATABASE_ERROR", "Failed to update conversation", 500);
  }
}

/**
 * DELETE /api/semantic/[id] — hard-delete a conversation row.
 *
 * Same ownership-guard pattern: 404 (not 403) on cross-user attempts so
 * existence is not leaked. No soft-delete pattern in this codebase.
 */
export async function DELETE(
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
          route: "/api/semantic/[id]",
          method: "DELETE",
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
          route: "/api/semantic/[id]",
          method: "DELETE",
          reason: "not_found_or_cross_owner",
        },
      });
      return apiError("NOT_FOUND", "Conversation not found", 404);
    }

    await prisma.semanticConversation.delete({ where: { id: row.id } });

    await recordAuditEvent({
      type: "semantic.deleted",
      auth,
      subjectType: "semantic_conversation",
      subjectId: row.id,
      metadata: { conversationId: row.id },
    });

    return NextResponse.json({ success: true });
  } catch {
    return apiError("DATABASE_ERROR", "Failed to delete conversation", 500);
  }
}
