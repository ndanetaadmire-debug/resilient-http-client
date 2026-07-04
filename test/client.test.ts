import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AbortedError,
  CircuitOpenError,
  HttpStatusError,
  NetworkError,
  ResponseValidationError,
  TimeoutError,
} from "../src/index.js";
import { testClient } from "./fakes.js";

describe("URLs", () => {
  it("encodes query values instead of concatenating them", async () => {
    const { client, calls } = testClient([{ status: 200, body: [] }]);
    await client.get("filter", { query: { type: "social&admin=true", participants: 2, missing: undefined, tag: ["a b", "c"] } });
    expect(calls[0]!.url).toBe("https://api.example.test/v1/filter?type=social%26admin%3Dtrue&participants=2&tag=a+b&tag=c");
  });

  it("refuses absolute URLs and paths that escape the base", () => {
    const { client } = testClient([]);
    expect(() => client.buildUrl("https://evil.example/steal")).toThrow(TypeError);
    expect(() => client.buildUrl("//evil.example/steal")).toThrow(TypeError);
    expect(() => client.buildUrl("../admin")).toThrow(/escapes/);
    expect(client.buildUrl("/random").href).toBe("https://api.example.test/v1/random");
  });
});

describe("retries", () => {
  it("retries a 503 with jittered backoff and succeeds", async () => {
    const onRetry = vi.fn();
    const { client, calls, time } = testClient([{ status: 503 }, { status: 503 }, { status: 200, body: { ok: true } }], {
      events: { onRetry },
    });
    const res = await client.get("random");
    expect(res).toMatchObject({ data: { ok: true }, status: 200, attempts: 3 });
    expect(calls).toHaveLength(3);
    expect(time.sleeps).toEqual([100, 200]); // random() = 0.5 of 200ms, then of 400ms
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxAttempts with the last status", async () => {
    const { client, calls } = testClient([{ status: 502, body: { error: "bad gateway" } }]);
    const err = await client.get("random").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpStatusError);
    expect(err).toMatchObject({ status: 502, body: { error: "bad gateway" } });
    expect(calls).toHaveLength(3);
  });

  it("does not retry client errors", async () => {
    const { client, calls } = testClient([{ status: 404, body: { error: "nope" } }]);
    await expect(client.get("random")).rejects.toMatchObject({ status: 404 });
    expect(calls).toHaveLength(1);
  });

  it("never retries a POST unless it carries an idempotency key", async () => {
    const plain = testClient([{ status: 503 }, { status: 201, body: { id: 1 } }]);
    await expect(plain.client.post("orders", { body: { qty: 1 } })).rejects.toBeInstanceOf(HttpStatusError);
    expect(plain.calls).toHaveLength(1);

    const keyed = testClient([{ status: 503 }, { status: 201, body: { id: 1 } }]);
    const res = await keyed.client.post("orders", { body: { qty: 1 }, idempotencyKey: "order-abc-123" });
    expect(res.status).toBe(201);
    expect(keyed.calls.map((c) => c.headers.get("idempotency-key"))).toEqual(["order-abc-123", "order-abc-123"]);
    expect(keyed.calls[0]!.body).toBe('{"qty":1}');
  });

  it("honours Retry-After when it is longer than the backoff", async () => {
    const { client, time } = testClient([{ status: 429, headers: { "retry-after": "3" } }, { status: 200, body: {} }]);
    await client.get("random");
    expect(time.sleeps).toEqual([3_000]);
  });

  it("gives up rather than wait for an unreasonable Retry-After", async () => {
    const { client, calls } = testClient([{ status: 503, headers: { "retry-after": "3600" } }, { status: 200 }]);
    await expect(client.get("random")).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(1);
  });

  it("retries network errors", async () => {
    const { client, calls } = testClient([{ networkError: "ECONNRESET" }, { status: 200, body: { ok: 1 } }]);
    expect((await client.get("random")).data).toEqual({ ok: 1 });
    expect(calls).toHaveLength(2);
  });

  it("wraps a persistent network failure in NetworkError", async () => {
    const { client } = testClient([{ networkError: "getaddrinfo ENOTFOUND" }], { retry: { maxAttempts: 1 } });
    const err = await client.get("random").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as Error).message).toContain("ENOTFOUND");
  });
});

describe("timeouts and cancellation", () => {
  it("times out a hanging attempt", async () => {
    const { client } = testClient([{ hang: true }], { timeoutMs: 20, retry: { maxAttempts: 1 } });
    const err = await client.get("random").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).timeoutMs).toBe(20);
  });

  it("does not retry when the caller aborts", async () => {
    const controller = new AbortController();
    const { client, calls } = testClient([{ hang: true }], { timeoutMs: 5_000 });
    const pending = client.get("random", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AbortedError);
    expect(calls).toHaveLength(1);
  });
});

