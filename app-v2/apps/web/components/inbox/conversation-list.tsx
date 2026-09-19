"use client";

import { Loader2, MessagesSquare, Search } from "lucide-react";
import type { Contact } from "@packages/contracts/src/contacts";
import type { Conversation } from "@packages/contracts/src/conversations";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty-state";
import { UnreadCountBadge } from "@/components/inbox/badges";
import { cn } from "@/lib/utils";

export type AssignedFilter = "all" | "unassigned" | "assigned";

export function ConversationList({
  conversations,
  contactsById,
  loading,
  error,
  search,
  onSearchChange,
  assignedFilter,
  onAssignedFilterChange,
  unreadOnly,
  onUnreadOnlyChange,
  selectedId,
  onSelect,
}: {
  conversations: readonly Conversation[];
  contactsById: ReadonlyMap<string, Contact>;
  loading: boolean;
  error: string | null;
  search: string;
  onSearchChange: (value: string) => void;
  assignedFilter: AssignedFilter;
  onAssignedFilterChange: (value: AssignedFilter) => void;
  unreadOnly: boolean;
  onUnreadOnlyChange: (value: boolean) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-r border-border">
      <div className="flex flex-col gap-2 border-b border-border p-3">
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search by contact name or phone…"
            className="pl-8"
          />
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={assignedFilter}
            onChange={(e) => onAssignedFilterChange(e.target.value as AssignedFilter)}
            className="flex-1"
          >
            <option value="all">All conversations</option>
            <option value="unassigned">Unassigned</option>
            <option value="assigned">Assigned</option>
          </Select>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(e) => onUnreadOnlyChange(e.target.checked)}
            className="size-3.5 rounded border-input"
          />
          Unread only
        </label>
      </div>

      {error && (
        <p className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex flex-col items-center gap-2 py-12">
            <Loader2 className="size-5 animate-spin text-primary" />
            <p className="text-xs text-muted-foreground">Loading…</p>
          </div>
        ) : conversations.length === 0 ? (
          <EmptyState
            icon={MessagesSquare}
            title="No conversations"
            description="Nothing matches the current filters."
          />
        ) : (
          <ul>
            {conversations.map((conversation) => {
              const contact = contactsById.get(conversation.contactId);
              const active = conversation.id === selectedId;
              return (
                <li key={conversation.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(conversation.id)}
                    className={cn(
                      "flex w-full flex-col gap-1 border-b border-border px-3 py-3 text-left transition-colors hover:bg-muted/50",
                      active && "bg-muted",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">
                        {contact?.displayName || contact?.phoneNumber || "Unknown contact"}
                      </span>
                      <UnreadCountBadge count={conversation.unreadCount} />
                    </div>
                    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span className="truncate font-mono">{contact?.phoneNumber ?? conversation.contactId}</span>
                      <span>
                        {conversation.assignedUserId
                          ? "Assigned"
                          : "Unassigned"}
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
