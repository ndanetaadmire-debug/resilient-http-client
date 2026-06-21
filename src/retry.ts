export interface RetryPolicy {
  /** Total attempts including the first. 1 disables retries. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** HTTP methods that are safe to repeat. POST and PATCH are excluded by default. */
  readonly methods: readonly string[];
  /** Status codes worth retrying. */
  readonly statuses: readonly number[];
  /** Never wait longer than this for a Retry-After header; give up instead. */
  readonly maxRetryAfterMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 5_000,
  methods: ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"],
  statuses: [408, 425, 429, 500, 502, 503, 504],
  maxRetryAfterMs: 30_000,
};

/**
 * "Full jitter" exponential backoff: a random delay between 0 and
 * min(cap, base * 2^attempt). Spreads retries from many clients so they don't
 * hit a recovering server in lockstep.
 */
export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

/**
 * Parses Retry-After, which is either delay-seconds or an HTTP date.
 * Returns undefined for a missing or malformed header.
 */
export function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  // HTTP dates always contain a weekday or month name; this rejects "-5", "1.5" and the like.
  if (!/[a-z]/i.test(trimmed)) return undefined;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

/** An idempotency key makes a non-idempotent method safe to retry. */
export function isRetryableMethod(method: string, policy: RetryPolicy, hasIdempotencyKey: boolean): boolean {
  return policy.methods.includes(method.toUpperCase()) || hasIdempotencyKey;
}
