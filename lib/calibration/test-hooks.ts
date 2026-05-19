/**
 * Test-only injection point for the /api/calibration route's R6-06
 * sidecar handoff. Mirrors lib/forecast/test-hooks.ts in shape so the two
 * routes have the same DX.
 *
 * Production code never touches this module; it exists so unit tests for
 * the calibration handler can swap in a pre-built EnsembleClient (with a
 * fake fetch) without booting the Python sidecar in CI.
 *
 * NEVER call setCalibrationTestOptions from app code.
 */

import type {
  EnsembleClient,
  EnsembleClientOptions,
} from "@/lib/services/ensemble-client";

export interface CalibrationRouteTestOptions {
  ensembleClient?: EnsembleClient;
  clientOptions?: EnsembleClientOptions;
}

let injected: CalibrationRouteTestOptions = {};

export function setCalibrationTestOptions(
  options: CalibrationRouteTestOptions,
): void {
  injected = options ?? {};
}

export function resetCalibrationTestOptions(): void {
  injected = {};
}

export function getCalibrationTestOptions(): CalibrationRouteTestOptions {
  return injected;
}
