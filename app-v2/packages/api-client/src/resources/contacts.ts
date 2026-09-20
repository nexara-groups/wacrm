/**
 * Contacts — list (filter by tag/search/consent/deliverability), get,
 * create, update, delete, CSV import, and the suppression/consent view.
 *
 * NOTE on `search`: the contracts package does not define a separate
 * "search contacts" endpoint — `search` is a filter field on
 * `listContactsQuerySchema` (`packages/contracts/src/contacts.ts`). The
 * build brief asks for a `search` method alongside `list`; `search()`
 * below is sugar over the exact same `/contacts.list` wire call with the
 * `search` field populated, not a distinct endpoint. See this package's
 * SubagentHandback report.
 */
import type {
  ClearSuppressionRequest,
  ClearSuppressionResponse,
  Contact,
  ContactSuppressionView,
  CreateContactRequest,
  CreateContactResponse,
  DeleteContactRequest,
  DeleteContactResponse,
  ImportContactsRequest,
  ImportContactsResult,
  ListContactsQuery,
  ListContactsResponse,
  UpdateContactRequest,
  UpdateContactResponse,
} from "@packages/contracts/src/index";
import {
  clearSuppressionResponseSchema,
  createContactResponseSchema,
  deleteContactResponseSchema,
  getContactResponseSchema,
  getContactSuppressionViewResponseSchema,
  importContactsResponseSchema,
  listContactsResponseSchema,
  updateContactResponseSchema,
} from "@packages/contracts/src/index";
import { apiRequest, type ApiClientContext, type SuccessOf } from "../http";
import type { ApiClientError } from "../errors";
import type { Result } from "../result";

export interface ContactsResource {
  list(query?: ListContactsQuery): Promise<Result<SuccessOf<ListContactsResponse>, ApiClientError>>;
  /** Sugar over `list()` with `search` populated — see this file's header comment. */
  search(
    term: string,
    query?: Omit<ListContactsQuery, "search">,
  ): Promise<Result<SuccessOf<ListContactsResponse>, ApiClientError>>;
  /** `contact` is `null` when no such contact exists — a miss is not an error (see `getContactResponseSchema`). */
  get(contactId: string): Promise<Result<{ contact: Contact | null }, ApiClientError>>;
  create(request: CreateContactRequest): Promise<Result<SuccessOf<CreateContactResponse>, ApiClientError>>;
  update(request: UpdateContactRequest): Promise<Result<SuccessOf<UpdateContactResponse>, ApiClientError>>;
  delete(request: DeleteContactRequest): Promise<Result<SuccessOf<DeleteContactResponse>, ApiClientError>>;
  import(request: ImportContactsRequest): Promise<Result<{ result: ImportContactsResult }, ApiClientError>>;
  getSuppressionView(
    contactId: string,
  ): Promise<Result<{ view: ContactSuppressionView }, ApiClientError>>;
  clearSuppression(
    request: ClearSuppressionRequest,
  ): Promise<Result<SuccessOf<ClearSuppressionResponse>, ApiClientError>>;
}

export function createContactsResource(ctx: ApiClientContext): ContactsResource {
  return {
    list: (query) =>
      apiRequest(ctx, { method: "GET", path: "/contacts.list", query }, listContactsResponseSchema),

    search: (term, query) =>
      apiRequest(
        ctx,
        { method: "GET", path: "/contacts.list", query: { ...query, search: term } },
        listContactsResponseSchema,
      ),

    get: (contactId) =>
      apiRequest(ctx, { method: "GET", path: "/contacts.get", query: { contactId } }, getContactResponseSchema),

    create: (request) => apiRequest(ctx, { method: "POST", path: "/contacts.create", body: request }, createContactResponseSchema),

    update: (request) => apiRequest(ctx, { method: "POST", path: "/contacts.update", body: request }, updateContactResponseSchema),

    delete: (request) => apiRequest(ctx, { method: "POST", path: "/contacts.delete", body: request }, deleteContactResponseSchema),

    import: (request) => apiRequest(ctx, { method: "POST", path: "/contacts.import", body: request }, importContactsResponseSchema),

    getSuppressionView: (contactId) =>
      apiRequest(
        ctx,
        { method: "GET", path: "/contacts.suppressionView", query: { contactId } },
        getContactSuppressionViewResponseSchema,
      ),

    clearSuppression: (request) =>
      apiRequest(ctx, { method: "POST", path: "/contacts.clearSuppression", body: request }, clearSuppressionResponseSchema),
  };
}
