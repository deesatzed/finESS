import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { apiError, readJsonBody, validationError } from "@/lib/api/errors";
import { getAuthenticatedContext } from "@/lib/auth/local-session";
import { validateCalibrationOutcomeRequest } from "@/lib/validation/schemas";

const MIN_OUTCOMES_FOR_CURVE = 20;

// GET /api/calibration — get calibration data
export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedContext(request);
    if (!auth) return apiError("UNAUTHENTICATED", "Authentication required", 401);

    const outcomes = await prisma.calibrationOutcome.findMany({
      where: {
        userId: auth.userId,
        workspaceId: auth.workspaceId,
      },
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
  } catch {
    return apiError("DATABASE_ERROR", "Failed to get calibration data", 500);
  }
}

// POST /api/calibration — record a real outcome
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthenticatedContext(request);
    if (!auth) return apiError("UNAUTHENTICATED", "Authentication required", 401);

    const { analysisId, predictedProbability, actualOutcome } =
      validateCalibrationOutcomeRequest(await readJsonBody(request));

    // Verify the analysis exists
    const analysis = await prisma.analysis.findFirst({
      where: {
        id: analysisId,
        userId: auth.userId,
        workspaceId: auth.workspaceId,
      },
    });

    if (!analysis) {
      return apiError("NOT_FOUND", "Analysis not found", 404);
    }

    const outcome = await prisma.calibrationOutcome.create({
      data: {
        userId: auth.userId,
        workspaceId: auth.workspaceId,
        analysisId,
        predictedProbability,
        actualOutcome,
      },
    });

    return NextResponse.json({ id: outcome.id }, { status: 201 });
  } catch (error) {
    const validation = validationError(error);
    if (validation) return validation;
    return apiError("DATABASE_ERROR", "Failed to record outcome", 500);
  }
}
