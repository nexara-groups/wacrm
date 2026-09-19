"use client";

import { Loader2, MessagesSquare, ChevronDown } from "lucide-react";
import type { Contact } from "@packages/contracts/src/contacts";
import type { Conversation } from "@packages/contracts/src/conversations";
import type { Message } from "@packages/contracts/src/messages";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty-state";
import { MessageStatusBadge } from "@/components/inbox/badges";
import { cn } from "@/lib/utils";

export function ThreadView({
  conversation,
  contact,
  messages,
  loading,
  error,
  hasMoreOlder,
  loadingMore,
  onLoadOlder,
  ownerUserId,
  onAssign,
  assigning,
}: {
  conversation: Conversation | null;
  contact: Contact | undefined;
  messages: readonly Message[];
  loading: boolean;
  error: string | null;
  hasMoreOlder: boolean;
  loadingMore: boolean;
  onLoadOlder: () => void;
  ownerUserId: string;
  onAssign: (assignedUserId: string | null) => void;
  assigning: boolean;
}) {
  if (conversation === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState
          icon={MessagesSquare}
          title="Select a conversation"
          description="Pick a conversation on the left to read its thread."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <p className="text-sm font-semibold">
            {contact?.displayName || contact?.phoneNumber || "Unknown contact"}
          </p>
          <p className="font-mono text-xs text-muted-foreground">{contact?.phoneNumber}</p>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={conversation.assignedUserId ?? ""}
            disabled={assigning}
            onChange={(e) => onAssign(e.target.value === "" ? null : e.target.value)}
            className="w-40"
          >
            <option value="">Unassigned</option>
            <option value={ownerUserId}>Assign to me</option>
          </Select>
        </div>
      </div>

      {error && (
        <p className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      {/* Newest message at the top, oldest at the bottom — the order the
          thread API already returns (`created_at desc, id desc`), rendered
          as-is per the task brief's "oldest at the bottom." Scrolling down
          moves back in time; "Load older" appends further down. */}
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        {loading ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2">
            <Loader2 className="size-5 animate-spin text-primary" />
            <p className="text-xs text-muted-foreground">Loading…</p>
          </div>
        ) : messages.length === 0 ? (
          <EmptyState icon={MessagesSquare} title="No messages yet" />
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={cn(
                "flex flex-col gap-1",
                message.direction === "outbound" ? "items-end" : "items-start",
              )}
            >
              <div
                className={cn(
                  "max-w-md rounded-lg px-3 py-2 text-sm",
                  message.direction === "outbound"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-foreground",
                )}
              >
                {message.body ?? <span className="italic opacity-70">({message.type})</span>}
              </div>
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span>{new Date(message.createdAt).toLocaleString()}</span>
                <span>{message.direction === "outbound" ? "Outbound" : "Inbound"}</span>
                {message.direction === "outbound" && <MessageStatusBadge status={message.status} />}
              </div>
            </div>
          ))
        )}

        {hasMoreOlder && !loading && (
          <div className="flex justify-center pt-2">
            <Button variant="outline" size="sm" onClick={onLoadOlder} disabled={loadingMore}>
              {loadingMore ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ChevronDown className="size-4" />
              )}
              Load older messages
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
