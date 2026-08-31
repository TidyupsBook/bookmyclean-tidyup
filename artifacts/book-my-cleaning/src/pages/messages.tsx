/**
 * The customer inbox.
 *
 * Texts on the business line belong to the company, not to whoever happened to
 * be holding a phone: everything a customer sends lands here, and every reply
 * leaves from the same number they already have. Threads are keyed by number
 * rather than by booking, because that's how customers actually text — one
 * running conversation about last month's clean and next week's quote.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader, LoadingSpinner } from "@/components/ui/shared";
import {
  useListMessageThreads,
  useGetMessageThread,
  useStartMessageThread,
  useSendClientMessage,
  getListMessageThreadsQueryKey,
  getGetMessageThreadQueryKey,
  getGetUnreadMessageCountQueryKey,
  type MessageThread,
  type ClientMessage,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";
import { MessageSquare, Send, Phone, AlertTriangle } from "lucide-react";
import { formatPhone, telHref } from "@/lib/phone";

export function MessagesPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [activeThreadId, setActiveThreadId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  // Keep the inbox live without a socket: a text can arrive at any moment and
  // the dispatcher is usually looking at this page while it does.
  const { data: threads, isLoading } = useListMessageThreads({
    query: {
      queryKey: getListMessageThreadsQueryKey(),
      refetchInterval: 15_000,
    },
  });
  const startThread = useStartMessageThread();

  // "Text" buttons elsewhere in the app arrive as /messages?to=+1555...&name=…
  // Open (or create) that person's thread once, then clean the URL so a
  // refresh doesn't reopen it over whatever the dispatcher moved on to.
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const requestedPhone = params.get("to");
  const requestedName = params.get("name");
  const openedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!requestedPhone || openedFor.current === requestedPhone) return;
    openedFor.current = requestedPhone;
    startThread.mutate(
      { data: { phone: requestedPhone, name: requestedName } },
      {
        onSuccess: (thread) => {
          setActiveThreadId(thread.id);
          queryClient.invalidateQueries({
            queryKey: getListMessageThreadsQueryKey(),
          });
          navigate("/messages", { replace: true });
        },
        onError: (err: unknown) => {
          toast({
            title: "Couldn't open that conversation",
            description:
              err instanceof Error ? err.message : "Check the phone number.",
            variant: "destructive",
          });
          navigate("/messages", { replace: true });
        },
      },
    );
  }, [
    requestedPhone,
    requestedName,
    startThread,
    navigate,
    queryClient,
    toast,
  ]);

  const activeId = activeThreadId ?? threads?.[0]?.id ?? null;

  return (
    <AppLayout>
      <PageHeader
        title="Messages"
        description="Texts to and from your customers, on your business line."
      />

      {isLoading ? (
        <LoadingSpinner className="mt-20" />
      ) : (threads?.length ?? 0) === 0 ? (
        <EmptyInbox />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-[20rem_minmax(0,1fr)] gap-4 items-start">
          <ThreadList
            threads={threads ?? []}
            activeId={activeId}
            onSelect={(id) => {
              setActiveThreadId(id);
              setDraft("");
            }}
          />
          {activeId === null ? (
            <div className="bg-card border border-border rounded-xl p-12 text-center text-muted-foreground">
              Pick a conversation to read it.
            </div>
          ) : (
            <Conversation
              threadId={activeId}
              draft={draft}
              onDraftChange={setDraft}
            />
          )}
        </div>
      )}
    </AppLayout>
  );
}

function EmptyInbox() {
  return (
    <div className="bg-card border border-border rounded-xl shadow-sm p-12 text-center">
      <div className="w-12 h-12 bg-secondary rounded-full flex items-center justify-center mx-auto mb-4">
        <MessageSquare className="w-6 h-6 text-muted-foreground" />
      </div>
      <h3 className="font-semibold text-foreground mb-1">No texts yet</h3>
      <p className="text-sm text-muted-foreground max-w-sm mx-auto">
        When somebody texts your business number it lands here. You can also
        start one from any customer&apos;s Text button on a booking, call or
        job.
      </p>
    </div>
  );
}

function ThreadList({
  threads,
  activeId,
  onSelect,
}: {
  threads: MessageThread[];
  activeId: number | null;
  onSelect: (id: number) => void;
}) {
  return (
    <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
      <ScrollArea className="max-h-[36rem]">
        <div className="divide-y divide-border">
          {threads.map((thread) => {
            const isActive = thread.id === activeId;
            return (
              <button
                key={thread.id}
                type="button"
                onClick={() => onSelect(thread.id)}
                data-testid={`row-thread-${thread.id}`}
                className={`w-full text-left px-4 py-3 transition-colors ${
                  isActive ? "bg-secondary/70" : "hover:bg-secondary/40"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-foreground truncate">
                    {thread.customerName || formatPhone(thread.customerPhone)}
                  </span>
                  {thread.unreadCount > 0 && (
                    <span className="shrink-0 min-w-5 h-5 px-1.5 rounded-full bg-brand-pink text-white text-[11px] font-semibold inline-flex items-center justify-center">
                      {thread.unreadCount}
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground truncate mt-0.5">
                  {thread.lastDirection === "outbound" ? "You: " : ""}
                  {thread.lastMessagePreview || "No messages yet"}
                </div>
                <div className="text-[11px] text-muted-foreground/70 mt-0.5">
                  {formatDistanceToNow(new Date(thread.lastMessageAt), {
                    addSuffix: true,
                  })}
                </div>
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

function Conversation({
  threadId,
  draft,
  onDraftChange,
}: {
  threadId: number;
  draft: string;
  onDraftChange: (value: string) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const bottom = useRef<HTMLDivElement>(null);

  const { data, isLoading } = useGetMessageThread(threadId, {
    query: {
      queryKey: getGetMessageThreadQueryKey(threadId),
      refetchInterval: 10_000,
    },
  });
  const send = useSendClientMessage();

  // Opening a thread clears its unread badge on the server, so the inbox list
  // and the sidebar count both need re-reading.
  useEffect(() => {
    queryClient.invalidateQueries({
      queryKey: getListMessageThreadsQueryKey(),
    });
    queryClient.invalidateQueries({
      queryKey: getGetUnreadMessageCountQueryKey(),
    });
  }, [threadId, data?.messages.length, queryClient]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [data?.messages.length, threadId]);

  const submit = () => {
    const body = draft.trim();
    if (!body || send.isPending) return;
    send.mutate(
      { id: threadId, data: { body } },
      {
        onSuccess: () => {
          onDraftChange("");
          queryClient.invalidateQueries({
            queryKey: getGetMessageThreadQueryKey(threadId),
          });
          queryClient.invalidateQueries({
            queryKey: getListMessageThreadsQueryKey(),
          });
        },
        onError: (err: unknown) => {
          toast({
            title: "Text not sent",
            description:
              err instanceof Error
                ? err.message
                : "Quo wouldn't take that message.",
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

  const dial = telHref(data.thread.customerPhone);

  return (
    <div className="bg-card border border-border rounded-xl shadow-sm flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-secondary/40 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-foreground truncate">
            {data.thread.customerName || formatPhone(data.thread.customerPhone)}
          </div>
          <div className="text-xs text-muted-foreground tabular-nums">
            {formatPhone(data.thread.customerPhone)}
          </div>
        </div>
        {dial && (
          <Button asChild variant="outline" size="sm">
            <a href={dial} data-testid="link-call-thread">
              <Phone className="w-4 h-4" />
              Call
            </a>
          </Button>
        )}
      </div>

      <ScrollArea className="h-[26rem] p-4">
        <div className="space-y-3">
          {data.messages.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">
              Nothing sent yet. Write the first message below.
            </p>
          )}
          {data.messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
          <div ref={bottom} />
        </div>
      </ScrollArea>

      <div className="border-t border-border p-3 space-y-2">
        <Textarea
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter makes a new line — what everyone
            // expects from a message box.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Write a text…"
          rows={2}
          maxLength={1600}
          data-testid="input-message-body"
        />
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            Goes out from your business number.
          </span>
          <Button
            onClick={submit}
            disabled={!draft.trim() || send.isPending}
            className="bg-brand-pink hover:bg-brand-pink/90"
            data-testid="button-send-message"
          >
            <Send className="w-4 h-4" />
            {send.isPending ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ClientMessage }) {
  const mine = message.direction === "outbound";
  const failed = message.status === "failed";

  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div className="max-w-[80%] space-y-1">
        <div
          className={`rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap break-words ${
            failed
              ? "bg-red-500/10 text-red-200 border border-red-500/30"
              : mine
                ? "bg-brand-pink text-white"
                : "bg-secondary text-foreground"
          }`}
          data-testid={`text-message-${message.id}`}
        >
          {message.body}
        </div>
        <div
          className={`text-[11px] text-muted-foreground flex items-center gap-1 ${
            mine ? "justify-end" : ""
          }`}
        >
          {failed && <AlertTriangle className="w-3 h-3 text-red-400" />}
          {failed
            ? message.errorText || "Not delivered"
            : formatDistanceToNow(new Date(message.createdAt), {
                addSuffix: true,
              })}
          {mine && message.sentByName ? ` · ${message.sentByName}` : ""}
        </div>
      </div>
    </div>
  );
}
