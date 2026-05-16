import { createHash, randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const LOCAL_SESSION_COOKIE = "finess_local_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

export interface LocalAuthContext {
  sessionId: string;
  userId: string;
  workspaceId: string;
}

export interface LocalAuthSession extends LocalAuthContext {
  token: string;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function newToken() {
  return randomBytes(32).toString("base64url");
}

function expiresAt() {
  return new Date(Date.now() + SESSION_TTL_MS);
}

export async function createLocalAuthSession(
  localSubject = "local-user"
): Promise<LocalAuthSession> {
  const user = await prisma.user.upsert({
    where: { localSubject },
    update: {},
    create: { localSubject },
  });

  const workspace =
    (await prisma.workspace.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
    })) ??
    (await prisma.workspace.create({
      data: {
        userId: user.id,
        name: "Local Workspace",
      },
    }));

  const token = newToken();
  const session = await prisma.localSession.create({
    data: {
      tokenHash: hashToken(token),
      userId: user.id,
      workspaceId: workspace.id,
      expiresAt: expiresAt(),
    },
  });

  return {
    token,
    sessionId: session.id,
    userId: user.id,
    workspaceId: workspace.id,
  };
}

export async function getAuthenticatedContext(
  request: NextRequest
): Promise<LocalAuthContext | null> {
  const token = request.cookies.get(LOCAL_SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await prisma.localSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { workspace: true },
  });

  if (!session || session.expiresAt <= new Date()) return null;
  if (session.workspace.userId !== session.userId) return null;

  return {
    sessionId: session.id,
    userId: session.userId,
    workspaceId: session.workspaceId,
  };
}

export function setLocalSessionCookie(response: NextResponse, token: string) {
  response.cookies.set({
    name: LOCAL_SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt(),
  });
}
