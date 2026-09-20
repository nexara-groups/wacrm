/** Templates — list, create, update, delete, approval status. */
import type {
  CreateTemplateRequest,
  CreateTemplateResponse,
  DeleteTemplateRequest,
  DeleteTemplateResponse,
  GetTemplateApprovalStatusRequest,
  GetTemplateApprovalStatusResponse,
  ListTemplatesQuery,
  ListTemplatesResponse,
  UpdateTemplateRequest,
  UpdateTemplateResponse,
} from "@packages/contracts/src/index";
import {
  createTemplateResponseSchema,
  deleteTemplateResponseSchema,
  getTemplateApprovalStatusResponseSchema,
  listTemplatesResponseSchema,
  updateTemplateResponseSchema,
} from "@packages/contracts/src/index";
import { apiRequest, type ApiClientContext, type SuccessOf } from "../http";
import type { ApiClientError } from "../errors";
import type { Result } from "../result";

export interface TemplatesResource {
  list(query?: ListTemplatesQuery): Promise<Result<SuccessOf<ListTemplatesResponse>, ApiClientError>>;
  create(request: CreateTemplateRequest): Promise<Result<SuccessOf<CreateTemplateResponse>, ApiClientError>>;
  update(request: UpdateTemplateRequest): Promise<Result<SuccessOf<UpdateTemplateResponse>, ApiClientError>>;
  delete(request: DeleteTemplateRequest): Promise<Result<SuccessOf<DeleteTemplateResponse>, ApiClientError>>;
  getApprovalStatus(
    request: GetTemplateApprovalStatusRequest,
  ): Promise<Result<SuccessOf<GetTemplateApprovalStatusResponse>, ApiClientError>>;
}

export function createTemplatesResource(ctx: ApiClientContext): TemplatesResource {
  return {
    list: (query) => apiRequest(ctx, { method: "GET", path: "/templates.list", query }, listTemplatesResponseSchema),

    create: (request) =>
      apiRequest(ctx, { method: "POST", path: "/templates.create", body: request }, createTemplateResponseSchema),

    update: (request) =>
      apiRequest(ctx, { method: "POST", path: "/templates.update", body: request }, updateTemplateResponseSchema),

    delete: (request) =>
      apiRequest(ctx, { method: "POST", path: "/templates.delete", body: request }, deleteTemplateResponseSchema),

    getApprovalStatus: (request) =>
      apiRequest(
        ctx,
        { method: "GET", path: "/templates.approvalStatus", query: request },
        getTemplateApprovalStatusResponseSchema,
      ),
  };
}
