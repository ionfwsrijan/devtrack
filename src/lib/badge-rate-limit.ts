import { NextRequest } from "next/server";
import { createSlidingWindowRateLimiter, getClientIp } from "@/lib/rate-limit";

const WINDOW_MS = 60 * 1000;
const BADGE_LIMIT = 20;

const badgeRateLimiter = createSlidingWindowRateLimiter({
  windowMs: WINDOW_MS,
  limit: BADGE_LIMIT,
  maxEntries: 10_000,
  pruneIntervalMs: WINDOW_MS,
});

export type BadgeRateLimitResult = {
  allowed: boolean;
  remaining: number;
  reset: number;
};

export function checkBadgeRateLimit(ip: string): BadgeRateLimitResult {
  const result = badgeRateLimiter.check(`badge:${ip}`);
  return {
    allowed: result.allowed,
    remaining: result.remaining,
    reset: result.reset,
  };
}

export function getBadgeClientIp(req: NextRequest): string {
  return getClientIp(req);
}
