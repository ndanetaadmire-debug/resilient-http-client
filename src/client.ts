import { CircuitBreaker, DEFAULT_BREAKER, type BreakerOptions, type CircuitState } from "./breaker.js";
import { TtlLruCache } from "./cache.js";
import {
  AbortedError,
  CircuitOpenError,
  HttpClientError,
  HttpStatusError,
  NetworkError,
  ResponseValidationError,
  TimeoutError,
} from "./errors.js";
import { backoffDelay, DEFAULT_RETRY, isRetryableMethod, parseRetryAfter, type RetryPolicy } from "./retry.js";

/** Anything with a `parse` method: a Zod, Valibot or ArkType schema, or a hand-written guard. */
export interface Schema<T> {
  parse(input: unknown): T;
}

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions<T> {
  readonly query?: Readonly<Record<string, QueryValue | readonly QueryValue[]>>;
  readonly headers?: Readonly<Record<string, string>>;
  /** Sent as JSON. */
  readonly body?: unknown;
  readonly schema?: Schema<T>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Cache successful GETs for this long. Overrides the client default. 0 disables. */
  readonly cacheTtlMs?: number;
  /** Makes POST/PATCH retryable; sent as the Idempotency-Key header. */
  readonly idempotencyKey?: string;
  readonly retry?: Partial<RetryPolicy>;
}

export interface HttpResponse<T> {
  readonly data: T;
  readonly status: number;
  readonly headers: Headers;
  /** How many attempts it took; 1 means no retries. */
  readonly attempts: number;
  readonly fromCache: boolean;
  /** True when the upstream failed and an expired cached copy was served instead. */
  readonly stale: boolean;
}

export interface ClientEvents {
  onRequest?(e: { method: string; url: string; attempt: number }): void;
  onResponse?(e: { method: string; url: string; status: number; attempt: number; durationMs: number }): void;
  onRetry?(e: { method: string; url: string; attempt: number; delayMs: number; reason: string }): void;
  onCircuitChange?(e: { host: string; from: CircuitState; to: CircuitState }): void;
}

export interface ClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly retry?: Partial<RetryPolicy>;
  /** Pass `false` to disable the circuit breaker. */
  readonly breaker?: Partial<BreakerOptions> | false;
  readonly cache?: { readonly maxEntries?: number; readonly defaultTtlMs?: number; readonly staleIfError?: boolean };
  readonly events?: ClientEvents;
  /** Injection points; defaults are the platform ones. Tests replace them to stay deterministic. */
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

export class HttpClient {
  private readonly base: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly cache: TtlLruCache<HttpResponse<unknown>>;
  private readonly inFlight = new Map<string, Promise<HttpResponse<unknown>>>();

  constructor(private readonly options: ClientOptions) {
    this.base = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
    if (this.base.protocol !== "https:" && this.base.protocol !== "http:") {
      throw new TypeError(`Unsupported protocol ${this.base.protocol}`);
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
    this.cache = new TtlLruCache(options.cache?.maxEntries ?? 500, this.now);
  }

  get<T = unknown>(path: string, opts?: RequestOptions<T>) {
    return this.request<T>("GET", path, opts);
  }
  post<T = unknown>(path: string, opts?: RequestOptions<T>) {
    return this.request<T>("POST", path, opts);
  }
  put<T = unknown>(path: string, opts?: RequestOptions<T>) {
    return this.request<T>("PUT", path, opts);
  }
  patch<T = unknown>(path: string, opts?: RequestOptions<T>) {
    return this.request<T>("PATCH", path, opts);
  }
  delete<T = unknown>(path: string, opts?: RequestOptions<T>) {
    return this.request<T>("DELETE", path, opts);
  }

  /** Builds the URL. Query values are always encoded, never concatenated into the path. */
  buildUrl(path: string, query?: RequestOptions<unknown>["query"]): URL {
    if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) {
      // An absolute URL here could point the client (and its auth headers) at another host.
      throw new TypeError(`Pass a path relative to the base URL, not "${path}"`);
    }
    const url = new URL(path.replace(/^\/+/, ""), this.base);
    if (!url.href.startsWith(this.base.href)) throw new TypeError(`Path "${path}" escapes the base URL`);
    for (const [key, raw] of Object.entries(query ?? {})) {
      for (const value of Array.isArray(raw) ? raw : [raw]) {
        if (value !== undefined && value !== null) url.searchParams.append(key, String(value));
      }
    }
    return url;
  }

