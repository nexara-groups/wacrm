/**
 * Pagination contracts — reuses the shape produced by `@shared/pagination`'s
 * `paginationRange()` (from/to/totalPages/hasPrevious/hasNext) plus the
 * page/pageSize/total inputs, so a server handler can spread that function's
 * return value straight into `paginationMetaSchema` without reshaping it.
 */
import { z } from "zod";

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const paginationMetaSchema = z.object({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  total: z.number().int().min(0),
  totalPages: z.number().int().min(1),
  /** 1-based index of the first item on this page; 0 when the page is empty. */
  from: z.number().int().min(0),
  /** 1-based index of the last item on this page; 0 when the page is empty. */
  to: z.number().int().min(0),
  hasPrevious: z.boolean(),
  hasNext: z.boolean(),
});
export type PaginationMeta = z.infer<typeof paginationMetaSchema>;

/** Wraps an item schema into `{ items, pagination }` — the standard list-response envelope. */
export function paginatedResponseSchema<ItemSchema extends z.ZodType>(item: ItemSchema) {
  return z.object({
    items: z.array(item),
    pagination: paginationMetaSchema,
  });
}
