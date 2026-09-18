/** Onboarding — the Embedded Signup wizard: state/resume, connect Meta, register phone, configure webhook, sync templates, complete. */
import type {
  CompleteOnboardingRequest,
  CompleteOnboardingResponse,
  ConfigureWebhookRequest,
  ConfigureWebhookResponse,
  ConnectMetaManuallyRequest,
  ConnectMetaManuallyResponse,
  ConnectMetaRequest,
  ConnectMetaResponse,
  GetOnboardingStateRequest,
  GetOnboardingStateResponse,
  RegisterPhoneRequest,
  RegisterPhoneResponse,
  ResumeOnboardingRequest,
  ResumeOnboardingResponse,
  StartEmbeddedSignupRequest,
  StartEmbeddedSignupResponse,
  SyncTemplatesRequest,
  SyncTemplatesResponse,
} from "@packages/contracts/src/index";
import {
  completeOnboardingResponseSchema,
  configureWebhookResponseSchema,
  connectMetaManuallyResponseSchema,
  connectMetaResponseSchema,
  getOnboardingStateResponseSchema,
  registerPhoneResponseSchema,
  resumeOnboardingResponseSchema,
  startEmbeddedSignupResponseSchema,
  syncTemplatesResponseSchema,
} from "@packages/contracts/src/index";
import { apiRequest, type ApiClientContext, type SuccessOf } from "../http";
import type { ApiClientError } from "../errors";
import type { Result } from "../result";

export interface OnboardingResource {
  getState(
    request: GetOnboardingStateRequest,
  ): Promise<Result<SuccessOf<GetOnboardingStateResponse>, ApiClientError>>;
  resume(request: ResumeOnboardingRequest): Promise<Result<SuccessOf<ResumeOnboardingResponse>, ApiClientError>>;
  startEmbeddedSignup(
    request: StartEmbeddedSignupRequest,
  ): Promise<Result<SuccessOf<StartEmbeddedSignupResponse>, ApiClientError>>;
  connectMeta(request: ConnectMetaRequest): Promise<Result<SuccessOf<ConnectMetaResponse>, ApiClientError>>;
  connectMetaManually(
    request: ConnectMetaManuallyRequest,
  ): Promise<Result<SuccessOf<ConnectMetaManuallyResponse>, ApiClientError>>;
  registerPhone(
    request: RegisterPhoneRequest,
  ): Promise<Result<SuccessOf<RegisterPhoneResponse>, ApiClientError>>;
  configureWebhook(
    request: ConfigureWebhookRequest,
  ): Promise<Result<SuccessOf<ConfigureWebhookResponse>, ApiClientError>>;
  syncTemplates(
    request: SyncTemplatesRequest,
  ): Promise<Result<SuccessOf<SyncTemplatesResponse>, ApiClientError>>;
  complete(
    request: CompleteOnboardingRequest,
  ): Promise<Result<SuccessOf<CompleteOnboardingResponse>, ApiClientError>>;
}

export function createOnboardingResource(ctx: ApiClientContext): OnboardingResource {
  return {
    getState: (request) =>
      apiRequest(ctx, { method: "GET", path: "/onboarding.state", query: request }, getOnboardingStateResponseSchema),

    resume: (request) =>
      apiRequest(ctx, { method: "GET", path: "/onboarding.resume", query: request }, resumeOnboardingResponseSchema),

    startEmbeddedSignup: (request) =>
      apiRequest(
        ctx,
        { method: "POST", path: "/onboarding.startEmbeddedSignup", body: request },
        startEmbeddedSignupResponseSchema,
      ),

    connectMeta: (request) =>
      apiRequest(ctx, { method: "POST", path: "/onboarding.connectMeta", body: request }, connectMetaResponseSchema),

    connectMetaManually: (request) =>
      apiRequest(
        ctx,
        { method: "POST", path: "/onboarding.connectMetaManually", body: request },
        connectMetaManuallyResponseSchema,
      ),

    registerPhone: (request) =>
      apiRequest(ctx, { method: "POST", path: "/onboarding.registerPhone", body: request }, registerPhoneResponseSchema),

    configureWebhook: (request) =>
      apiRequest(
        ctx,
        { method: "POST", path: "/onboarding.configureWebhook", body: request },
        configureWebhookResponseSchema,
      ),

    syncTemplates: (request) =>
      apiRequest(ctx, { method: "POST", path: "/onboarding.syncTemplates", body: request }, syncTemplatesResponseSchema),

    complete: (request) =>
      apiRequest(ctx, { method: "POST", path: "/onboarding.complete", body: request }, completeOnboardingResponseSchema),
  };
}
