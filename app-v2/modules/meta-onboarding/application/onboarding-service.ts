/**
 * OnboardingService — drives the Embedded Signup wizard.
 *
 * Orchestrates `domain/onboarding-state-machine.ts` against the
 * `application/ports.ts` repositories and the `MetaBusinessProvider` port.
 * Contains NO SQL and NO vendor `fetch` — both are the responsibility of
 * `infrastructure/*`, injected here only as interfaces.
 *
 * Every public method is resumable by construction: it always starts by
 * loading the persisted session and re-deriving what is legal from ITS
 * state, never from client-supplied assumptions about "where the wizard
 * currently is" — so a request that arrives after the tab was closed and
 * reopened behaves identically to one that arrives in the middle of an
 * unbroken flow.
 */
import { err, ok, type Result } from "@shared/result";
import type { TenantContext } from "@nexara/core/context";
import {
  isResumable,
  isTerminal,
  resumeStep,
  systemClock,
  transition,
  type Clock,
  type OnboardingEventType,
  type ResumeStep,
  type TransitionResult,
} from "../domain/onboarding-state-machine";
import { describeOnboardingFailure, type OnboardingFailureReason, type OnboardingGuidance } from "../domain/onboarding-errors";
import { generateResumeToken as defaultGenerateResumeToken } from "../domain/resume-token";
import type { MetaBusinessProvider } from "../domain/meta-business-provider.interface";
import type { MetaOnboardingPorts, OnboardingSessionRecord } from "./ports";

export interface OnboardingServiceDeps {
  readonly provider: MetaBusinessProvider;
  readonly ports: MetaOnboardingPorts;
  /** Injectable clock for deterministic tests; defaults to `() => new Date()`. */
  readonly clock?: Clock;
  /** Injectable id generator for deterministic tests; defaults to `crypto.randomUUID()`. */
  readonly generateId?: () => string;
  /** Injectable resume-token generator for deterministic tests. */
  readonly generateResumeToken?: () => string;
}

export interface ConnectMetaInput {
  /** The Embedded Signup authorization code, exchanged server-side for a token. */
  readonly code: string;
  readonly redirectUri: string;
  /** WABA id + phone_number_id, handed back client-side by the Facebook Login
   *  for Business popup's `WA_EMBEDDED_SIGNUP` message — separate from `code`. */
  readonly wabaId: string;
  readonly phoneNumberId: string;
}

export interface RegisterPhoneInput {
  /** 6-digit 2-step-verification PIN, set by the user in Meta WhatsApp Manager. */
  readonly pin: string;
}

export class OnboardingService {
  private readonly provider: MetaBusinessProvider;
  private readonly ports: MetaOnboardingPorts;
  private readonly clock: Clock;
  private readonly generateId: () => string;
  private readonly generateResumeToken: () => string;

  constructor(deps: OnboardingServiceDeps) {
    this.provider = deps.provider;
    this.ports = deps.ports;
    this.clock = deps.clock ?? systemClock;
    this.generateId = deps.generateId ?? (() => crypto.randomUUID());
    this.generateResumeToken = deps.generateResumeToken ?? defaultGenerateResumeToken;
  }

  /**
   * Entry point for "start onboarding" AND "I'm back" — the same call. If
   * the account has a resumable (non-terminal) session, that session is
   * returned unchanged; otherwise a fresh one is created in `created`. This
   * is what makes "closed the tab mid-Facebook-popup" safe to just retry:
   * the caller never has to know in advance whether this is a first visit.
   */
  async startOrResume(tenant: TenantContext): Promise<{ session: OnboardingSessionRecord; nextStep: ResumeStep }> {
    const existing = await this.ports.sessions.findCurrentForAccount(tenant);
    if (existing && isResumable(existing.state)) {
      return { session: existing, nextStep: resumeStep(existing.state) };
    }

    const now = this.clock();
    const created = await this.ports.sessions.create(tenant, {
      id: this.generateId(),
      state: "created",
      startedAt: now.toISOString(),
      resumeToken: this.generateResumeToken(),
    });
    await this.ports.events.append(tenant, {
      id: this.generateId(),
      sessionId: created.id,
      eventType: "SESSION_STARTED",
      fromState: null,
      toState: created.state,
      detail: null,
      occurredAt: now.toISOString(),
    });
    return { session: created, nextStep: resumeStep(created.state) };
  }

  /** Look up a session by its `/onboarding/complete`-style resume link. */
  async getResumeState(
    tenant: TenantContext,
    resumeToken: string,
  ): Promise<Result<{ session: OnboardingSessionRecord; nextStep: ResumeStep }, OnboardingGuidance>> {
    const session = await this.ports.sessions.findByResumeToken(tenant, resumeToken);
    if (!session) return err(describeOnboardingFailure({ kind: "invalid_resume_token" }));
    return ok({ session, nextStep: resumeStep(session.state) });
  }

