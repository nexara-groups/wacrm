"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Contact } from "@packages/contracts/src/contacts";
import type {
  AssignConversationResponse,
  Conversation,
  GetThreadResponse,
  ListConversationsResponse,
  MarkConversationReadResponse,
  UnreadTotalsResponse,
} from "@packages/contracts/src/conversations";
import type { Message } from "@packages/contracts/src/messages";
import { Badge } from "@/components/ui/badge";
import { ConversationList, type AssignedFilter } from "@/components/inbox/conversation-list";
import { ThreadView } from "@/components/inbox/thread-view";

// `/api/conversations` now filters `unreadOnly`, `search` AND `assignedUserId`
// (including the contract's `"unassigned"` literal) server-side — see that
// route and `ConversationRepository.search`. The "assigned to anyone" leg of
// this screen's three-way toggle has no server-side equivalent: the wire
// contract's `assignedUserFilterSchema` can only express "a specific user"
// or `"unassigned"`, not "assigned to somebody, don't care who" — so that one
// case still filters CLIENT-SIDE over the fetched page below. A page this
// size can therefore still silently hide older "assigned" conversations past
// `CONVERSATIONS_PAGE_SIZE` for an account with many of them; a full fix
// needs either a contract change or a "load more" control, both out of
// scope for this pass.
const CONVERSATIONS_PAGE_SIZE = 50;
const THREAD_PAGE_SIZE = 20;

async function parseOrThrow<T extends { ok: boolean }>(res: Response): Promise<Extract<T, { ok: true }>> {
  const body = (await res.json()) as T;
  if (!body.ok) {
    const message = (body as unknown as { ok: false; error: { laymanMessage: string } }).error.laymanMessage;
    throw new Error(message);
  }
  return body as Extract<T, { ok: true }>;
}

