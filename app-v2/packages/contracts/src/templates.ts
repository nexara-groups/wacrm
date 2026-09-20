/**
 * Templates — list, create, update, delete, approval status.
 *
 * `variableCount` (domain: "Number of {{n}} placeholders in bodyText — used
 * to validate send-time parameter counts, 132000") is server-derived from
 * `bodyText`, never client-supplied — see `createTemplateRequestSchema`.
 */
import { z } from "zod";
import { accountIdSchema, isoDateTimeSchema, templateIdSchema } from "./common/ids";
import { apiResult } from "./common/response";
import { paginatedResponseSchema, paginationQuerySchema } from "./common/pagination";
import { templateApprovalStatusSchema, templateCategorySchema } from "./common/vocab";

// ---------------------------------------------------------------------------
// The Template resource
// ---------------------------------------------------------------------------

export const templateSchema = z.object({
  id: templateIdSchema,
  accountId: accountIdSchema,
  name: z.string().min(1).max(512),
  /** BCP-47 / Meta locale code, e.g. "en_US", "hi". */
  language: z.string().min(2).max(10),
  category: templateCategorySchema,
  status: templateApprovalStatusSchema,
  bodyText: z.string().min(1).max(1024),
  variableCount: z.number().int().min(0),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Template = z.infer<typeof templateSchema>;

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export const listTemplatesQuerySchema = paginationQuerySchema.extend({
  category: templateCategorySchema.optional(),
  status: templateApprovalStatusSchema.optional(),
  search: z.string().min(1).max(200).optional(),
});
export type ListTemplatesQuery = z.infer<typeof listTemplatesQuerySchema>;

export const listTemplatesResponseSchema = apiResult(paginatedResponseSchema(templateSchema).shape);
export type ListTemplatesResponse = z.infer<typeof listTemplatesResponseSchema>;

// ---------------------------------------------------------------------------
// Create — Meta's template name convention is lowercase snake_case; the
// request enforces that up front rather than letting it reach Meta and come
// back as an opaque submission failure.
// ---------------------------------------------------------------------------

export const createTemplateRequestSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[a-z0-9_]+$/, "Template name must be lowercase letters, digits and underscores only"),
  language: z.string().min(2).max(10),
  category: templateCategorySchema,
  bodyText: z.string().min(1).max(1024),
});
export type CreateTemplateRequest = z.infer<typeof createTemplateRequestSchema>;

export const createTemplateResponseSchema = apiResult({ template: templateSchema });
export type CreateTemplateResponse = z.infer<typeof createTemplateResponseSchema>;

// ---------------------------------------------------------------------------
// Update — editing `bodyText` resubmits the template for Meta review
// (status resets to "pending" server-side); `name`/`language` are immutable
// after creation (Meta keys a template by name+language), so they are not
// accepted here at all rather than silently ignored if sent.
// ---------------------------------------------------------------------------

export const updateTemplateRequestSchema = z.object({
  templateId: templateIdSchema,
  bodyText: z.string().min(1).max(1024).optional(),
  category: templateCategorySchema.optional(),
});
export type UpdateTemplateRequest = z.infer<typeof updateTemplateRequestSchema>;

export const updateTemplateResponseSchema = apiResult({ template: templateSchema });
export type UpdateTemplateResponse = z.infer<typeof updateTemplateResponseSchema>;

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export const deleteTemplateRequestSchema = z.object({ templateId: templateIdSchema });
export type DeleteTemplateRequest = z.infer<typeof deleteTemplateRequestSchema>;

export const deleteTemplateResponseSchema = apiResult({});
export type DeleteTemplateResponse = z.infer<typeof deleteTemplateResponseSchema>;

// ---------------------------------------------------------------------------
// Approval status — META_ERROR_TAXONOMY.md §3 132001/132015/132016: a
// template can be rejected, paused (quality) or disabled by Meta
// asynchronously, independent of any request this account made.
// ---------------------------------------------------------------------------

export const getTemplateApprovalStatusRequestSchema = z.object({ templateId: templateIdSchema });
export type GetTemplateApprovalStatusRequest = z.infer<typeof getTemplateApprovalStatusRequestSchema>;

export const templateApprovalStatusViewSchema = z.object({
  templateId: templateIdSchema,
  status: templateApprovalStatusSchema,
  /** Set when `status` is "rejected" or "paused" — plain-English, never a raw Meta string (META_ERROR_TAXONOMY.md §4b). */
  reason: z.string().min(1).nullable(),
  updatedAt: isoDateTimeSchema,
});
export type TemplateApprovalStatusView = z.infer<typeof templateApprovalStatusViewSchema>;

export const getTemplateApprovalStatusResponseSchema = apiResult({ approval: templateApprovalStatusViewSchema });
export type GetTemplateApprovalStatusResponse = z.infer<typeof getTemplateApprovalStatusResponseSchema>;
