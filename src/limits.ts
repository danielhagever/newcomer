// Limits that keep one search inside Cloudflare's free plan and the Qloo event quota.
//
// Workers Free allows 50 subrequests per request, and KV calls count (developers.cloudflare.com,
// Workers limits). Every fetch and every KV call in a search takes one unit from a Budget, so a
// search can't fail halfway on the platform limit: optional steps (naming map cells) stop early
// instead.

export class AppError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export class Budget {
  used = 0;
  max: number;
  constructor(max: number) {
    this.max = max;
  }
  left(): number {
    return this.max - this.used;
  }
  take(n = 1): boolean {
    if (this.used + n > this.max) return false;
    this.used += n;
    return true;
  }
}

// 50 is the platform limit; keep a little room.
export const REQUEST_BUDGET = 48;

export async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

// A per-address, per-hour counter in the edge cache. Approximate (per data center), which is enough
// to stop a script from spending the Qloo quota or the Workers AI allowance.
export async function allow(req: Request, what: string, perHour: number, budget?: Budget): Promise<boolean> {
  const cache = (globalThis as any).caches?.default as Cache | undefined;
  if (!cache) return true;
  if (budget && !budget.take(2)) return true;
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  const key = new Request(`https://limits.newcomer/${what}/${ip}/${Math.floor(Date.now() / 3_600_000)}`);
  try {
    const n = Number((await (await cache.match(key))?.text()) ?? 0);
    if (n >= perHour) return false;
    await cache.put(key, new Response(String(n + 1), { headers: { "cache-control": "max-age=3600" } }));
  } catch {
    // The counter is best effort; never block a search because the cache failed.
  }
  return true;
}
