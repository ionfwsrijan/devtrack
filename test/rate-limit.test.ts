import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFixedWindowRateLimiter,
  createSlidingWindowRateLimiter,
  getClientIp,
} from "../src/lib/rate-limit";

describe("rate-limit utility", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("getClientIp", () => {
    it("uses req.ip first", () => {
      const req = {
        ip: "172.16.0.1",
        headers: new Headers({
          "cf-connecting-ip": "203.0.113.9",
          "x-real-ip": "10.0.0.2",
          "x-forwarded-for": "198.51.100.7",
        }),
      };

      expect(getClientIp(req)).toBe("172.16.0.1");
    });

    it("prefers cf-connecting-ip then x-real-ip before x-forwarded-for", () => {
      const req = {
        headers: new Headers({
          "cf-connecting-ip": "203.0.113.9",
          "x-real-ip": "10.0.0.2",
          "x-forwarded-for": "198.51.100.7, 198.51.100.8",
        }),
      };

      expect(getClientIp(req)).toBe("203.0.113.9");
    });

    it("falls back to first x-forwarded-for entry", () => {
      const req = {
        headers: new Headers({
          "x-forwarded-for": "198.51.100.7, 198.51.100.8",
        }),
      };

      expect(getClientIp(req)).toBe("198.51.100.7");
    });

    it("returns unknown when no address exists", () => {
      const req = {
        headers: new Headers(),
      };

      expect(getClientIp(req)).toBe("unknown");
    });
  });

  describe("createSlidingWindowRateLimiter", () => {
    it("enforces the configured request limit", () => {
      const limiter = createSlidingWindowRateLimiter({
        windowMs: 60_000,
        limit: 2,
        maxEntries: 100,
        pruneIntervalMs: 60_000,
      });

      expect(limiter.check("user:1").allowed).toBe(true);
      expect(limiter.check("user:1").allowed).toBe(true);

      const blocked = limiter.check("user:1");
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
    });

    it("evicts stale buckets and respects max entries cap", () => {
      const limiter = createSlidingWindowRateLimiter({
        windowMs: 60_000,
        limit: 1,
        maxEntries: 1,
        pruneIntervalMs: 0,
      });

      expect(limiter.check("a").allowed).toBe(true);
      expect(limiter.check("b").allowed).toBe(true);

      // "a" should have been evicted because the map cap is 1.
      expect(limiter.check("a").allowed).toBe(true);
    });
  });

  describe("createFixedWindowRateLimiter", () => {
    it("enforces fixed-window requests and emits retryAfter", () => {
      const limiter = createFixedWindowRateLimiter({
        windowMs: 60_000,
        limit: 2,
        maxEntries: 100,
        pruneIntervalMs: 60_000,
      });

      expect(limiter.check("ip:1").allowed).toBe(true);
      expect(limiter.check("ip:1").allowed).toBe(true);

      const blocked = limiter.check("ip:1");
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfter).toBeGreaterThan(0);
    });

    it("evicts by max entry cap", () => {
      const limiter = createFixedWindowRateLimiter({
        windowMs: 60_000,
        limit: 1,
        maxEntries: 1,
        pruneIntervalMs: 0,
      });

      expect(limiter.check("k1").allowed).toBe(true);
      expect(limiter.check("k2").allowed).toBe(true);

      // k1 should be evicted after k2 due to cap.
      expect(limiter.check("k1").allowed).toBe(true);
    });
  });
});
