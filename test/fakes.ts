import { createClient, type ClientOptions } from "../src/index.js";

export type Reply =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | { networkError: string }
  | { hang: true };

/**
 * Scripted fetch. Each call takes the next reply; the last reply repeats.
 * Records every request so tests can assert on URLs, headers and counts.
 */
export function scriptedFetch(replies: Reply[]) {
  const calls: { url: string; method: string; headers: Headers; body: string | null }[] = [];
  let i = 0;
  const fn = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: (init?.body as string | null | undefined) ?? null,
    });
    const reply = replies[Math.min(i++, replies.length - 1)]!;
    if ("networkError" in reply) throw new TypeError(reply.networkError);
    if ("hang" in reply) {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    const isJson = reply.body !== undefined && typeof reply.body !== "string";
    return new Response(reply.body === undefined ? null : isJson ? JSON.stringify(reply.body) : (reply.body as string), {
      status: reply.status,
      headers: { ...(isJson ? { "content-type": "application/json" } : {}), ...reply.headers },
    });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

/** A clock the test moves by hand; `sleep` advances it instead of waiting. */
export function manualTime(start = 1_700_000_000_000) {
  let now = start;
  const sleeps: number[] = [];
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw signal.reason;
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
}

export function testClient(replies: Reply[], overrides: Partial<ClientOptions> = {}) {
  const f = scriptedFetch(replies);
  const time = manualTime();
  const client = createClient({
    baseUrl: "https://api.example.test/v1",
    fetch: f.fetch,
    now: time.now,
    sleep: time.sleep,
    random: () => 0.5,
    ...overrides,
  });
  return { client, calls: f.calls, time };
}
