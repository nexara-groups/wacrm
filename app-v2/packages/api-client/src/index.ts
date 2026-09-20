/**
 * @packages/api-client — the typed client web and mobile both consume,
 * built on `@packages/contracts`'s zod schemas. Every response is parsed
 * through its schema, never cast; every method returns
 * `Result<T, ApiClientError>` instead of throwing for an expected failure.
 * Runtime dependencies: zod (transitively, via `@packages/contracts`) and
 * `@packages/contracts` itself — nothing else.
 */
export { createApiClient, type ApiClient, type CreateApiClientOptions } from "./client";

export type { FetchLike, ApiClientContext, QueryValue, QueryParams } from "./http";

export {
  type ApiClientError,
  type ApiNetworkError,
  type ApiHttpError,
  type ApiParseError,
  type ApiParseIssue,
  isNetworkError,
  isHttpError,
  isParseError,
} from "./errors";

export { ok, err, isOk, isErr, type Result } from "./result";

export type { ContactsResource } from "./resources/contacts";
export type { ConversationsResource } from "./resources/conversations";
export type { MessagesResource } from "./resources/messages";
export type { BroadcastsResource } from "./resources/broadcasts";
export type { TemplatesResource } from "./resources/templates";
export type { InvitationsResource } from "./resources/invitations";
export type { SeatsResource } from "./resources/seats";
export type { OnboardingResource } from "./resources/onboarding";
