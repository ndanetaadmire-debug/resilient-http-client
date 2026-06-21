interface Entry<V> {
  value: V;
  expiresAt: number;
}

/**
 * Small LRU cache with per-entry TTL. A Map keeps insertion order, so the
 * first key is always the least recently used.
 */
export class TtlLruCache<V> {
  private readonly map = new Map<string, Entry<V>>();

  constructor(
    private readonly maxEntries: number,
    private readonly now: () => number,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError("maxEntries must be a positive integer");
  }

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    // Expired entries stay (until LRU eviction) so getStale can still serve them during an outage.
    if (entry.expiresAt <= this.now()) return undefined;
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /** Returns the value even if expired: used as a last-resort fallback when the upstream is down. */
  getStale(key: string): V | undefined {
    return this.map.get(key)?.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}
