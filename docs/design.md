# Design notes

## Why not just use axios or ky?
They're good libraries. This one exists to show the reasoning behind each resilience feature and to keep the dependency count at zero. The part that's easy to get wrong is how the features interact: retries inside a circuit breaker, caching alongside single-flight, and timeouts alongside caller aborts. That's where the tests concentrate.

## Retries
- **Full jitter** (`random(0, min(cap, base·2ⁿ))`), as recommended in AWS's "Exponential Backoff and Jitter". With equal or no jitter, clients that failed together retry together and knock the server over again.
- **Idempotency first.** Retrying a POST can charge a card twice. POST and PATCH are retried only when the caller supplies an idempotency key, which the client also sends as the `Idempotency-Key` header.
- **Retry-After wins** when it's longer than the backoff. If the server asks for more than `maxRetryAfterMs` (default 30 s), the client gives up immediately instead of holding a request open for an hour.
- **Validation failures aren't retried**, because the same request will get the same wrong shape.

## Circuit breaker
- **Per host**, so one bad dependency doesn't block the others.
- **Only 5xx, timeouts and network errors count.** A 404 or 422 means the server is up and answering, and counting them would let user mistakes trip the breaker.
- **Half-open allows one probe by default.** Letting every queued request through as the probe would recreate the thundering herd the breaker exists to prevent.
- **State is in memory, per process.** That's deliberate. A shared breaker in Redis adds a network call to every request, and is only worth it with many instances calling a fragile API.

## Cache and single-flight
- **Caching is opt-in per request**, because only the caller knows how fresh data needs to be.
- **Expired entries are kept until LRU eviction**, so `staleIfError` can serve them during an outage. A test caught the first version deleting them on read, which made stale-if-error a no-op.
- **Single-flight is skipped when the caller passes an AbortSignal.** One caller aborting must not cancel the other callers' shared request.

## Known limits
- Response bodies are buffered (`res.text()`), so this isn't for large downloads or streaming.
- There's no request-level retry budget across the whole process. For a high-traffic service, add a token bucket so retries can't exceed about 10% of traffic.