describe("circuit breaker", () => {
  it("opens after repeated 5xx, fails fast, then recovers through a probe", async () => {
    const changes: string[] = [];
    const { client, calls, time } = testClient(
      [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 200, body: { back: true } }],
      {
        retry: { maxAttempts: 1 },
        breaker: { failureThreshold: 3, cooldownMs: 10_000 },
        events: { onCircuitChange: (e) => changes.push(`${e.from}->${e.to}`) },
      },
    );
    for (let i = 0; i < 3; i++) await expect(client.get("random")).rejects.toBeInstanceOf(HttpStatusError);
    const fast = await client.get("random").catch((e: unknown) => e);
    expect(fast).toBeInstanceOf(CircuitOpenError);
    expect(calls).toHaveLength(3); // the fourth request was never sent
    time.advance(10_000);
    expect((await client.get("random")).data).toEqual({ back: true });
    expect(client.circuitState("api.example.test")).toBe("closed");
    expect(changes).toEqual(["closed->open", "open->half_open", "half_open->closed"]);
  });

  it("does not count 4xx against the circuit", async () => {
    const { client } = testClient([{ status: 404 }], { retry: { maxAttempts: 1 }, breaker: { failureThreshold: 2 } });
    for (let i = 0; i < 5; i++) await expect(client.get("random")).rejects.toMatchObject({ status: 404 });
    expect(client.circuitState("api.example.test")).toBe("closed");
  });

  it("can be disabled", async () => {
    const { client, calls } = testClient([{ status: 500 }], { retry: { maxAttempts: 1 }, breaker: false });
    for (let i = 0; i < 10; i++) await expect(client.get("random")).rejects.toBeInstanceOf(HttpStatusError);
    expect(calls).toHaveLength(10);
  });
});

describe("single-flight and caching", () => {
  it("shares one upstream call between concurrent identical GETs", async () => {
    const { client, calls } = testClient([{ status: 200, body: { n: 1 } }]);
    const results = await Promise.all([client.get("random"), client.get("random"), client.get("random")]);
    expect(calls).toHaveLength(1);
    expect(results.map((r) => r.data)).toEqual([{ n: 1 }, { n: 1 }, { n: 1 }]);
  });

  it("serves cached GETs within the TTL", async () => {
    const { client, calls, time } = testClient([{ status: 200, body: { v: 1 } }, { status: 200, body: { v: 2 } }]);
    await client.get("config", { cacheTtlMs: 1_000 });
    const hit = await client.get("config", { cacheTtlMs: 1_000 });
    expect(hit).toMatchObject({ data: { v: 1 }, fromCache: true, attempts: 0 });
    time.advance(1_000);
    expect((await client.get("config", { cacheTtlMs: 1_000 })).data).toEqual({ v: 2 });
    expect(calls).toHaveLength(2);
  });

  it("serves the last good response when the upstream is down (stale-if-error)", async () => {
    const { client, time } = testClient([{ status: 200, body: { v: 1 } }, { status: 503 }], {
      cache: { staleIfError: true },
      retry: { maxAttempts: 1 },
    });
    await client.get("config", { cacheTtlMs: 1_000 });
    time.advance(5_000);
    const res = await client.get("config", { cacheTtlMs: 1_000 });
    expect(res).toMatchObject({ data: { v: 1 }, stale: true, fromCache: true });
  });
});

describe("responses", () => {
  it("validates against a schema and types the result", async () => {
    const { client } = testClient([{ status: 200, body: { activity: "Read", participants: 1 } }]);
    const schema = z.object({ activity: z.string(), participants: z.number() });
    const { data } = await client.get("random", { schema });
    expect(data.activity.toUpperCase()).toBe("READ");
  });

  it("rejects an unexpected shape without retrying", async () => {
    const { client, calls } = testClient([{ status: 200, body: { activity: 42 } }]);
    await expect(client.get("random", { schema: z.object({ activity: z.string() }) })).rejects.toBeInstanceOf(
      ResponseValidationError,
    );
    expect(calls).toHaveLength(1);
  });

  it("handles text bodies, empty bodies and broken JSON", async () => {
    const { client } = testClient([
      { status: 200, body: "plain text" },
      { status: 204 },
      { status: 200, body: "{not json", headers: { "content-type": "application/json" } },
    ]);
    expect((await client.get("a")).data).toBe("plain text");
    expect((await client.get("b")).data).toBeNull();
    expect((await client.get("c")).data).toBe("{not json");
  });

  it("merges default and per-request headers", async () => {
    const { client, calls } = testClient([{ status: 200 }], { headers: { authorization: "Bearer t", "x-app": "a" } });
    await client.get("random", { headers: { "x-app": "b" } });
    expect(Object.fromEntries(calls[0]!.headers)).toMatchObject({ authorization: "Bearer t", "x-app": "b", accept: "application/json" });
  });
});
