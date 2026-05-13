import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// GET /api/analyses/:id — load a single analysis
export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const analysis = await prisma.analysis.findUnique({
      where: { id: params.id },
    });

    if (!analysis) {
      return NextResponse.json(
        { error: "Analysis not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      id: analysis.id,
      query: analysis.query,
      graph: JSON.parse(analysis.graphJson),
      result: analysis.resultJson ? JSON.parse(analysis.resultJson) : null,
      sensitivity: analysis.sensitivityJson
        ? JSON.parse(analysis.sensitivityJson)
        : null,
      seed: analysis.seed,
      createdAt: analysis.createdAt,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load analysis" },
      { status: 500 }
    );
  }
}

// DELETE /api/analyses/:id — delete an analysis
export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await prisma.analysis.delete({
      where: { id: params.id },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete analysis" },
      { status: 500 }
    );
  }
}
