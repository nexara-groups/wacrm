/**
 * Messages — send text/template/media/interactive, message status, and
 * reactions.
 */
import type {
  GetMessageStatusRequest,
  GetMessageStatusResponse,
  RemoveReactionRequest,
  RemoveReactionResponse,
  SendInteractiveMessageRequest,
  SendInteractiveMessageResponse,
  SendMediaMessageRequest,
  SendMediaMessageResponse,
  SendReactionRequest,
  SendReactionResponse,
  SendTemplateMessageRequest,
  SendTemplateMessageResponse,
  SendTextMessageRequest,
  SendTextMessageResponse,
} from "@packages/contracts/src/index";
import {
  getMessageStatusResponseSchema,
  removeReactionResponseSchema,
  sendInteractiveMessageResponseSchema,
  sendMediaMessageResponseSchema,
  sendReactionResponseSchema,
  sendTemplateMessageResponseSchema,
  sendTextMessageResponseSchema,
} from "@packages/contracts/src/index";
import { apiRequest, type ApiClientContext, type SuccessOf } from "../http";
import type { ApiClientError } from "../errors";
import type { Result } from "../result";

export interface MessagesResource {
  sendText(request: SendTextMessageRequest): Promise<Result<SuccessOf<SendTextMessageResponse>, ApiClientError>>;
  sendTemplate(
    request: SendTemplateMessageRequest,
  ): Promise<Result<SuccessOf<SendTemplateMessageResponse>, ApiClientError>>;
  sendMedia(request: SendMediaMessageRequest): Promise<Result<SuccessOf<SendMediaMessageResponse>, ApiClientError>>;
  sendInteractive(
    request: SendInteractiveMessageRequest,
  ): Promise<Result<SuccessOf<SendInteractiveMessageResponse>, ApiClientError>>;
  getStatus(
    request: GetMessageStatusRequest,
  ): Promise<Result<SuccessOf<GetMessageStatusResponse>, ApiClientError>>;
  sendReaction(request: SendReactionRequest): Promise<Result<SuccessOf<SendReactionResponse>, ApiClientError>>;
  removeReaction(
    request: RemoveReactionRequest,
  ): Promise<Result<SuccessOf<RemoveReactionResponse>, ApiClientError>>;
}

export function createMessagesResource(ctx: ApiClientContext): MessagesResource {
  return {
    sendText: (request) =>
      apiRequest(ctx, { method: "POST", path: "/messages.sendText", body: request }, sendTextMessageResponseSchema),

    sendTemplate: (request) =>
      apiRequest(
        ctx,
        { method: "POST", path: "/messages.sendTemplate", body: request },
        sendTemplateMessageResponseSchema,
      ),

    sendMedia: (request) =>
      apiRequest(ctx, { method: "POST", path: "/messages.sendMedia", body: request }, sendMediaMessageResponseSchema),

    sendInteractive: (request) =>
      apiRequest(
        ctx,
        { method: "POST", path: "/messages.sendInteractive", body: request },
        sendInteractiveMessageResponseSchema,
      ),

    getStatus: (request) =>
      apiRequest(
        ctx,
        { method: "GET", path: "/messages.status", query: request },
        getMessageStatusResponseSchema,
      ),

    sendReaction: (request) =>
      apiRequest(ctx, { method: "POST", path: "/messages.sendReaction", body: request }, sendReactionResponseSchema),

    removeReaction: (request) =>
      apiRequest(
        ctx,
        { method: "POST", path: "/messages.removeReaction", body: request },
        removeReactionResponseSchema,
      ),
  };
}
