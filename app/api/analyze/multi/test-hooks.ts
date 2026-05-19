/**
 * R6-02 — Test-only hooks for /api/analyze/multi.
 *
 * Next.js disallows non-handler exports from a route.ts file (S5-02 lesson),
 * so the rate-limit counter lives here as a shared module. The handler and
 * tests both import it; only tests call `resetRateLimit`.
 *
 * Keep this file thin and product-mock-free: it exposes only the in-process
 * counter state.
 */

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 5;
const requestTimes: number[] = [];

export function getRateLimitWindowMs() {
  return RATE_LIMIT_WINDOW_MS;
}

export function getRateLimitMaxRequests() {
  return RATE_LIMIT_MAX_REQUESTS;
}

/**
 * Returns true if the rate limit was exceeded for the current call. When
 * false, the call is recorded in the window.
 */
export function isRateLimited(): boolean {
  const now = Date.now();
  while (
    requestTimes.length > 0 &&
    now - requestTimes[0] > RATE_LIMIT_WINDOW_MS
  ) {
    requestTimes.shift();
  }
  if (requestTimes.length >= RATE_LIMIT_MAX_REQUESTS) return true;
  requestTimes.push(now);
  return false;
}

/** Test-only: clear the in-memory window so tests can be deterministic. */
export function resetRateLimit() {
  requestTimes.length = 0;
}
