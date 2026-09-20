/**
 * Broadcasts — create, schedule, start/pause/resume/cancel, retry-failed,
 * audience preview, report, and list.
 *
 * The audience preview and report responses group skips/failures BY REASON
 * with counts (`audiencePreviewSchema.skippedGroups`,
 * `broadcastReportSchema.failureGroups`) — this module returns exactly what
 * `apiRequest` parses off the wire (`AudiencePreview`/`BroadcastReport` as
 * `@packages/contracts` defines them) with no reshaping in between, so the
 * grouped structure is preserved by construction rather than by care taken
 * here. Flattening it into a bare list would need to happen deliberately in
 * a UI layer, not silently here.
 */
import type {
  CancelBroadcastRequest,
  CancelBroadcastResponse,
  CreateBroadcastRequest,
  CreateBroadcastResponse,
  GetBroadcastReportRequest,
  GetBroadcastReportResponse,
  ListBroadcastsQuery,
  ListBroadcastsResponse,
  PauseBroadcastRequest,
  PauseBroadcastResponse,
  PreviewAudienceRequest,
  PreviewAudienceResponse,
  ResumeBroadcastRequest,
  ResumeBroadcastResponse,
  RetryFailedRequest,
  RetryFailedResponse,
  ScheduleBroadcastRequest,
  ScheduleBroadcastResponse,
  StartBroadcastRequest,
  StartBroadcastResponse,
} from "@packages/contracts/src/index";
import {
  cancelBroadcastResponseSchema,
  createBroadcastResponseSchema,
  getBroadcastReportResponseSchema,
  listBroadcastsResponseSchema,
  pauseBroadcastResponseSchema,
  previewAudienceResponseSchema,
  resumeBroadcastResponseSchema,
  retryFailedResponseSchema,
  scheduleBroadcastResponseSchema,
  startBroadcastResponseSchema,
} from "@packages/contracts/src/index";
import { apiRequest, type ApiClientContext, type SuccessOf } from "../http";
import type { ApiClientError } from "../errors";
import type { Result } from "../result";

export interface BroadcastsResource {
  list(query?: ListBroadcastsQuery): Promise<Result<SuccessOf<ListBroadcastsResponse>, ApiClientError>>;
  create(request: CreateBroadcastRequest): Promise<Result<SuccessOf<CreateBroadcastResponse>, ApiClientError>>;
  schedule(
    request: ScheduleBroadcastRequest,
  ): Promise<Result<SuccessOf<ScheduleBroadcastResponse>, ApiClientError>>;
  /** Recipient counts grouped by skip reason (with counts) — see this file's header. */
  previewAudience(
    request: PreviewAudienceRequest,
  ): Promise<Result<SuccessOf<PreviewAudienceResponse>, ApiClientError>>;
  start(request: StartBroadcastRequest): Promise<Result<SuccessOf<StartBroadcastResponse>, ApiClientError>>;
  pause(request: PauseBroadcastRequest): Promise<Result<SuccessOf<PauseBroadcastResponse>, ApiClientError>>;
  resume(request: ResumeBroadcastRequest): Promise<Result<SuccessOf<ResumeBroadcastResponse>, ApiClientError>>;
  cancel(request: CancelBroadcastRequest): Promise<Result<SuccessOf<CancelBroadcastResponse>, ApiClientError>>;
  retryFailed(request: RetryFailedRequest): Promise<Result<SuccessOf<RetryFailedResponse>, ApiClientError>>;
  /** Delivery outcomes grouped by failure code/disposition (with counts) — see this file's header. */
  report(
    request: GetBroadcastReportRequest,
  ): Promise<Result<SuccessOf<GetBroadcastReportResponse>, ApiClientError>>;
}

export function createBroadcastsResource(ctx: ApiClientContext): BroadcastsResource {
  return {
    list: (query) => apiRequest(ctx, { method: "GET", path: "/broadcasts.list", query }, listBroadcastsResponseSchema),

    create: (request) =>
      apiRequest(ctx, { method: "POST", path: "/broadcasts.create", body: request }, createBroadcastResponseSchema),

    schedule: (request) =>
      apiRequest(ctx, { method: "POST", path: "/broadcasts.schedule", body: request }, scheduleBroadcastResponseSchema),

    previewAudience: (request) =>
      apiRequest(
        ctx,
        { method: "POST", path: "/broadcasts.previewAudience", body: request },
        previewAudienceResponseSchema,
      ),

    start: (request) =>
      apiRequest(ctx, { method: "POST", path: "/broadcasts.start", body: request }, startBroadcastResponseSchema),

    pause: (request) =>
      apiRequest(ctx, { method: "POST", path: "/broadcasts.pause", body: request }, pauseBroadcastResponseSchema),

    resume: (request) =>
      apiRequest(ctx, { method: "POST", path: "/broadcasts.resume", body: request }, resumeBroadcastResponseSchema),

    cancel: (request) =>
      apiRequest(ctx, { method: "POST", path: "/broadcasts.cancel", body: request }, cancelBroadcastResponseSchema),

    retryFailed: (request) =>
      apiRequest(ctx, { method: "POST", path: "/broadcasts.retryFailed", body: request }, retryFailedResponseSchema),

    report: (request) =>
      apiRequest(ctx, { method: "GET", path: "/broadcasts.report", query: request }, getBroadcastReportResponseSchema),
  };
}
