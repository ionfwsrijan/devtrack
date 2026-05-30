import { NextRequest, NextResponse } from "next/server";
import { fetchPublicProfile } from "@/lib/public-profile-data";
import { getUpstashConfig, upstashRateLimitFixedWindow } from "@/lib/upstash-rest";
import { createFixedWindowRateLimiter, getClientIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const RATE_LIMIT_REQUESTS = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute

const localPublicProfileRateLimiter = createFixedWindowRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  limit: RATE_LIMIT_REQUESTS,
  maxEntries: 10_000,
  pruneIntervalMs: RATE_LIMIT_WINDOW_MS,
});

export async function GET(
  req: NextRequest,
  { params }: { params: { username: string } }
): Promise<NextResponse> {
  const { username } = params;
  // Rate limiting
  const ip = getClientIp(req);
  const rateLimit = getUpstashConfig()
    ? await upstashRateLimitFixedWindow({
        key: `public-profile-rate-limit:${ip}`,
        limit: RATE_LIMIT_REQUESTS,
        windowSeconds: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000),
      })
    : localPublicProfileRateLimiter.check(ip);

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      {
        status: 429,
        headers: {
          "Retry-After": String(rateLimit.retryAfter),
        },
      }
    );
  }

  const profile = await fetchPublicProfile(username);

  if (!profile) {
    return NextResponse.json(
      { error: "User not found or profile is not public" },
      { status: 404 }
    );
  }

  return NextResponse.json(profile);
}
