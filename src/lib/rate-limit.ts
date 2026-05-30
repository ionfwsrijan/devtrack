type RequestLike = {
  ip?: string | null;
  headers?: {
    get: (name: string) => string | null;
  };
};

type SlidingWindowBucket = Map<string, number[]>;
type FixedWindowBucket = Map<string, { count: number; resetAt: number; touchedAt: number }>;

export type SlidingWindowLimitResult = {
  allowed: boolean;
  remaining: number;
  reset: number;
};

export type FixedWindowLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfter?: number;
  reset: number;
};

type CommonOptions = {
  maxEntries?: number;
  pruneIntervalMs?: number;
};

type SlidingWindowOptions = CommonOptions & {
  windowMs: number;
  limit: number;
};

type FixedWindowOptions = CommonOptions & {
  windowMs: number;
  limit: number;
};

const DEFAULT_PRUNE_INTERVAL_MS = 2 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;

function parseFirstForwardedIp(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(",")[0]?.trim();
  return first || null;
}

function headerValue(req: RequestLike, headerName: string): string | null {
  return req.headers?.get(headerName) ?? null;
}

export function getClientIp(req: RequestLike): string {
  if (req.ip?.trim()) return req.ip.trim();

  const cfConnectingIp = headerValue(req, "cf-connecting-ip");
  if (cfConnectingIp?.trim()) return cfConnectingIp.trim();

  const realIp = headerValue(req, "x-real-ip");
  if (realIp?.trim()) return realIp.trim();

  const forwarded = parseFirstForwardedIp(headerValue(req, "x-forwarded-for"));
  if (forwarded) return forwarded;

  return "unknown";
}

function capMapSizeByOldest(
  map: SlidingWindowBucket,
  maxEntries: number
) {
  if (map.size <= maxEntries) return;

  const overflow = map.size - maxEntries;
  const keysToRemove = Array.from(map.entries())
    .map(([key, timestamps]) => ({
      key,
      oldest: timestamps[0] ?? 0,
    }))
    .sort((a, b) => a.oldest - b.oldest)
    .slice(0, overflow);

  for (const entry of keysToRemove) {
    map.delete(entry.key);
  }
}

function capFixedMapSizeByOldest(
  map: FixedWindowBucket,
  maxEntries: number
) {
  if (map.size <= maxEntries) return;

  const overflow = map.size - maxEntries;
  const keysToRemove = Array.from(map.entries())
    .map(([key, state]) => ({ key, touchedAt: state.touchedAt }))
    .sort((a, b) => a.touchedAt - b.touchedAt)
    .slice(0, overflow);

  for (const entry of keysToRemove) {
    map.delete(entry.key);
  }
}

export function createSlidingWindowRateLimiter(options: SlidingWindowOptions) {
  const { windowMs, limit } = options;
  const pruneIntervalMs = options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const buckets: SlidingWindowBucket = new Map();
  let lastPrunedAt = 0;

  function prune(now: number) {
    if (now - lastPrunedAt < pruneIntervalMs && buckets.size < maxEntries) {
      return;
    }

    const cutoff = now - windowMs;
    for (const [key, timestamps] of buckets.entries()) {
      const active = timestamps.filter((timestamp) => timestamp > cutoff);
      if (active.length === 0) {
        buckets.delete(key);
      } else {
        buckets.set(key, active);
      }
    }

    capMapSizeByOldest(buckets, maxEntries);
    lastPrunedAt = now;
  }

  function check(identifier: string): SlidingWindowLimitResult {
    const now = Date.now();
    prune(now);

    const key = identifier;
    const cutoff = now - windowMs;
    const active = (buckets.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    const reset = Math.ceil(((active[0] ?? now) + windowMs) / 1000);

    if (active.length >= limit) {
      buckets.set(key, active);
      return {
        allowed: false,
        remaining: 0,
        reset,
      };
    }

    active.push(now);
    buckets.set(key, active);
    capMapSizeByOldest(buckets, maxEntries);

    return {
      allowed: true,
      remaining: Math.max(limit - active.length, 0),
      reset,
    };
  }

  return {
    check,
  };
}

export function createFixedWindowRateLimiter(options: FixedWindowOptions) {
  const { windowMs, limit } = options;
  const pruneIntervalMs = options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const buckets: FixedWindowBucket = new Map();
  let lastPrunedAt = 0;

  function prune(now: number) {
    if (now - lastPrunedAt < pruneIntervalMs && buckets.size < maxEntries) {
      return;
    }

    for (const [key, state] of buckets.entries()) {
      if (state.resetAt <= now) {
        buckets.delete(key);
      }
    }

    capFixedMapSizeByOldest(buckets, maxEntries);
    lastPrunedAt = now;
  }

  function check(identifier: string): FixedWindowLimitResult {
    const now = Date.now();
    prune(now);

    const existing = buckets.get(identifier);

    if (!existing || existing.resetAt <= now) {
      const resetAt = now + windowMs;
      buckets.set(identifier, { count: 1, resetAt, touchedAt: now });
      return {
        allowed: true,
        remaining: Math.max(limit - 1, 0),
        reset: Math.ceil(resetAt / 1000),
      };
    }

    if (existing.count < limit) {
      existing.count += 1;
      existing.touchedAt = now;
      return {
        allowed: true,
        remaining: Math.max(limit - existing.count, 0),
        reset: Math.ceil(existing.resetAt / 1000),
      };
    }

    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.max(Math.ceil((existing.resetAt - now) / 1000), 1),
      reset: Math.ceil(existing.resetAt / 1000),
    };
  }

  return {
    check,
  };
}