  circuitState(host: string): CircuitState {
    return this.breakers.get(host)?.current() ?? "closed";
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions<T> = {}): Promise<HttpResponse<T>> {
    const verb = method.toUpperCase();
    const url = this.buildUrl(path, opts.query);
    const ttl = opts.cacheTtlMs ?? this.options.cache?.defaultTtlMs ?? 0;
    const cacheable = verb === "GET" && ttl > 0 && opts.body === undefined;
    const key = `${verb} ${url.href}`;

    if (cacheable) {
      const hit = this.cache.get(key);
      if (hit) return { ...(hit as HttpResponse<T>), fromCache: true, attempts: 0 };
    }

    // Single-flight: concurrent identical GETs share one upstream call.
    if (verb === "GET" && !opts.signal) {
      const pending = this.inFlight.get(key);
      if (pending) return pending as Promise<HttpResponse<T>>;
    }

    const run = this.execute<T>(verb, url, opts)
      .then((res) => {
        if (cacheable) this.cache.set(key, res, ttl);
        return res;
      })
      .catch((err: unknown) => {
        const stale = cacheable && this.options.cache?.staleIfError ? this.cache.getStale(key) : undefined;
        if (stale && !(err instanceof AbortedError) && !(err instanceof ResponseValidationError)) {
          return { ...(stale as HttpResponse<T>), fromCache: true, stale: true, attempts: 0 };
        }
        throw err;
      })
      .finally(() => this.inFlight.delete(key));

    if (verb === "GET" && !opts.signal) this.inFlight.set(key, run as Promise<HttpResponse<unknown>>);
    return run;
  }

  private breakerFor(host: string): CircuitBreaker | undefined {
    if (this.options.breaker === false) return undefined;
    let breaker = this.breakers.get(host);
    if (!breaker) {
      const events = this.options.events;
      breaker = new CircuitBreaker({ ...DEFAULT_BREAKER, ...this.options.breaker }, this.now, (from, to) =>
        events?.onCircuitChange?.({ host, from, to }),
      );
      this.breakers.set(host, breaker);
    }
    return breaker;
  }

  private async execute<T>(method: string, url: URL, opts: RequestOptions<T>): Promise<HttpResponse<T>> {
    const policy: RetryPolicy = { ...DEFAULT_RETRY, ...this.options.retry, ...opts.retry };
    const retryable = isRetryableMethod(method, policy, opts.idempotencyKey !== undefined);
    const maxAttempts = retryable ? Math.max(1, policy.maxAttempts) : 1;
    const timeoutMs = opts.timeoutMs ?? this.options.timeoutMs ?? 10_000;
    const req = { method, url: url.href };
    const breaker = this.breakerFor(url.host);
    const headers = new Headers({ accept: "application/json", ...this.options.headers, ...opts.headers });
    if (opts.body !== undefined) headers.set("content-type", "application/json");
    if (opts.idempotencyKey !== undefined) headers.set("idempotency-key", opts.idempotencyKey);
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);

    for (let attempt = 1; ; attempt++) {
      if (opts.signal?.aborted) throw new AbortedError("Request aborted by caller", req, { cause: opts.signal.reason });
      const waitMs = breaker?.tryAcquire() ?? 0;
      if (waitMs > 0) throw new CircuitOpenError(req, waitMs);

      this.options.events?.onRequest?.({ ...req, attempt });
      const started = this.now();
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(new TimeoutError(req, timeoutMs)), timeoutMs);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout.signal]) : timeout.signal;

      let failure: HttpClientError;
      let retryAfterMs: number | undefined;
      try {
        const res = await this.fetchImpl(url, { method, headers, body: body ?? null, signal });
        const data = await readBody(res);
        this.options.events?.onResponse?.({ ...req, status: res.status, attempt, durationMs: this.now() - started });
        if (res.ok) {
          breaker?.onSuccess();
          return { data: validate(opts.schema, data, req), status: res.status, headers: res.headers, attempts: attempt, fromCache: false, stale: false };
        }
        failure = new HttpStatusError(req, res.status, data, res.headers);
        // Only server-side trouble counts against the circuit; a 404 means the host is healthy.
        if (res.status >= 500) breaker?.onFailure();
        else breaker?.onSuccess();
        if (!policy.statuses.includes(res.status)) throw failure;
        retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), this.now());
      } catch (err) {
        if (err instanceof HttpStatusError || err instanceof ResponseValidationError) throw err;
        if (opts.signal?.aborted) throw new AbortedError("Request aborted by caller", req, { cause: opts.signal.reason });
        breaker?.onFailure();
        failure = timeout.signal.aborted ? new TimeoutError(req, timeoutMs) : new NetworkError(`${method} ${url.href} failed: ${String((err as Error)?.message ?? err)}`, req, { cause: err });
      } finally {
        clearTimeout(timer);
      }

      if (attempt >= maxAttempts) throw failure;
      if (retryAfterMs !== undefined && retryAfterMs > policy.maxRetryAfterMs) throw failure;
      const delayMs = Math.max(backoffDelay(attempt, policy, this.random), retryAfterMs ?? 0);
      this.options.events?.onRetry?.({ ...req, attempt, delayMs, reason: failure.message });
      try {
        await this.sleep(delayMs, opts.signal);
      } catch (err) {
        throw new AbortedError("Request aborted by caller", req, { cause: err });
      }
    }
  }
}

async function readBody(res: Response): Promise<unknown> {
  if (res.status === 204 || res.status === 205) return null;
  const text = await res.text();
  if (text.length === 0) return null;
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function validate<T>(schema: Schema<T> | undefined, data: unknown, req: { method: string; url: string }): T {
  if (!schema) return data as T;
  try {
    return schema.parse(data);
  } catch (err) {
    throw new ResponseValidationError(`${req.method} ${req.url} returned an unexpected shape`, req, { cause: err });
  }
}

export function createClient(options: ClientOptions): HttpClient {
  return new HttpClient(options);
}
