/**
 * Test-only injection point for the /api/forecast route.
 *
 * Production code never touches this module; it exists so the unit test
 * for the API handler can swap in a pre-built EnsembleClient (with a fake
 * fetch) without booting the Python sidecar in CI.
 *
 * The route reads `injectedOptions` at request time; tests set it via
 * `setForecastTestOptions` and reset it with `resetForecastTestOptions`.
 *
 * NEVER call setForecastTestOptions from app code.
 */

import type {
  EnsembleClient,
  EnsembleClientOptions,
} from "@/lib/services/ensemble-client";

export interface ForecastRouteTestOptions {
  ensembleClient?: EnsembleClient;
  clientOptions?: EnsembleClientOptions;
}

let injected: ForecastRouteTestOptions = {};

export function setForecastTestOptions(options: ForecastRouteTestOptions): void {
  injected = options ?? {};
}

export function resetForecastTestOptions(): void {
  injected = {};
}

export function getForecastTestOptions(): ForecastRouteTestOptions {
  return injected;
}
