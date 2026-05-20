import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { apiError, readJsonBody, validationError } from "@/lib/api/errors";
import { getAuthenticatedContext } from "@/lib/auth/local-session";
import { recordAuditEvent } from "@/lib/audit/events";
import { validateSemanticCreateRequest } from "@/lib/validation/semantic";
import {
  deserializeState,
  serializeState,
  type PersistedSemanticConversation,
} from "@/lib/semantic/persistence";
import { initialState, reduce } from "@/lib/semantic/state-machine";
import { autoAdvance } from "@/lib/semantic/auto-advance";

/**
 * GET /api/semantic — list the requester's saved semantic conversations.
 *
 * Scoped by userId AND workspaceId — same ownership-guard pattern as
 * /api/analyses. Ordered by updatedAt desc so the most-recently-edited
 * conversation surfaces first. Audit emits only the count.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedContext(request);
    if (!auth) {
      await recordAuditEvent({
        type: "semantic.access_denied",
        metadata: {
          route: "/api/semantic",
          method: "GET",
          reason: "missing_identity",
        },
      });
      return apiError("UNAUTHENTICATED", "Authentication required", 401);
    }

    const rows = await prisma.semanticConversation.findMany({
      where: { userId: auth.userId, workspaceId: auth.workspaceId },
      orderBy: { updatedAt: "desc" },
    });

    const conversations: PersistedSemanticConversation[] = rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      workspaceId: row.workspaceId,
      query: row.query,
      state: deserializeState(row.stateJson),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));

    await recordAuditEvent({
      type: "semantic.listed",
      auth,
      metadata: { count: conversations.length },
    });

    return NextResponse.json({ conversations });
  } catch {
    return apiError("DATABASE_ERROR", "Failed to list conversations", 500);
  }
}

/**
 * POST /api/semantic — create a new semantic conversation.
 *
 * Validates the body, immediately advances from IDLE to CLARIFYING via
 * the A1 reducer (`start(query)`), persists the resulting state, and
 * returns the full PersistedSemanticConversation. Audit emits the new
 * conversation id and the query length only — NEVER the query text.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthenticatedContext(request);
    if (!auth) {
      await recordAuditEvent({
        type: "semantic.access_denied",
        metadata: {
          route: "/api/semantic",
          method: "POST",
          reason: "missing_identity",
        },
      });
      return apiError("UNAUTHENTICATED", "Authentication required", 401);
    }

    const { query, model: sessionModel, apiKey: sessionApiKey } =
      validateSemanticCreateRequest(await readJsonBody(request));

    // Advance the state machine to CLARIFYING up-front. The user's first
    // interaction is to receive clarifying questions, so the server-side
    // contract is "creating a conversation = you have already started it".
    let state = reduce(initialState(), { type: "start", query });

    // Resolve LLM credentials. Both fall back to env. If no key is
    // available we still create the conversation in CLARIFYING and skip
    // auto-advance so the client can recover via PATCH after the user
    // configures a key.
    const apiKey = sessionApiKey ?? process.env.OPENROUTER_API_KEY;
    const model =
      sessionModel ?? process.env.OPENROUTER_DEFAULT_MODEL ?? "openrouter/auto";

    let autoAdvanceSteps: Array<{
      eventType: string;
      fromState: string;
      toState: string;
      failed: boolean;
      costUsd?: number;
      latencyMs?: number;
    }> = [];
    if (apiKey) {
      const result = await autoAdvance(state, { model, apiKey });
      state = result.state;
      autoAdvanceSteps = result.steps;
    }

    const row = await prisma.semanticConversation.create({
      data: {
        userId: auth.userId,
        workspaceId: auth.workspaceId,
        query,
        stateKind: state.kind,
        stateJson: serializeState(state),
      },
    });

    await recordAuditEvent({
      type: "semantic.created",
      auth,
      subjectType: "semantic_conversation",
      subjectId: row.id,
      metadata: {
        conversationId: row.id,
        queryLength: query.length,
        autoAdvanceSteps: autoAdvanceSteps.length,
        autoAdvanceCostUsd: autoAdvanceSteps.reduce(
          (sum, s) => sum + (s.costUsd ?? 0),
          0,
        ),
        finalStateKind: state.kind,
      },
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
    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    const validation = validationError(error);
    if (validation) return validation;
    return apiError(
      "DATABASE_ERROR",
      "Failed to create conversation",
      500,
    );
  }
}
