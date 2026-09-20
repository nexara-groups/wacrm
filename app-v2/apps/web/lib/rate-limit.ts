/**
 * Rate limiting for the two endpoints anyone on the internet can reach
 * without a session: login and signup.
 *
 * WHY THESE TWO SPECIFICALLY.
 *
 * `POST /api/auth/login` runs a PBKDF2 hash on every attempt — ~6ms of CPU
 * against Workers' 10ms free-tier budget. That cost is deliberate (it is what
 * makes a stolen password table expensive to crack) and it is paid by US, on
 * every guess, including an attacker's. Iterations are already reduced below
 * the OWASP floor to fit that budget, which makes throttling the compensating
 * control rather than a nicety.
 *
 * `POST /api/auth/signup` writes FOUR rows per call. The free tier meters
 * 100,000 row writes a day, so ~25,000 unthrottled calls exhaust a day's
 * quota — for the whole product, every tenant. That is not spam, it is a
 * denial-of-service with a curl loop.
 *
 * WHAT THIS IS AND IS NOT. Cloudflare's rate-limiting binding counts
 * per-colocation, not globally, and its window is fixed at 10 or 60 seconds.
 * So it is a flood brake, not a lockout: a distributed attacker with hosts in
 * many regions gets a higher effective ceiling than the number configured,
 * and a patient one pacing below the limit is not stopped at all. It closes
 * off the cheap attack — one machine, a loop — which is the one that actually
 * shows up.
 *
 * KEYED BY IP, NOT BY EMAIL. Keying login on the submitted email would let
 * anyone lock a specific user out of their own account by spending that
 * account's quota, which turns a defence into a weapon. IP is the attacker's
 * own resource, so consuming it costs them.
 *
 * FAILS OPEN when the binding is absent — in local dev, and on any plan where
 * it is unavailable. Deliberate: this is defence in depth, and an absent
 * limiter must not take login down for everyone. Failing open removes
 * throttling; it never grants access. `docs/cloudflare-deploy.md` records
 * that the binding has to be configured for the protection to exist at all,
 * because silent absence is the failure mode to worry about here.
 */

/** Cloudflare's rate-limiting binding, as exposed to a Worker. */
interface RateLimiterBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface RateLimitOutcome {
  /** `false` when the caller has exceeded the configured limit. */
  readonly allowed: boolean;
  /** `false` when no limiter was available and the request passed unchecked. */
  readonly enforced: boolean;
}

const ALLOWED_UNENFORCED: RateLimitOutcome = { allowed: true, enforced: false };

/**
 * The client's address as Cloudflare sees it.
 *
 * `CF-Connecting-IP` is set by Cloudflare's own edge and cannot be spoofed by
 * the client on a request that actually arrived through Cloudflare.
 * `X-Forwarded-For` deliberately is NOT trusted as a fallback: a client can
 * send whatever it likes in that header, so honouring it would let an
 * attacker mint a fresh quota per request by varying it — worse than no
 * limiter, because it would look like one was working.
 */
export function clientAddress(request: Request): string | null {
  const cf = request.headers.get("cf-connecting-ip");
  return cf !== null && cf.length > 0 ? cf : null;
}

/**
 * Consume one unit of `limiterName`'s budget for this client.
 *
 * `bucket` separates the endpoints so a burst of signups cannot lock out
 * logins: the two share a Cloudflare binding but not a counter.
 */
/**
 * The decision, given a limiter. Separated from binding discovery so it can
 * be tested — a security control whose logic only runs inside workerd is a
 * security control nobody has checked.
 */
export async function applyRateLimit(
  request: Request,
  bucket: string,
  limiter: RateLimiterBinding | undefined,
): Promise<RateLimitOutcome> {
  const address = clientAddress(request);
  // No address means this did not arrive through Cloudflare's edge — local
  // dev, or a direct origin hit. Nothing to key on, so nothing to enforce.
  if (address === null) return ALLOWED_UNENFORCED;
  if (!limiter || typeof limiter.limit !== "function") return ALLOWED_UNENFORCED;

  try {
    const { success } = await limiter.limit({ key: `${bucket}:${address}` });
    return { allowed: success, enforced: true };
  } catch {
    // A limiter that throws must not become an outage on the login path.
    return ALLOWED_UNENFORCED;
  }
}

/** Resolve the binding from the Workers environment, or `undefined` off-Workers. */
async function resolveLimiter(): Promise<RateLimiterBinding | undefined> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const { env } = await getCloudflareContext({ async: true });
    return (env as Record<string, unknown>).AUTH_RATE_LIMITER as RateLimiterBinding | undefined;
  } catch {
    // Not running on Workers at all (dev server, tests).
    return undefined;
  }
}

/**
 * Consume one unit of the auth limiter's budget for this client.
 *
 * `bucket` separates the endpoints so a burst of signups cannot lock out
 * logins: the two share a Cloudflare binding but not a counter.
 */
export async function checkRateLimit(
  request: Request,
  bucket: string,
): Promise<RateLimitOutcome> {
  return applyRateLimit(request, bucket, await resolveLimiter());
}
