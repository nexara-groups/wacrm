/**
 * SignupService — self-serve tenant creation. The only place, anywhere in
 * this codebase, where a brand-new `accounts` row comes into being outside
 * a human running `wrangler d1 execute` by hand (see `docs/cloudflare-deploy.md`).
 *
 * WHY NOT `JwtAuthProvider.register`: that method creates a credential in
 * the container's configured `AUTH_TENANT_ID` — the fixed tenant password
 * resets and verification flows create NEW credentials in, because those
 * flows have no tenant of their own to read. Signup is the opposite case:
 * it must create its OWN tenant, never touch the default one, so it goes
 * through `SignupRepository.createTenant` instead — one atomic `batch()`
 * that inserts `accounts`, `users`, `credentials` and `memberships` together.
 *
 * WHY THIS SERVICE OWNS ID GENERATION: the tenant id is never taken from the
 * request (a client-supplied id would let someone join or overwrite an
 * existing tenant) — `crypto.randomUUID()` here, nowhere else.
 *
 * EMAIL VERIFICATION IS THE CALLER'S DECISION, NOT THIS SERVICE'S: this
 * module has no idea whether an email can actually be sent (that is an
 * apps/web-level capability — see `apps/web/lib/email-provider.ts`'s
 * `isRealEmailProviderConfigured`). `signup()`'s second parameter,
 * `autoVerifyEmail`, defaults to `true` (the original behavior: the owner
 * is marked verified at creation time, since otherwise
 * `JwtAuthProvider.login` would refuse every new owner forever on a
 * deployment that cannot yet complete a verification). A caller that CAN
 * send mail passes `autoVerifyEmail: false` and is then responsible for
 * actually issuing and emailing a verification token afterwards.
 *

 * WHY THIS SERVICE NEVER TOUCHES SQL: `scripts/check-architecture.mjs`
 * rule 2 forbids it outright — everything persistence-shaped goes through
 * `SignupRepository` (application/ports.ts).
 */
import { checkPassword } from "@modules/identity/domain/password-policy";
import { hashPassword } from "@modules/identity/domain/token-hashing";
import { WORKERS_FREE_TIER_ITERATIONS } from "@nexara/core/auth/providers/jwt-auth-provider";
import type { SignupRepository } from "./ports";

export interface SignupInput {
  readonly email: string;
  readonly password: string;
  readonly accountName: string;
  /** Optional — `users.display_name` is nullable, so omitting this is not a degraded signup. */
  readonly ownerName?: string | null;
}

export type SignupOutcome =
  | {
      readonly ok: true;
      readonly accountId: string;
      readonly ownerUserId: string;
      readonly email: string;
    }
  | {
      readonly ok: false;
      readonly reason: "weak_password";
      /** Friendly, customer-facing copy straight from `checkPassword` — never re-worded here. */
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly reason: "email_taken";
      readonly message: string;
    };

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface SignupOptions {
  /** See this file's header. Defaults to `true` — every existing caller
   * that never set this keeps the original auto-verify behavior. */
  readonly autoVerifyEmail?: boolean;
}

export class SignupService {
  constructor(private readonly repository: SignupRepository) {}

  async signup(input: SignupInput, options: SignupOptions = {}): Promise<SignupOutcome> {
    // Checked BEFORE anything is generated or persisted — a public endpoint
    // gets no partial credit for a request that fails validation, and this
    // is cheaper than any DB round trip.
    const passwordCheck = checkPassword(input.password);
    if (!passwordCheck.ok) {
      return { ok: false, reason: "weak_password", message: passwordCheck.laymanMessage };
    }

    const email = normalizedEmail(input.email);
    const accountName = input.accountName.trim();
    const ownerName = input.ownerName?.trim();

    // Hashed here, in the service — never in the route, never in the
    // repository — so the repository (and every test double for it) only
    // ever sees an already-hashed value and can never accidentally persist
    // a raw password. `WORKERS_FREE_TIER_ITERATIONS`, never bcrypt: see
    // `password-policy.ts`'s header for the CPU-budget math.
    const passwordHash = await hashPassword(input.password, WORKERS_FREE_TIER_ITERATIONS);

    // Generated here, never accepted from the request: the tenant id IS the
    // new `accounts.id`, and a client-supplied value would let a signup
    // attempt target (join or overwrite) an existing tenant.
    const accountId = crypto.randomUUID();
    const ownerUserId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();

    const result = await this.repository.createTenant({
      accountId,
      accountName,
      ownerUserId,
      ownerName: ownerName && ownerName.length > 0 ? ownerName : null,
      membershipId,
      email,
      passwordHash,
      now: new Date(),
      autoVerifyEmail: options.autoVerifyEmail ?? true,
    });

    if (result.kind === "email_taken") {
      return {
        ok: false,
        reason: "email_taken",
        message: "An account with that email address already exists. Try logging in instead.",
      };
    }

    return { ok: true, accountId, ownerUserId, email };
  }
}