  /** Step 1 + 2: exchange the Embedded Signup code, read WABA/phone details, store identifiers. */
  async connectMeta(
    tenant: TenantContext,
    sessionId: string,
    input: ConnectMetaInput,
  ): Promise<Result<OnboardingSessionRecord, OnboardingGuidance>> {
    const session = await this.ports.sessions.findById(tenant, sessionId);
    if (!session) return err(describeOnboardingFailure({ kind: "session_not_found" }));

    const advanced = await this.advance(tenant, session, "CONNECT_META", async () => {
      const exchanged = await this.provider.exchangeCodeForToken({ code: input.code, redirectUri: input.redirectUri });
      if (!exchanged.ok) return err({ kind: "meta_provider_error", error: exchanged.error } as const);

      const [waba, phone] = await Promise.all([
        this.provider.getWabaDetails(input.wabaId, exchanged.value.accessToken),
        this.provider.getPhoneNumberDetails(input.phoneNumberId, exchanged.value.accessToken),
      ]);
      if (!waba.ok) return err({ kind: "meta_provider_error", error: waba.error } as const);
      if (!phone.ok) return err({ kind: "meta_provider_error", error: phone.error } as const);

      // The raw token is resolved to a reference RIGHT HERE, inside the
      // service, and only that reference is ever handed onward — the
      // repository (and every test double for it) must never see
      // `exchanged.value.accessToken` itself. See SecretStorePort's
      // docstring in application/ports.ts.
      const accessTokenRef = await this.ports.secrets.putSecret(tenant, "meta_access_token", exchanged.value.accessToken);

      await this.ports.connections.upsert(tenant, {
        wabaId: waba.value.wabaId,
        businessId: waba.value.businessId,
        phoneNumberId: phone.value.phoneNumberId,
        accessTokenRef,
        updatedAt: this.clock().toISOString(),
      });
      return ok(undefined);
    });

    if (!advanced.ok) return advanced;
    return ok(advanced.value.session);
  }

  /** Step 3: register the phone number with its 2-step-verification PIN. */
  async registerPhone(
    tenant: TenantContext,
    sessionId: string,
    input: RegisterPhoneInput,
  ): Promise<Result<OnboardingSessionRecord, OnboardingGuidance>> {
    const session = await this.ports.sessions.findById(tenant, sessionId);
    if (!session) return err(describeOnboardingFailure({ kind: "session_not_found" }));

    if (!input.pin || input.pin.trim().length === 0) {
      return err(describeOnboardingFailure({ kind: "missing_verification_pin" }));
    }

    const advanced = await this.advance(tenant, session, "REGISTER_PHONE", async () => {
      const connection = await this.ports.connections.findByAccount(tenant);
      if (!connection) return err({ kind: "connection_not_found" } as const);

      const accessToken = await this.ports.secrets.resolveSecret(tenant, connection.accessTokenRef);
      const registered = await this.provider.registerPhoneNumber({
        phoneNumberId: connection.phoneNumberId,
        accessToken,
        pin: input.pin,
      });
      if (!registered.ok) return err({ kind: "meta_provider_error", error: registered.error } as const);
      return ok(registered.value);
    });

    if (!advanced.ok) return advanced;
    return ok(advanced.value.session);
  }

  /** Step 4: subscribe this app to the WABA (webhook configuration). */
  async verifyWebhook(tenant: TenantContext, sessionId: string): Promise<Result<OnboardingSessionRecord, OnboardingGuidance>> {
    const session = await this.ports.sessions.findById(tenant, sessionId);
    if (!session) return err(describeOnboardingFailure({ kind: "session_not_found" }));

    const advanced = await this.advance(tenant, session, "VERIFY_WEBHOOK", async () => {
      const connection = await this.ports.connections.findByAccount(tenant);
      if (!connection) return err({ kind: "connection_not_found" } as const);

      const accessToken = await this.ports.secrets.resolveSecret(tenant, connection.accessTokenRef);
      const subscribed = await this.provider.subscribeAppToWaba({ wabaId: connection.wabaId, accessToken });
      if (!subscribed.ok) return err({ kind: "meta_provider_error", error: subscribed.error } as const);
      return ok(undefined);
    });

    if (!advanced.ok) return advanced;
    return ok(advanced.value.session);
  }

