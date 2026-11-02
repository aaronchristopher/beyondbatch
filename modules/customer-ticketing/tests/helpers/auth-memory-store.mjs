/** Test-only deterministic fake of the shared store contract. Never imported by
 * runtime code and never a production fallback. Reuse the returned object to
 * simulate several service instances sharing one store. Native integration
 * tests independently verify database atomicity and persistence.
 */
export function createMemoryAuthStore({ namespace = 'fictional-auth' } = {}) {
  if (typeof namespace !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/.test(namespace)) throw new TypeError('Invalid test namespace');
  const entries = new Map(), sessions = new Map();
  const copy = value => structuredClone(value);
  return Object.freeze({
    async insert(key, value, expiresAtMs) {
      if (entries.has(key)) return false;
      entries.set(key, copy({ value, expiresAtMs })); return true;
    },
    async get(key, nowMs) {
      const record = entries.get(key);
      return record && record.expiresAtMs > nowMs ? copy(record) : null;
    },
    async consume(key, nowMs) {
      const record = entries.get(key);
      if (!record || record.expiresAtMs <= nowMs) return null;
      entries.delete(key); return copy(record);
    },
    async remove(key) { return entries.delete(key); },
    async takeRateLimit(key, nowMs, windowMs, limit) {
      if (typeof key !== 'string' || !/^rate:[0-9a-f]{64}$/.test(key)
          || !Number.isSafeInteger(nowMs) || nowMs < 0
          || !Number.isSafeInteger(windowMs) || windowMs <= 0 || windowMs > 900_000
          || nowMs + windowMs > 253402300799999
          || !Number.isSafeInteger(limit) || limit <= 0 || limit > 1000) throw new TypeError('Invalid test rate limit');
      const record = entries.get(key);
      if (record && (!Number.isInteger(record.value) || record.value < 1 || record.value > 1000)) return false;
      if (!record || record.expiresAtMs <= nowMs) {
        entries.set(key, { value: 1, expiresAtMs: nowMs + windowMs }); return true;
      }
      if (record.value >= limit) return false;
      record.value++; return true;
    },
    async putSession(record) {
      if (sessions.has(record.key)) return false;
      sessions.set(record.key, copy(record)); return true;
    },
    async readAndTouchSession(key, nowMs, idleMs) {
      const record = sessions.get(key);
      if (!record || record.createdAtMs > nowMs || record.lastSeenAtMs > nowMs
          || record.expiresAtMs <= nowMs || record.reauthAtMs <= nowMs
          || record.lastSeenAtMs + idleMs <= nowMs) return null;
      record.lastSeenAtMs = nowMs;
      return copy(record);
    },
    async deleteSession(key) { return sessions.delete(key); },
    async deleteIdentitySessions({ entraTenantId, entraObjectId }) {
      let removed = 0;
      for (const [key, record] of sessions) {
        if (record.entraTenantId.toLowerCase() === entraTenantId.toLowerCase()
            && record.entraObjectId.toLowerCase() === entraObjectId.toLowerCase()) {
          sessions.delete(key); removed++;
        }
      }
      return removed;
    },
    async prune(nowMs) {
      const removed = { entries: 0, sessions: 0 };
      for (const [key, record] of entries) if (record.expiresAtMs <= nowMs) {
        entries.delete(key); removed.entries++;
      }
      for (const [key, record] of sessions) if (Math.min(record.expiresAtMs, record.reauthAtMs) <= nowMs) {
        sessions.delete(key); removed.sessions++;
      }
      return removed;
    },
  });
}
