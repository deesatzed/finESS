import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

const MIN_OUTCOMES_FOR_CURVE = 20;

// GET /api/calibration — get calibration data
export async function GET() {
  try {
    const outcomes = await prisma.calibrationOutcome.findMany({
      orderBy: { recordedAt: "desc" },
    });

    if (outcomes.length < MIN_OUTCOMES_FOR_CURVE) {
      return NextResponse.json({
        ready: false,
        count: outcomes.length,
        needed: MIN_OUTCOMES_FOR_CURVE,
        message: `Calibration requires at least ${MIN_OUTCOMES_FOR_CURVE} real outcomes. You have ${outcomes.length}. Record more outcomes to see your calibration curve.`,
      });
    }

    // Build calibration curve: bin predictions into deciles
    const bins = Array.from({ length: 10 }, (_, i) => ({
      binStart: i * 0.1,
      binEnd: (i + 1) * 0.1,
      predicted: 0,
      actual: 0,
      count: 0,
    }));

    for (const outcome of outcomes) {
      const binIdx = Math.min(
        9,
        Math.floor(outcome.predictedProbability * 10)
      );
      bins[binIdx].count++;
      bins[binIdx].predicted += outcome.predictedProbability;
      bins[binIdx].actual += outcome.actualOutcome ? 1 : 0;
    }

    const calibrationCurve = bins
      .filter((b) => b.count > 0)
      .map((b) => ({
        predicted: b.predicted / b.count,
        actual: b.actual / b.count,
        count: b.count,
      }));

    return NextResponse.json({
      ready: true,
      count: outcomes.length,
      calibrationCurve,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to get calibration data" },
      { status: 500 }
    );
  }
}

// POST /api/calibration — record a real outcome
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { analysisId, predictedProbability, actualOutcome } = body;

    if (!analysisId || typeof predictedProbability !== "number" || typeof actualOutcome !== "boolean") {
      return NextResponse.json(
        {
          error:
            "Missing required fields: analysisId (string), predictedProbability (number), actualOutcome (boolean)",
        },
        { status: 400 }
      );
    }

    // Verify the analysis exists
    const analysis = await prisma.analysis.findUnique({
      where: { id: analysisId },
    });

    if (!analysis) {
      return NextResponse.json(
        { error: "Analysis not found" },
        { status: 404 }
      );
    }

    const outcome = await prisma.calibrationOutcome.create({
      data: {
        analysisId,
        predictedProbability,
        actualOutcome,
      },
    });

    return NextResponse.json({ id: outcome.id }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to record outcome" },
      { status: 500 }
    );
  }
}
