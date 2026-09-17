/**
 * ConversationService — list/filter/assign/mark-read, and the 24h
 * service-window preflight check. Authorizes nothing itself (that is
 * `PermissionService`'s job at the route layer, per ARCHITECTURE_MODEL.md
 * §1) — this service enforces the CONVERSATION invariants (unread counting,
 * assignment, open/closed) via the pure `domain/conversation.ts` functions,
 * then delegates the actual read/write to `ConversationRepository`. It never
 * touches SQL.
 */
import { AppError } from "@shared/errors";
import { err, ok, type Result } from "@shared/result";
import type { TenantContext } from "@nexara/core/context";
import type { ConversationId, UserId } from "@packages/domain";
import {
  assignConversation,
  closeConversation,
  markRead,
  reopenConversation,
  type ConversationRecord,
} from "../domain/conversation";
import { isWithinServiceWindow, requiresTemplate } from "../domain/24h-window";
import type { ConversationFilter, ConversationListPage, ConversationRepository } from "./ports";
import type { SequenceCursor } from "../domain/incremental-sync";

export interface ConversationServiceDeps {
  readonly repository: ConversationRepository;
  /** Injectable clock for deterministic tests; defaults to `() => new Date().toISOString()`. */
  readonly clock?: () => string;
}

export class ConversationService {
  private readonly repository: ConversationRepository;
  private readonly clock: () => string;

  constructor(deps: ConversationServiceDeps) {
    this.repository = deps.repository;
    this.clock = deps.clock ?? (() => new Date().toISOString());
  }

  async get(tenant: TenantContext, id: ConversationId): Promise<Result<ConversationRecord, AppError>> {
    const conversation = await this.repository.findById(tenant, id);
    if (!conversation) return err(AppError.notFound("Conversation not found"));
    return ok(conversation);
  }

  async list(
    tenant: TenantContext,
    filter: ConversationFilter,
    opts: { readonly limit: number; readonly before?: SequenceCursor },
  ): Promise<ConversationListPage> {
    return this.repository.list(tenant, filter, opts);
  }

  /** Total-unread badge count — a cheap indexed count, never a message scan (see `ports.ts`). */
  async unreadConversationCount(tenant: TenantContext): Promise<number> {
    return this.repository.countUnreadConversations(tenant);
  }

  async assign(
    tenant: TenantContext,
    id: ConversationId,
    assigneeUserId: UserId | null,
  ): Promise<Result<ConversationRecord, AppError>> {
    const conversation = await this.repository.findById(tenant, id);
    if (!conversation) return err(AppError.notFound("Conversation not found"));
    const next = assignConversation(conversation, assigneeUserId);
    if (next === conversation) return ok(conversation);
    return ok(await this.repository.save(tenant, next));
  }

  /** Whole-conversation mark-read (invariant #3 in `domain/conversation.ts`: no per-message read state). */
  async markRead(tenant: TenantContext, id: ConversationId): Promise<Result<ConversationRecord, AppError>> {
    const conversation = await this.repository.findById(tenant, id);
    if (!conversation) return err(AppError.notFound("Conversation not found"));
    const next = markRead(conversation);
    if (next === conversation) return ok(conversation);
    return ok(await this.repository.save(tenant, next));
  }

  async close(tenant: TenantContext, id: ConversationId): Promise<Result<ConversationRecord, AppError>> {
    const conversation = await this.repository.findById(tenant, id);
    if (!conversation) return err(AppError.notFound("Conversation not found"));
    const next = closeConversation(conversation);
    if (next === conversation) return ok(conversation);
    return ok(await this.repository.save(tenant, next));
  }

  async reopen(tenant: TenantContext, id: ConversationId): Promise<Result<ConversationRecord, AppError>> {
    const conversation = await this.repository.findById(tenant, id);
    if (!conversation) return err(AppError.notFound("Conversation not found"));
    const next = reopenConversation(conversation);
    if (next === conversation) return ok(conversation);
    return ok(await this.repository.save(tenant, next));
  }

  /**
   * Preflight for a would-be free-form send: PREVENTS Meta error 131047
   * rather than reporting it after the fact, by checking the 24h window
   * before the caller (the `whatsapp` module's send path) ever calls Meta.
   */
  async canSendFreeform(tenant: TenantContext, id: ConversationId): Promise<Result<boolean, AppError>> {
    const conversation = await this.repository.findById(tenant, id);
    if (!conversation) return err(AppError.notFound("Conversation not found"));
    return ok(isWithinServiceWindow(conversation.lastInboundAt, this.clock()));
  }

  /** The inverse of `canSendFreeform` — true when only an approved template may be sent. */
  async requiresTemplate(tenant: TenantContext, id: ConversationId): Promise<Result<boolean, AppError>> {
    const conversation = await this.repository.findById(tenant, id);
    if (!conversation) return err(AppError.notFound("Conversation not found"));
    return ok(requiresTemplate(conversation.lastInboundAt, this.clock()));
  }
}
