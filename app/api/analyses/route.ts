import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

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
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list analyses" },
      { status: 500 }
    );
  }
}

// POST /api/analyses — save a new analysis
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { query, graph, result, sensitivity, seed } = body;

    if (!query || !graph) {
      return NextResponse.json(
        { error: "Missing required fields: query, graph" },
        { status: 400 }
      );
    }

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
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save analysis" },
      { status: 500 }
    );
  }
}
