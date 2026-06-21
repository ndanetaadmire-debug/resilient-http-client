export type CircuitState = "closed" | "open" | "half_open";

export interface BreakerOptions {
  /** Failures within `windowMs` that open the circuit. */
  readonly failureThreshold: number;
  readonly windowMs: number;
  /** How long the circuit stays open before letting a probe through. */
  readonly cooldownMs: number;
  /** Concurrent probe requests allowed while half-open. */
  readonly halfOpenMaxProbes: number;
}

export const DEFAULT_BREAKER: BreakerOptions = {
  failureThreshold: 5,
  windowMs: 30_000,
  cooldownMs: 15_000,
  halfOpenMaxProbes: 1,
};

/**
 * Circuit breaker for one upstream host.
 *
 *   closed ──(N failures in window)──▶ open ──(cooldown)──▶ half_open
 *     ▲                                  ▲                     │
 *     └──────────(probe succeeds)────────┼─────────────────────┤
 *                                        └──(probe fails)──────┘
 *
 * Stops a struggling dependency from being hammered and fails fast instead of
 * making every caller wait for a timeout.
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures: number[] = [];
  private openedAt = 0;
  private probesInFlight = 0;

  constructor(
    private readonly options: BreakerOptions,
    private readonly now: () => number,
    private readonly onStateChange?: (from: CircuitState, to: CircuitState) => void,
  ) {}

  current(): CircuitState {
    if (this.state === "open" && this.now() - this.openedAt >= this.options.cooldownMs) {
      this.move("half_open");
    }
    return this.state;
  }

  /** Returns 0 if a request may go now, otherwise how many ms until it might. */
  tryAcquire(): number {
    const state = this.current();
    if (state === "closed") return 0;
    if (state === "open") return this.options.cooldownMs - (this.now() - this.openedAt);
    if (this.probesInFlight >= this.options.halfOpenMaxProbes) return 1;
    this.probesInFlight += 1;
    return 0;
  }

  onSuccess(): void {
    if (this.state === "half_open") {
      this.probesInFlight = Math.max(0, this.probesInFlight - 1);
      this.failures = [];
      this.move("closed");
    }
  }

  onFailure(): void {
    const t = this.now();
    if (this.state === "half_open") {
      this.probesInFlight = Math.max(0, this.probesInFlight - 1);
      this.open(t);
      return;
    }
    this.failures = this.failures.filter((f) => t - f < this.options.windowMs);
    this.failures.push(t);
    if (this.failures.length >= this.options.failureThreshold) this.open(t);
  }

  private open(at: number): void {
    this.openedAt = at;
    this.failures = [];
    this.move("open");
  }

  private move(to: CircuitState): void {
    if (to === this.state) return;
    const from = this.state;
    this.state = to;
    this.onStateChange?.(from, to);
  }
}
