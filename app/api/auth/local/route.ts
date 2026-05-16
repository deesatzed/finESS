import { NextRequest, NextResponse } from "next/server";
import {
  createLocalAuthSession,
  getAuthenticatedContext,
  setLocalSessionCookie,
} from "@/lib/auth/local-session";
import { apiError } from "@/lib/api/errors";

export async function GET(request: NextRequest) {
  try {
    const existing = await getAuthenticatedContext(request);
    if (existing) {
      return NextResponse.json({
        userId: existing.userId,
        workspaceId: existing.workspaceId,
      });
    }

    const session = await createLocalAuthSession();
    const response = NextResponse.json(
      {
        userId: session.userId,
        workspaceId: session.workspaceId,
      },
      { status: 201 }
    );
    setLocalSessionCookie(response, session.token);
    return response;
  } catch {
    return apiError("AUTH_ERROR", "Failed to create local session", 500);
  }
}
