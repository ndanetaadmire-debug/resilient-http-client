import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActivityApp } from "../examples/activity-finder/app.js";
import { createClient } from "../src/index.js";

/** A real HTTP server standing in for the Bored API, with switchable failure modes. */
let server: Server;
let baseUrl: string;
let mode: "ok" | "flaky" | "down" | "slow" = "ok";
let hits = 0;

const activity = { activity: "Learn to juggle", type: "recreational", participants: 1, price: 0, key: "1" };

beforeAll(async () => {
  server = createServer((req, res) => {
    hits += 1;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (mode === "down") return send(503, { error: "maintenance" });
    if (mode === "flaky" && hits % 2 === 1) return send(502, { error: "bad gateway" });
    if (mode === "slow") return void setTimeout(() => send(200, activity), 300);
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/random") return send(200, activity);
    if (url.pathname === "/filter") {
      const type = url.searchParams.get("type");
      return type === "cooking" ? send(404, { error: "none" }) : send(200, [{ ...activity, type: type ?? activity.type }]);
    }
    send(404, { error: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

function app() {
  const client = createClient({
    baseUrl,
    timeoutMs: 100,
    retry: { maxAttempts: 2, baseDelayMs: 1 },
    breaker: { failureThreshold: 3, cooldownMs: 60_000 },
    cache: { staleIfError: true },
  });
  return createActivityApp(client, { random: () => 0, filterCacheTtlMs: 1 });
}

describe("real fetch against a real server", () => {
  it("retries through a flaky upstream", async () => {
    mode = "flaky";
    hits = 0;
    const res = await request(app()).get("/").expect(200);
    expect(res.text).toContain("Learn to juggle");
    expect(hits).toBe(2);
  });

  it("times out a slow upstream", async () => {
    mode = "slow";
    const client = createClient({ baseUrl, timeoutMs: 50, retry: { maxAttempts: 1 } });
    await expect(client.get("random")).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

describe("activity finder example", () => {
  it("shows a random activity", async () => {
    mode = "ok";
    const res = await request(app()).get("/").expect(200);
    expect(res.text).toContain("Learn to juggle");
  });

  it("passes filters as encoded query params", async () => {
    mode = "ok";
    const res = await request(app()).post("/").type("form").send({ type: "social", participants: "2" }).expect(200);
    expect(res.text).toContain("social");
  });

  it("rejects values outside the allowed lists", async () => {
    const res = await request(app()).post("/").type("form").send({ type: "social&x=1", participants: "99" }).expect(422);
    expect(res.text).toContain("valid type");
  });

  it("explains when nothing matches", async () => {
    mode = "ok";
    const res = await request(app()).post("/").type("form").send({ type: "cooking" }).expect(404);
    expect(res.text).toContain("No activities match");
  });

  it("serves the last good results while the upstream is down, then fails fast", async () => {
    mode = "ok";
    const instance = app();
    await request(instance).post("/").type("form").send({ type: "social" }).expect(200);
    await new Promise((r) => setTimeout(r, 5)); // let the cached copy expire
    mode = "down";
    const stale = await request(instance).post("/").type("form").send({ type: "social" }).expect(200);
    expect(stale.text).toContain("saved results");
    // /random is never cached, so it shows the outage and then the circuit opens.
    await request(instance).get("/").expect(503);
    hits = 0;
    const open = await request(instance).get("/").expect(503);
    expect(open.text).toContain("paused requests");
    expect(hits).toBe(0);
  });
});
