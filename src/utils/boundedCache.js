/** Process-local cache with expiry and an explicit capacity limit. */
export class BoundedCache {
  constructor(maxEntries) {
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh insertion order so eviction keeps recently accessed entries.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs) {
    const now = Date.now();
    for (const [entryKey, entry] of this.entries) {
      if (now >= entry.expiresAt) this.entries.delete(entryKey);
    }
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: now + ttlMs });
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
  }

  delete(key) { return this.entries.delete(key); }
  clear() { this.entries.clear(); }
  keys() { return this.entries.keys(); }
}
