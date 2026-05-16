import { NextResponse } from "next/server";
import { ValidationError } from "@/lib/validation/schemas";

export function apiError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export function validationError(error: unknown) {
  if (error instanceof ValidationError) {
    return apiError("VALIDATION_ERROR", error.message, 400);
  }
  return null;
}

export async function readJsonBody(request: Request) {
  try {
    return await request.json();
  } catch {
    throw new ValidationError("Request body must be valid JSON");
  }
}