export function InboxView({
  contacts,
  ownerUserId,
}: {
  contacts: readonly Contact[];
  ownerUserId: string;
}) {
  const contactsById = useMemo(() => new Map(contacts.map((c) => [c.id, c] as const)), [contacts]);

  const [conversations, setConversations] = useState<readonly Conversation[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [conversationsError, setConversationsError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [assignedFilter, setAssignedFilter] = useState<AssignedFilter>("all");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);

  const [messages, setMessages] = useState<readonly Message[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [threadPage, setThreadPage] = useState(1);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [assigning, setAssigning] = useState(false);

  const [totalUnread, setTotalUnread] = useState(0);

  const conversationsSeq = useRef(0);

  const loadConversations = useCallback(
    (nextSearch: string, nextUnreadOnly: boolean, nextAssignedFilter: AssignedFilter) => {
      const seq = ++conversationsSeq.current;
      setConversationsLoading(true);
      setConversationsError(null);
      const params = new URLSearchParams({ page: "1", pageSize: String(CONVERSATIONS_PAGE_SIZE) });
      if (nextUnreadOnly) params.set("unreadOnly", "true");
      if (nextSearch.trim().length > 0) params.set("search", nextSearch.trim());
      // "assigned" (to anyone) has no server-side equivalent — see this
      // file's header — so only "unassigned" is forwarded; the "assigned"
      // leg stays a client-side filter over the fetched page below.
      if (nextAssignedFilter === "unassigned") params.set("assignedUserId", "unassigned");
      fetch(`/api/conversations?${params.toString()}`)
        .then((res) => parseOrThrow<ListConversationsResponse>(res))
        .then((body) => {
          if (seq !== conversationsSeq.current) return;
          setConversations(body.items);
        })
        .catch((err: unknown) => {
          if (seq !== conversationsSeq.current) return;
          setConversationsError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (seq !== conversationsSeq.current) return;
          setConversationsLoading(false);
        });
    },
    [],
  );

  const loadUnreadTotals = useCallback(() => {
    fetch("/api/conversations/unread-totals")
      .then((res) => parseOrThrow<UnreadTotalsResponse>(res))
      .then((body) => setTotalUnread(body.totalUnread))
      .catch(() => {
        // A failed badge refresh is not worth surfacing as a page-level error.
      });
  }, []);

  // Initial load.
  useEffect(() => {
    loadConversations("", false, "all");
    loadUnreadTotals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced reload on search/unreadOnly/assignedFilter change — all three
  // are now forwarded to the server ("assignedFilter" as far as the
  // "unassigned" case the contract can express; see `loadConversations`).
  useEffect(() => {
    const handle = setTimeout(() => {
      loadConversations(search, unreadOnly, assignedFilter);
    }, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, unreadOnly, assignedFilter]);

  // Only the "assigned to anyone" leg still needs a client-side pass — the
  // server already excludes non-matching rows for "unassigned" (and does
  // nothing extra for "all").
  const visibleConversations = useMemo(() => {
    if (assignedFilter === "assigned") return conversations.filter((c) => c.assignedUserId !== null);
    return conversations;
  }, [conversations, assignedFilter]);

  const loadThread = useCallback((conversationId: string, page: number, append: boolean) => {
    if (page === 1) {
      setMessagesLoading(true);
    } else {
      setLoadingMore(true);
    }
    setMessagesError(null);
    const params = new URLSearchParams({ page: String(page), pageSize: String(THREAD_PAGE_SIZE) });
    fetch(`/api/conversations/${conversationId}/messages?${params.toString()}`)
      .then((res) => parseOrThrow<GetThreadResponse>(res))
      .then((body) => {
        setMessages((prev) => (append ? [...prev, ...body.items] : body.items));
        setThreadPage(page);
        setHasMoreOlder(body.pagination.hasNext);
        setSelectedConversation(body.conversation);
      })
      .catch((err: unknown) => {
        setMessagesError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setMessagesLoading(false);
        setLoadingMore(false);
      });
  }, []);

  const handleSelect = useCallback(
    (id: string) => {
      setSelectedId(id);
      const conversation = conversations.find((c) => c.id === id) ?? null;
      setSelectedConversation(conversation);
      setMessages([]);
      loadThread(id, 1, false);

      // Selecting a conversation marks it read, through the API — never a
      // local-only mutation.
      if (conversation !== null && conversation.unreadCount > 0) {
        fetch(`/api/conversations/${id}/read`, { method: "POST" })
          .then((res) => parseOrThrow<MarkConversationReadResponse>(res))
          .then((body) => {
            setSelectedConversation(body.conversation);
            setConversations((prev) => prev.map((c) => (c.id === id ? body.conversation : c)));
            loadUnreadTotals();
          })
          .catch(() => {
            // Leave the row as-is; the next full reload will reconcile it.
          });
      }
    },
    [conversations, loadThread, loadUnreadTotals],
  );

  const handleAssign = useCallback(
    (assignedUserId: string | null) => {
      if (selectedId === null) return;
      setAssigning(true);
      fetch(`/api/conversations/${selectedId}/assign`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assignedUserId }),
      })
        .then((res) => parseOrThrow<AssignConversationResponse>(res))
        .then((body) => {
          setSelectedConversation(body.conversation);
          setConversations((prev) => prev.map((c) => (c.id === selectedId ? body.conversation : c)));
        })
        .catch((err: unknown) => {
          setMessagesError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => setAssigning(false));
    },
    [selectedId],
  );

  const selectedContact = selectedConversation ? contactsById.get(selectedConversation.contactId) : undefined;

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-hidden">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Inbox</h1>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Unread</span>
          <Badge variant={totalUnread > 0 ? "default" : "outline"}>{totalUnread}</Badge>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden rounded-lg border border-border">
        <ConversationList
          conversations={visibleConversations}
          contactsById={contactsById}
          loading={conversationsLoading}
          error={conversationsError}
          search={search}
          onSearchChange={setSearch}
          assignedFilter={assignedFilter}
          onAssignedFilterChange={setAssignedFilter}
          unreadOnly={unreadOnly}
          onUnreadOnlyChange={setUnreadOnly}
          selectedId={selectedId}
          onSelect={handleSelect}
        />
        <ThreadView
          conversation={selectedConversation}
          contact={selectedContact}
          messages={messages}
          loading={messagesLoading}
          error={messagesError}
          hasMoreOlder={hasMoreOlder}
          loadingMore={loadingMore}
          onLoadOlder={() => {
            if (selectedId !== null) loadThread(selectedId, threadPage + 1, true);
          }}
          ownerUserId={ownerUserId}
          onAssign={handleAssign}
          assigning={assigning}
        />
      </div>
    </div>
  );
}
