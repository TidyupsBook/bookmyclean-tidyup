/**
 * Staff chat.
 *
 * Separate from the customer inbox on purpose: mixing crew talk with texts a
 * homeowner can read is how the wrong message goes to the wrong person. Anyone
 * on the roster can be here, cleaners included — they need to reach each other
 * without routing everything through the office.
 *
 * Nothing posted here is texted out. An unread message shows as a red count on
 * Team Chat from every page and makes a sound, which is the whole notification
 * — so a crew that wants to hear from the office needs the app open.
 */
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader, LoadingSpinner } from "@/components/ui/shared";
import {
  useListStaffConversations,
  useGetStaffConversation,
  useStartStaffConversation,
  useSendStaffMessage,
  useListChatContacts,
  getListChatContactsQueryKey,
  getListStaffConversationsQueryKey,
  getGetStaffConversationQueryKey,
  type StaffConversation,
  type StaffMessage,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";
import { MessageSquare, Plus, Send, Users } from "lucide-react";

export function TeamChatPage() {
  const [activeId, setActiveId] = useState<number | null>(null);
  const [newChatOpen, setNewChatOpen] = useState(false);

  const { data: conversations, isLoading } = useListStaffConversations({
    query: {
      queryKey: getListStaffConversationsQueryKey(),
      refetchInterval: 15_000,
    },
  });

  const currentId = activeId ?? conversations?.[0]?.id ?? null;

  return (
    <AppLayout>
      <PageHeader
        title="Team Chat"
        description="Talk to your crew. Unread messages show a red count and make a sound."
      >
        <Button
          onClick={() => setNewChatOpen(true)}
          className="bg-brand-pink hover:bg-brand-pink/90"
          data-testid="button-new-chat"
        >
          <Plus className="w-4 h-4" />
          New chat
        </Button>
      </PageHeader>

      {isLoading ? (
        <LoadingSpinner className="mt-20" />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-[20rem_minmax(0,1fr)] gap-4 items-start">
          <ConversationList
            conversations={conversations ?? []}
            activeId={currentId}
            onSelect={setActiveId}
            onStart={() => setNewChatOpen(true)}
          />
          {currentId === null ? (
            <div className="bg-card border border-border rounded-xl p-12 text-center text-muted-foreground">
              Start a chat to get talking.
            </div>
          ) : (
            <ChatPane conversationId={currentId} />
          )}
        </div>
      )}

      <NewChatDialog
        open={newChatOpen}
        onOpenChange={setNewChatOpen}
        onCreated={(id) => setActiveId(id)}
      />
    </AppLayout>
  );
}

export function ConversationList({
  conversations,
  activeId,
  onSelect,
  onStart,
}: {
  conversations: StaffConversation[];
  activeId: number | null;
  onSelect: (id: number) => void;
  onStart: () => void;
}) {
  if (conversations.length === 0) {
    return (
      <div className="bg-card border border-border rounded-xl p-8 text-center">
        <div className="w-12 h-12 bg-secondary rounded-full flex items-center justify-center mx-auto mb-3">
          <MessageSquare className="w-6 h-6 text-muted-foreground" />
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          No chats yet. Start one with anyone on your team.
        </p>
        <Button variant="outline" onClick={onStart}>
          New chat
        </Button>
      </div>
    );
  }

  return (
    <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
      <ScrollArea className="max-h-[36rem]">
        <div className="divide-y divide-border">
          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              onClick={() => onSelect(conversation.id)}
              data-testid={`row-chat-${conversation.id}`}
              className={`w-full text-left px-4 py-3 transition-colors ${
                conversation.id === activeId
                  ? "bg-secondary/70"
                  : "hover:bg-secondary/40"
              }`}
            >
              <div className="flex items-center gap-3">
                <ChatAvatar
                  name={
                    conversation.kind === "direct"
                      ? (conversation.members[0]?.name ?? conversation.title)
                      : undefined
                  }
                  isLive={conversation.members.some((m) => m.isLive)}
                  liveTestId={`dot-live-chat-${conversation.id}`}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground truncate flex-1">
                      {conversation.title}
                    </span>
                    {conversation.unreadCount > 0 && (
                      <span
                        data-testid={`badge-unread-chat-${conversation.id}`}
                        className="shrink-0 min-w-5 h-5 px-1.5 rounded-full bg-red-500 text-white text-[11px] font-semibold inline-flex items-center justify-center"
                      >
                        {conversation.unreadCount}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground truncate mt-0.5">
                    {conversation.lastMessagePreview || "No messages yet"}
                  </div>
                  <div className="text-[11px] text-muted-foreground/70 mt-0.5">
                    {formatDistanceToNow(new Date(conversation.lastMessageAt), {
                      addSuffix: true,
                    })}
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

/**
 * A little portrait with the messenger-style "online" light: a glowing green
 * bubble pinned to the corner while that person is out working with location
 * on — the same rule that lights up the map and the schedule. Without a name
 * it renders the group icon instead of initials.
 */
function ChatAvatar({
  name,
  isLive,
  className = "w-9 h-9 text-xs",
  liveTestId,
}: {
  name?: string;
  isLive: boolean;
  className?: string;
  liveTestId?: string;
}) {
  return (
    <span className={`relative inline-flex shrink-0 ${className}`}>
      {name ? (
        <span className="w-full h-full rounded-full bg-brand-pink/15 text-brand-pink font-semibold inline-flex items-center justify-center">
          {initialsOf(name)}
        </span>
      ) : (
        <span className="w-full h-full rounded-full bg-secondary text-muted-foreground inline-flex items-center justify-center">
          <Users className="w-4 h-4" />
        </span>
      )}
      {isLive && (
        <span
          data-testid={liveTestId}
          title={
            name
              ? `${name} is live now — out working with location on`
              : "Someone here is live now — out working with location on"
          }
          className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-500 ring-2 ring-card animate-pulse shadow-[0_0_6px_2px_rgba(16,185,129,0.55)]"
        />
      )}
    </span>
  );
}

export function ChatPane({ conversationId }: { conversationId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const bottom = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");

  const { data, isLoading } = useGetStaffConversation(conversationId, {
    query: {
      queryKey: getGetStaffConversationQueryKey(conversationId),
      refetchInterval: 10_000,
    },
  });
  const send = useSendStaffMessage();

  const messageCount = data?.messages.length ?? 0;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
    queryClient.invalidateQueries({
      queryKey: getListStaffConversationsQueryKey(),
    });
  }, [messageCount, conversationId, queryClient]);

  useEffect(() => setDraft(""), [conversationId]);

  const submit = () => {
    const body = draft.trim();
    if (!body || send.isPending) return;
    send.mutate(
      { id: conversationId, data: { body } },
      {
        onSuccess: () => {
          setDraft("");
          queryClient.invalidateQueries({
            queryKey: getGetStaffConversationQueryKey(conversationId),
          });
          queryClient.invalidateQueries({
            queryKey: getListStaffConversationsQueryKey(),
          });
        },
        onError: (err: unknown) => {
          toast({
            title: "Message not sent",
            description: err instanceof Error ? err.message : "Try that again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  if (isLoading || !data) {
    return (
      <div className="bg-card border border-border rounded-xl p-12">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="bg-card border border-border rounded-xl shadow-sm flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-secondary/40 flex items-center gap-3">
        {data.conversation.kind === "direct" && (
          <ChatAvatar
            name={data.conversation.members[0]?.name ?? data.conversation.title}
            isLive={data.conversation.members[0]?.isLive ?? false}
            liveTestId="dot-live-pane"
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-foreground truncate">
            {data.conversation.title}
          </div>
          <div className="text-xs text-muted-foreground flex items-center gap-1.5 min-w-0">
            <span className="truncate">
              {data.conversation.memberNames.join(", ") || "Just you"}
            </span>
            {(() => {
              const live = data.conversation.members.filter((m) => m.isLive);
              if (live.length === 0) return null;
              return (
                <span
                  data-testid="text-chat-live"
                  className="inline-flex items-center gap-1 text-emerald-600 font-medium shrink-0"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  {data.conversation.kind === "direct"
                    ? "Live now"
                    : `${live.length} live now`}
                </span>
              );
            })()}
          </div>
        </div>
        {data.conversation.kind === "group" &&
          data.conversation.members.length > 0 && (
            <div className="hidden sm:flex items-center gap-1 shrink-0">
              {data.conversation.members.slice(0, 6).map((member) => (
                <ChatAvatar
                  key={member.id}
                  name={member.name}
                  isLive={member.isLive}
                  className="w-7 h-7 text-[10px]"
                  liveTestId={`dot-live-member-${member.id}`}
                />
              ))}
              {data.conversation.members.length > 6 && (
                <span className="w-7 h-7 rounded-full bg-secondary text-[10px] text-muted-foreground inline-flex items-center justify-center">
                  +{data.conversation.members.length - 6}
                </span>
              )}
            </div>
          )}
      </div>

      <ScrollArea className="h-[26rem] p-4">
        <div className="space-y-3">
          {data.messages.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">
              Nothing here yet. Say something.
            </p>
          )}
          {data.messages.map((message) => (
            <ChatBubble
              key={message.id}
              message={message}
              mine={message.memberId === data.myMemberId}
              showAuthor={data.conversation.kind === "group"}
              authorLive={data.conversation.members.some(
                (m) => m.id === message.memberId && m.isLive,
              )}
            />
          ))}
          <div ref={bottom} />
        </div>
      </ScrollArea>

      <div className="border-t border-border p-3 space-y-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Message your team…"
          rows={2}
          maxLength={2000}
          data-testid="input-chat-body"
        />
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            Shows as a red badge for everyone in this chat.
          </span>
          <Button
            onClick={submit}
            disabled={!draft.trim() || send.isPending}
            className="bg-brand-pink hover:bg-brand-pink/90"
            data-testid="button-send-chat"
          >
            <Send className="w-4 h-4" />
            {send.isPending ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ChatBubble({
  message,
  mine,
  showAuthor,
  authorLive = false,
}: {
  message: StaffMessage;
  mine: boolean;
  showAuthor: boolean;
  /** The sender is out working right now — lights a dot by their name. */
  authorLive?: boolean;
}) {
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div className="max-w-[80%] space-y-1">
        {showAuthor && !mine && (
          <div className="text-[11px] text-muted-foreground px-1 flex items-center gap-1">
            {message.authorName}
            {authorLive && (
              <span
                data-testid={`dot-live-author-${message.id}`}
                title="Live now — out working with location on"
                className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"
              />
            )}
          </div>
        )}
        <div
          className={`rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap break-words ${
            mine ? "bg-brand-pink text-white" : "bg-secondary text-foreground"
          }`}
          data-testid={`text-chat-${message.id}`}
        >
          {message.body}
        </div>
        <div
          className={`text-[11px] text-muted-foreground ${mine ? "text-right" : ""}`}
        >
          {formatDistanceToNow(new Date(message.createdAt), {
            addSuffix: true,
          })}
        </div>
      </div>
    </div>
  );
}

function NewChatDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: number) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<number[]>([]);
  const [title, setTitle] = useState("");

  const { data: contacts } = useListChatContacts({
    query: { queryKey: getListChatContactsQueryKey(), enabled: open },
  });
  const start = useStartStaffConversation();

  useEffect(() => {
    if (!open) {
      setSelected([]);
      setTitle("");
    }
  }, [open]);

  const submit = () => {
    if (selected.length === 0) return;
    start.mutate(
      {
        data: {
          memberIds: selected,
          title: selected.length > 1 ? title.trim() || null : null,
        },
      },
      {
        onSuccess: (conversation) => {
          queryClient.invalidateQueries({
            queryKey: getListStaffConversationsQueryKey(),
          });
          onCreated(conversation.id);
          onOpenChange(false);
        },
        onError: (err: unknown) => {
          toast({
            title: "Couldn't start that chat",
            description: err instanceof Error ? err.message : "Try that again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New chat</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Pick one person for a direct chat, or several for a group.
          </p>
          <div className="max-h-64 overflow-y-auto space-y-1 pr-1">
            {(contacts ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground">
                Nobody else on the team yet.
              </p>
            )}
            {(contacts ?? []).map((contact) => {
              const checked = selected.includes(contact.id);
              return (
                <label
                  key={contact.id}
                  className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-secondary/50 cursor-pointer"
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(value) =>
                      setSelected((prev) =>
                        value
                          ? [...prev, contact.id]
                          : prev.filter((id) => id !== contact.id),
                      )
                    }
                    data-testid={`checkbox-contact-${contact.id}`}
                  />
                  <ChatAvatar
                    name={contact.name}
                    isLive={contact.isLive}
                    className="w-8 h-8 text-[11px]"
                    liveTestId={`dot-live-contact-${contact.id}`}
                  />
                  <span className="text-sm text-foreground flex-1 min-w-0">
                    <span className="truncate block">
                      {contact.name}
                      {contact.isLead ? " · Lead" : ""}
                      {contact.isLive && (
                        <span className="text-emerald-600 font-medium">
                          {" "}
                          · Live now
                        </span>
                      )}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground capitalize">
                    {contact.role}
                  </span>
                </label>
              );
            })}
          </div>

          {selected.length > 1 && (
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Group name (optional)"
              data-testid="input-group-name"
            />
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={selected.length === 0 || start.isPending}
            className="bg-brand-pink hover:bg-brand-pink/90"
            data-testid="button-create-chat"
          >
            {start.isPending ? "Starting…" : "Start chat"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
