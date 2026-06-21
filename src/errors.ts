/** Base class so callers can catch everything this library throws with one `instanceof`. */
export class HttpClientError extends Error {
  constructor(
    message: string,
    readonly request: { method: string; url: string },
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The server answered with a non-2xx status after all retries. */
export class HttpStatusError extends HttpClientError {
  constructor(
    request: { method: string; url: string },
    readonly status: number,
    readonly body: unknown,
    readonly headers: Headers,
  ) {
    super(`${request.method} ${request.url} failed with HTTP ${status}`, request);
  }
}

/** One attempt took longer than `timeoutMs`. */
export class TimeoutError extends HttpClientError {
  constructor(request: { method: string; url: string }, readonly timeoutMs: number) {
    super(`${request.method} ${request.url} timed out after ${timeoutMs}ms`, request);
  }
}

/** DNS failure, connection refused or reset: the request never got an HTTP answer. */
export class NetworkError extends HttpClientError {}

/** The caller's own AbortSignal fired. Never retried. */
export class AbortedError extends HttpClientError {}

/** The circuit for this host is open; the request was not sent. */
export class CircuitOpenError extends HttpClientError {
  constructor(request: { method: string; url: string }, readonly retryAfterMs: number) {
    super(`Circuit open for ${new URL(request.url).host}; retry in ${retryAfterMs}ms`, request);
  }
}

/** The response arrived but didn't match the schema the caller expects. */
export class ResponseValidationError extends HttpClientError {}
