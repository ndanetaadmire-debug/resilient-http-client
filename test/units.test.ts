import { describe, expect, it } from "vitest";
import { backoffDelay, CircuitBreaker, DEFAULT_RETRY, parseRetryAfter, TtlLruCache, type CircuitState } from "../src/index.js";

describe("backoffDelay", () => {
  it("grows exponentially up to the cap, with full jitter", () => {
    const max = (attempt: number) => backoffDelay(attempt, DEFAULT_RETRY, () => 0.999999);
    expect([1, 2, 3, 4, 5, 6, 10].map(max)).toEqual([199, 399, 799, 1599, 3199, 4999, 4999]);
    expect(backoffDelay(3, DEFAULT_RETRY, () => 0)).toBe(0);
  });

  it("stays within [0, ceiling) for random draws", () => {
    for (let attempt = 1; attempt <= 8; attempt++) {
      for (let k = 0; k < 200; k++) {
        const d = backoffDelay(attempt, DEFAULT_RETRY, Math.random);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThan(Math.min(DEFAULT_RETRY.maxDelayMs, DEFAULT_RETRY.baseDelayMs * 2 ** (attempt - 1)));
      }
    }
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-11-14T10:00:00Z");
  it("reads seconds and HTTP dates", () => {
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter("Sat, 14 Nov 2026 10:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter("Sat, 14 Nov 2026 09:00:00 GMT", now)).toBe(0);
  });
  it("ignores missing or junk values", () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter("-5", now)).toBeUndefined();
  });
});

describe("CircuitBreaker", () => {
  function setup() {
    let t = 0;
    const changes: string[] = [];
    const breaker = new CircuitBreaker(
      { failureThreshold: 3, windowMs: 10_000, cooldownMs: 5_000, halfOpenMaxProbes: 1 },
      () => t,
      (from: CircuitState, to: CircuitState) => changes.push(`${from}->${to}`),
    );
    return { breaker, changes, tick: (ms: number) => (t += ms) };
  }

  it("opens after the threshold, then half-opens after the cooldown and closes on success", () => {
    const { breaker, changes, tick } = setup();
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.current()).toBe("closed");
    breaker.onFailure();
    expect(breaker.current()).toBe("open");
    expect(breaker.tryAcquire()).toBe(5_000);
    tick(4_000);
    expect(breaker.tryAcquire()).toBe(1_000);
    tick(1_000);
    expect(breaker.tryAcquire()).toBe(0); // the probe
    expect(breaker.tryAcquire()).toBeGreaterThan(0); // only one probe at a time
    breaker.onSuccess();
    expect(breaker.current()).toBe("closed");
    expect(changes).toEqual(["closed->open", "open->half_open", "half_open->closed"]);
  });

  it("re-opens when the probe fails", () => {
    const { breaker, tick } = setup();
    for (let i = 0; i < 3; i++) breaker.onFailure();
    tick(5_000);
    expect(breaker.tryAcquire()).toBe(0);
    breaker.onFailure();
    expect(breaker.current()).toBe("open");
    expect(breaker.tryAcquire()).toBe(5_000);
  });

  it("forgets failures outside the window", () => {
    const { breaker, tick } = setup();
    breaker.onFailure();
    breaker.onFailure();
    tick(10_001);
    breaker.onFailure();
    expect(breaker.current()).toBe("closed");
  });
});

describe("TtlLruCache", () => {
  it("expires entries and evicts the least recently used", () => {
    let t = 0;
    const cache = new TtlLruCache<string>(2, () => t);
    cache.set("a", "A", 100);
    cache.set("b", "B", 100);
    cache.get("a"); // a is now most recent
    cache.set("c", "C", 100); // evicts b
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("A");
    t = 100;
    expect(cache.get("a")).toBeUndefined();
    expect(cache.getStale("a")).toBe("A"); // kept for stale-if-error
    expect(cache.getStale("c")).toBe("C");
  });

  it("rejects a non-positive size", () => {
    expect(() => new TtlLruCache(0, Date.now)).toThrow(RangeError);
  });
});
