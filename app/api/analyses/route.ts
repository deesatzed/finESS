import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { apiError, readJsonBody, validationError } from "@/lib/api/errors";
import { validateAnalysisSaveRequest } from "@/lib/validation/schemas";

// GET /api/analyses — list all saved analyses
export async function GET() {
  try {
    const analyses = await prisma.analysis.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        query: true,
        seed: true,
        createdAt: true,
      },
    });

    return NextResponse.json({ analyses });
  } catch {
    return apiError("DATABASE_ERROR", "Failed to list analyses", 500);
  }
}

// POST /api/analyses — save a new analysis
export async function POST(request: NextRequest) {
  try {
    const { query, graph, result, sensitivity, seed } =
      validateAnalysisSaveRequest(await readJsonBody(request));

    const analysis = await prisma.analysis.create({
      data: {
        query,
        graphJson: JSON.stringify(graph),
        resultJson: result ? JSON.stringify(result) : null,
        sensitivityJson: sensitivity ? JSON.stringify(sensitivity) : null,
        seed: seed ?? null,
      },
    });

    return NextResponse.json({ id: analysis.id }, { status: 201 });
  } catch (error) {
    const validation = validationError(error);
    if (validation) return validation;
    return apiError("DATABASE_ERROR", "Failed to save analysis", 500);
  }
}
