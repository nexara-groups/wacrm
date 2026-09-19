/**
 * `createApiClient` — the typed client web and mobile both consume. Every
 * method parses its response through the matching `@packages/contracts`
 * zod schema and returns `Result<T, ApiClientError>` (never throws for an
 * expected failure — see `./result.ts` and `./errors.ts`).
 */
import type { FetchLike } from "./http";
import { createBroadcastsResource, type BroadcastsResource } from "./resources/broadcasts";
import { createContactsResource, type ContactsResource } from "./resources/contacts";
import { createConversationsResource, type ConversationsResource } from "./resources/conversations";
import { createInvitationsResource, type InvitationsResource } from "./resources/invitations";
import { createMessagesResource, type MessagesResource } from "./resources/messages";
import { createOnboardingResource, type OnboardingResource } from "./resources/onboarding";
import { createSeatsResource, type SeatsResource } from "./resources/seats";
import { createTemplatesResource, type TemplatesResource } from "./resources/templates";

export interface CreateApiClientOptions {
  /** Origin + path prefix, no trailing slash, e.g. `"https://api.wacrm.example.com"` or `""` for same-origin. */
  readonly baseUrl: string;
  /**
   * Injectable so tests never touch the network and so a Worker or React
   * Native runtime can supply its own `fetch` (also the seam for adding
   * auth headers dynamically: wrap the injected function rather than
   * configuring per-request headers here).
   */
  readonly fetch?: FetchLike;
  /** Merged into every request (e.g. `Authorization`). Static for the lifetime of this client instance — construct a new client if the value needs to change. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ApiClient {
  readonly contacts: ContactsResource;
  readonly conversations: ConversationsResource;
  readonly messages: MessagesResource;
  readonly broadcasts: BroadcastsResource;
  readonly templates: TemplatesResource;
  readonly invitations: InvitationsResource;
  readonly seats: SeatsResource;
  readonly onboarding: OnboardingResource;
}

export function createApiClient(options: CreateApiClientOptions): ApiClient {
  const baseUrl = options.baseUrl.endsWith("/") ? options.baseUrl.slice(0, -1) : options.baseUrl;
  const fetchFn = options.fetch ?? (globalThis.fetch.bind(globalThis) as FetchLike);
  const ctx = { baseUrl, fetchFn, headers: options.headers ?? {} };

  return {
    contacts: createContactsResource(ctx),
    conversations: createConversationsResource(ctx),
    messages: createMessagesResource(ctx),
    broadcasts: createBroadcastsResource(ctx),
    templates: createTemplatesResource(ctx),
    invitations: createInvitationsResource(ctx),
    seats: createSeatsResource(ctx),
    onboarding: createOnboardingResource(ctx),
  };
}