  /**
   * Step 5: mark templates ready. Actually listing/submitting templates is
   * `WhatsAppProvider`'s concern (a different Meta API surface — see the
   * provider-separation docstring in
   * `domain/meta-business-provider.interface.ts`); this module only gates
   * the wizard on the caller-supplied count, per META_ONBOARDING_FLOW.md
   * step 5 "submit >=1 approved template".
   */
  async markTemplatesReady(
    tenant: TenantContext,
    sessionId: string,
    approvedTemplateCount: number,
  ): Promise<Result<OnboardingSessionRecord, OnboardingGuidance>> {
    const session = await this.ports.sessions.findById(tenant, sessionId);
    if (!session) return err(describeOnboardingFailure({ kind: "session_not_found" }));

    const advanced = await this.advance(tenant, session, "SYNC_TEMPLATES", async () => {
      if (approvedTemplateCount < 1) return err({ kind: "no_approved_template" } as const);
      return ok(undefined);
    });

    if (!advanced.ok) return advanced;
    return ok(advanced.value.session);
  }

  /** Step 6 + 7: health check (token/phone/quality) then flip to `complete`. */
  async complete(tenant: TenantContext, sessionId: string): Promise<Result<OnboardingSessionRecord, OnboardingGuidance>> {
    const session = await this.ports.sessions.findById(tenant, sessionId);
    if (!session) return err(describeOnboardingFailure({ kind: "session_not_found" }));

    const advanced = await this.advance(tenant, session, "COMPLETE", async () => {
      const connection = await this.ports.connections.findByAccount(tenant);
      if (!connection) return err({ kind: "connection_not_found" } as const);

      const accessToken = await this.ports.secrets.resolveSecret(tenant, connection.accessTokenRef);
      const status = await this.provider.getVerificationStatus(connection.phoneNumberId, accessToken);
      if (!status.ok) return err({ kind: "meta_provider_error", error: status.error } as const);
      return ok(status.value);
    });

    if (!advanced.ok) return advanced;
    return ok(advanced.value.session);
  }

  // ---------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------

  /**
   * Shared step-runner: rejects a call on a terminal session, pre-checks the
   * transition is legal for `session.state` BEFORE `perform()` runs (so an
   * out-of-order call never reaches Meta at all), runs `perform`, and on
   * success persists the transition + audit event; on failure records the
   * `RECORD_FAILURE` self-loop (module docstring's resume-rule consequence
   * 1) and returns the plain-English guidance.
   */
  private async advance<T>(
    tenant: TenantContext,
    session: OnboardingSessionRecord,
    event: Exclude<OnboardingEventType, "RECORD_FAILURE">,
    perform: () => Promise<Result<T, OnboardingFailureReason>>,
  ): Promise<Result<{ session: OnboardingSessionRecord; value: T }, OnboardingGuidance>> {
    if (isTerminal(session.state)) {
      return err(describeOnboardingFailure({ kind: "already_complete" }));
    }

    const attempted = transition(session.state, { type: event });
    if (!attempted.ok) {
      return err(describeOnboardingFailure({ kind: "illegal_transition", from: session.state, event }));
    }

    const outcome = await perform();
    if (!outcome.ok) {
      const guidance = await this.recordFailure(tenant, session, outcome.error);
      return err(guidance);
    }

    const updatedSession = await this.persistTransition(tenant, session, attempted.value);
    return ok({ session: updatedSession, value: outcome.value });
  }

  private async persistTransition(
    tenant: TenantContext,
    session: OnboardingSessionRecord,
    result: TransitionResult,
  ): Promise<OnboardingSessionRecord> {
    const occurredAtIso = result.occurredAt.toISOString();
    const updated = await this.ports.sessions.updateState(tenant, session.id, {
      state: result.state,
      updatedAt: occurredAtIso,
      completedAt: result.state === "complete" ? occurredAtIso : session.completedAt,
      lastError: null,
    });
    await this.ports.events.append(tenant, {
      id: this.generateId(),
      sessionId: session.id,
      eventType: result.event,
      fromState: result.previousState,
      toState: result.state,
      detail: null,
      occurredAt: occurredAtIso,
    });
    return updated;
  }

  private async recordFailure(
    tenant: TenantContext,
    session: OnboardingSessionRecord,
    reason: OnboardingFailureReason,
  ): Promise<OnboardingGuidance> {
    const guidance = describeOnboardingFailure(reason);
    const now = this.clock();
    const looped = transition(session.state, { type: "RECORD_FAILURE", reason: guidance.operatorHint });
    if (looped.ok) {
      await this.ports.sessions.updateState(tenant, session.id, {
        state: looped.value.state,
        updatedAt: now.toISOString(),
        completedAt: session.completedAt,
        lastError: guidance.operatorHint,
      });
      await this.ports.events.append(tenant, {
        id: this.generateId(),
        sessionId: session.id,
        eventType: "RECORD_FAILURE",
        fromState: session.state,
        toState: session.state,
        detail: guidance.operatorHint,
        occurredAt: now.toISOString(),
      });
    }
    return guidance;
  }
}
