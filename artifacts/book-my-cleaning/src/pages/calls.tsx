import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader, LoadingSpinner } from "@/components/ui/shared";
import {
  useListCalls,
  useGetCall,
  getGetCallQueryKey,
  useSimulateTestCall,
  useUpdateCallNotes,
  useUpdateCallTag,
  useSaveCallAsLead,
  getListCallsQueryKey,
  useGetCurrentUser,
  Call,
  TranscriptSegment,
  ExtractedAnswer,
} from "@workspace/api-client-react";
import { attentionIdentity, useCallAttention } from "@/lib/callAttention";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import {
  Phone,
  PhoneIncoming,
  Clock,
  Play,
  User,
  X,
  UserPlus,
  CheckCircle,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { PhoneActions } from "@/components/PhoneActions";
import { TagChip, TagPicker } from "@/components/TagControls";
import { CustomerTagPicker } from "@/components/CustomerTagControls";
import { formatPhone } from "@/lib/phone";
import { useToast } from "@/hooks/use-toast";

export function CallsPage() {
  const { data: calls, isLoading } = useListCalls();
  const testCall = useSimulateTestCall();
  const [selectedCallId, setSelectedCallId] = useState<number | null>(null);
  const { data: me } = useGetCurrentUser();
  const { toast } = useToast();
  // The "New" markers and the floating Live booking launcher read the same
  // shared attention store, so this list and that button can never disagree
  // about which calls still need turning into bookings. Opening a call's
  // detail is the "someone is on it" signal that clears the marker — for
  // both surfaces, everywhere, across reloads.
  const { waiting, isWaiting, markSeen, markAllSeen } = useCallAttention(
    attentionIdentity(me),
    calls,
  );

  function handleClearWaitingCalls() {
    const clearedCount = waiting.length;
    markAllSeen(waiting.map((call) => call.id));
    toast({
      title: "Waiting calls cleared",
      description: `${clearedCount} ${clearedCount === 1 ? "call" : "calls"} cleared. Your call records are unchanged.`,
    });
  }

  return (
    <AppLayout>
      <PageHeader
        title="Calls"
        description="All incoming calls handled by your AI receptionist."
      >
        <div className="flex flex-wrap items-center justify-end gap-2">
          {waiting.length > 1 && (
            <Button
              onClick={handleClearWaitingCalls}
              variant="outline"
              className="gap-2"
              aria-label="Clear all waiting calls"
              data-testid="button-calls-clear-all"
            >
              <X className="w-4 h-4" />
              Clear waiting calls ({waiting.length})
            </Button>
          )}
          <Button
            onClick={() => testCall.mutate(undefined)}
            disabled={testCall.isPending}
            variant="outline"
            className="gap-2"
          >
            <Play className="w-4 h-4" />
            {testCall.isPending ? "Simulating..." : "Test Call"}
          </Button>
        </div>
      </PageHeader>

      <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="p-8">
            <LoadingSpinner />
          </div>
        ) : !calls || calls.length === 0 ? (
          <div className="p-12 text-center">
            <div className="w-12 h-12 bg-secondary rounded-full flex items-center justify-center mx-auto mb-4">
              <Phone className="w-6 h-6 text-muted-foreground" />
            </div>
            <h3 className="font-semibold text-muted-foreground mb-1">
              No calls yet
            </h3>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              When your AI receptionist answers calls, they will appear here
              along with transcripts and booking details.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {calls.map((call: Call) => (
              <div
                key={call.id}
                onClick={() => {
                  setSelectedCallId(call.id);
                  markSeen(call.id);
                }}
                className="p-4 px-6 flex items-center justify-between hover:bg-secondary cursor-pointer transition-colors"
              >
                <div className="flex items-center gap-4">
                  <div
                    className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                      call.status === "booked"
                        ? "bg-green-500/100/10 text-green-400"
                        : call.status === "completed"
                          ? "bg-blue-100 text-blue-600"
                          : call.status === "missed"
                            ? "bg-red-500/100/10 text-red-400"
                            : "bg-secondary text-muted-foreground"
                    }`}
                  >
                    <PhoneIncoming className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="font-medium text-muted-foreground">
                      {call.callerName || formatPhone(call.callerPhone)}
                    </h4>
                    <div
                      className="mt-1 text-xs"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <PhoneActions
                        phone={call.callerPhone}
                        name={call.callerName}
                        compact
                      />
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />{" "}
                        {format(new Date(call.startedAt), "MMM d, h:mm a")}
                      </span>
                      <span>•</span>
                      <span>
                        {Math.floor(call.durationSeconds / 60)}m{" "}
                        {call.durationSeconds % 60}s
                      </span>
                      {call.isTest && (
                        <>
                          <span>•</span>
                          <span className="text-orange-600 font-medium bg-orange-100 px-2 py-0.5 rounded-full">
                            Test
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {isWaiting(call.id) && (
                    <div className="flex items-center gap-1">
                      {/* Red is the phone-call color everywhere (ring
                          banner, this marker) — texts are pink, chat is
                          purple, leads are orange. */}
                      <Badge
                        data-testid={`badge-call-new-${call.id}`}
                        className="bg-red-600 text-white border-0"
                      >
                        New
                      </Badge>
                      <button
                        type="button"
                        aria-label="Dismiss — not a booking"
                        data-testid={`button-call-dismiss-${call.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          markSeen(call.id);
                        }}
                        className="rounded-full p-0.5 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                  {/* The owner's verdict, visible while scanning the list —
                      spotting repeat spammers is the point. */}
                  <TagChip tag={call.tag} testid={`chip-tag-call-${call.id}`} />
                  <CustomerTagPicker
                    kind="call"
                    id={call.id}
                    value={call.tag}
                    testidPrefix={`button-tag-call-list-${call.id}`}
                  />
                  <CallStatusBadge status={call.status} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {selectedCallId && (
        <CallDetailModal
          callId={selectedCallId}
          open={!!selectedCallId}
          onOpenChange={(val) => !val && setSelectedCallId(null)}
        />
      )}
    </AppLayout>
  );
}

function CallStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "booked":
      return (
        <Badge className="bg-green-500/100/10 text-green-700 hover:bg-green-200 border-0">
          Booked
        </Badge>
      );
    case "completed":
      return (
        <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-200 border-0">
          Completed
        </Badge>
      );
    case "missed":
      return (
        <Badge className="bg-red-500/100/10 text-red-700 hover:bg-red-200 border-0">
          Missed
        </Badge>
      );
    case "in_progress":
      return (
        <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-200 border-0">
          Active
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export function CallDetailModal({
  callId,
  open,
  onOpenChange,
}: {
  callId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: callDetail, isLoading } = useGetCall(callId, {
    query: { enabled: open, queryKey: getGetCallQueryKey(callId) },
  });
  const [leadSaved, setLeadSaved] = useState(false);
  const [leadError, setLeadError] = useState<string | null>(null);
  const saveAsLead = useSaveCallAsLead();
  const queryClient = useQueryClient();

  // Reset state when the modal opens for a new call.
  const prevCallIdRef = useRef(callId);
  if (prevCallIdRef.current !== callId) {
    prevCallIdRef.current = callId;
    setLeadSaved(false);
    setLeadError(null);
  }

  // Whether to offer the "Save as lead" action: only for real calls without a
  // booking yet and when the lead hasn't just been saved this session.
  const canSaveAsLead =
    callDetail !== undefined &&
    !callDetail.bookingId &&
    !callDetail.isTest &&
    !leadSaved;

  function handleSaveAsLead() {
    setLeadError(null);
    saveAsLead.mutate(
      { id: callId },
      {
        onSuccess: () => {
          setLeadSaved(true);
          // Refresh the leads list so the new lead appears immediately.
          queryClient.invalidateQueries({ queryKey: getListCallsQueryKey() });
        },
        onError: (err) => {
          const msg =
            err &&
            typeof err === "object" &&
            "response" in err &&
            err.response &&
            typeof err.response === "object" &&
            "data" in err.response &&
            err.response.data &&
            typeof err.response.data === "object" &&
            "error" in err.response.data &&
            typeof err.response.data.error === "string"
              ? err.response.data.error
              : "Couldn't save lead — try again.";
          setLeadError(msg);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-0 overflow-hidden gap-0">
        <DialogHeader className="p-6 border-b border-border bg-secondary/50">
          <div className="flex items-start justify-between">
            <div>
              <DialogTitle className="text-xl">
                {isLoading
                  ? "Loading..."
                  : callDetail?.callerName ||
                    formatPhone(callDetail?.callerPhone)}
              </DialogTitle>
              <DialogDescription className="mt-1">
                {callDetail &&
                  format(
                    new Date(callDetail.startedAt),
                    "MMMM d, yyyy 'at' h:mm a",
                  )}
              </DialogDescription>
              {callDetail && (
                <div className="mt-2 text-sm">
                  <PhoneActions
                    phone={callDetail.callerPhone}
                    name={callDetail.callerName}
                  />
                </div>
              )}
            </div>
            <div className="flex flex-col items-end gap-2">
              {callDetail && <CallStatusBadge status={callDetail.status} />}
              {canSaveAsLead && (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 text-xs"
                  disabled={saveAsLead.isPending}
                  onClick={handleSaveAsLead}
                  data-testid={`button-save-as-lead-${callId}`}
                >
                  <UserPlus className="w-3.5 h-3.5" />
                  {saveAsLead.isPending ? "Saving…" : "Save as lead"}
                </Button>
              )}
              {leadSaved && (
                <Link
                  to="/leads"
                  className="flex items-center gap-1.5 text-xs text-teal-400 hover:text-teal-300 transition-colors"
                >
                  <CheckCircle className="w-3.5 h-3.5" />
                  Saved · View leads
                </Link>
              )}
              {leadError && (
                <p className="text-xs text-destructive max-w-[14rem] text-right">
                  {leadError}
                </p>
              )}
            </div>
          </div>
        </DialogHeader>

        {isLoading || !callDetail ? (
          <div className="p-12">
            <LoadingSpinner />
          </div>
        ) : (
          <div className="flex-1 overflow-hidden flex flex-col md:flex-row">
            <div className="flex-1 border-r border-border flex flex-col min-w-0">
              <div className="p-3 border-b border-border bg-secondary text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Transcript
              </div>
              <ScrollArea className="flex-1 p-4">
                <div className="space-y-4">
                  {callDetail.transcript.map(
                    (segment: TranscriptSegment, i: number) => (
                      <div
                        key={i}
                        className={`flex gap-3 ${segment.speaker === "ai" ? "flex-row-reverse" : ""}`}
                      >
                        <div
                          className={`w-8 h-8 rounded-full shrink-0 flex items-center justify-center text-xs font-bold ${
                            segment.speaker === "ai"
                              ? "bg-primary text-white"
                              : "bg-secondary text-muted-foreground"
                          }`}
                        >
                          {segment.speaker === "ai" ? (
                            "AI"
                          ) : (
                            <User className="w-4 h-4" />
                          )}
                        </div>
                        <div
                          className={`px-4 py-2 rounded-2xl max-w-[85%] text-sm ${
                            segment.speaker === "ai"
                              ? "bg-primary text-white rounded-tr-none"
                              : "bg-secondary text-muted-foreground rounded-tl-none"
                          }`}
                        >
                          {segment.text}
                        </div>
                      </div>
                    ),
                  )}
                  {callDetail.transcript.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No transcript available.
                    </p>
                  )}
                </div>
              </ScrollArea>
            </div>

            <div className="w-full md:w-64 bg-secondary/50 flex flex-col">
              <div className="p-3 border-b border-border bg-secondary text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Extracted Info
              </div>
              <ScrollArea className="flex-1 p-4">
                <div className="space-y-4">
                  {callDetail.extractedAnswers.map(
                    (answer: ExtractedAnswer, i: number) => (
                      <div key={i}>
                        <div className="text-xs font-medium text-muted-foreground mb-1">
                          {answer.field}
                        </div>
                        <div className="text-sm text-muted-foreground font-medium bg-card border border-border rounded px-2 py-1.5">
                          {answer.value}
                        </div>
                      </div>
                    ),
                  )}
                  {callDetail.extractedAnswers.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      No data extracted.
                    </p>
                  )}
                </div>
              </ScrollArea>
              <CallTagRow callId={callDetail.id} tag={callDetail.tag ?? null} />
              <CallNotesPad
                key={callDetail.id}
                callId={callDetail.id}
                initialNotes={callDetail.notes ?? ""}
              />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function CallNotesPad({
  callId,
  initialNotes,
}: {
  callId: number;
  initialNotes: string;
}) {
  const [notes, setNotes] = useState(initialNotes);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const savedRef = useRef(initialNotes);
  const notesRef = useRef(initialNotes);
  notesRef.current = notes;
  const queryClient = useQueryClient();
  const updateNotes = useUpdateCallNotes();
  // Saves are serialized: only one request is ever in flight, and when it
  // settles the latest draft is sent if it still differs. Overlapping
  // requests could be applied by the server in reverse order, silently
  // persisting stale text while the UI claims the newest note was saved.
  const inFlightRef = useRef<string | null>(null);
  const saveRef = useRef((_notes: string) => {});
  saveRef.current = (notesToSave: string) => {
    if (inFlightRef.current !== null) return; // picked up when it settles
    inFlightRef.current = notesToSave;
    updateNotes.mutate(
      { id: callId, data: { notes: notesToSave } },
      {
        onSuccess: (detail) => {
          savedRef.current = notesToSave;
          if (notesRef.current === notesToSave) setStatus("saved");
          // Merge only the notes into the cached detail. Writing the whole
          // response would let a slow notes save that settles after a tag
          // update overwrite the fresher tag with the older one it captured.
          queryClient.setQueryData(
            getGetCallQueryKey(callId),
            (old: typeof detail | undefined) =>
              old ? { ...old, notes: detail.notes } : detail,
          );
        },
        onError: () => {
          // Only report a failure for the text still on screen; a newer
          // draft is about to be attempted below.
          if (notesRef.current === notesToSave) setStatus("error");
        },
        onSettled: () => {
          inFlightRef.current = null;
          if (
            notesRef.current !== notesToSave &&
            notesRef.current !== savedRef.current
          ) {
            saveRef.current(notesRef.current);
          }
        },
      },
    );
  };

  // Autosave a moment after typing stops.
  useEffect(() => {
    if (notes === savedRef.current) return;
    setStatus("saving");
    const t = setTimeout(() => {
      saveRef.current(notes);
    }, 800);
    return () => clearTimeout(t);
  }, [notes, callId]);

  // Flush unsaved keystrokes if the window closes mid-pause.
  useEffect(() => {
    return () => {
      if (notesRef.current !== savedRef.current) {
        saveRef.current(notesRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="border-t border-border">
      <div className="p-3 border-b border-border bg-secondary text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center justify-between">
        <span>Notes</span>
        <span className="normal-case font-normal tracking-normal">
          {status === "saving" && "Saving…"}
          {status === "saved" && "Saved"}
          {status === "error" && (
            <span className="text-destructive">Couldn't save</span>
          )}
        </span>
      </div>
      <div className="p-3">
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={5}
          maxLength={20000}
          placeholder="Jot anything about this call — only your team sees it."
          className="resize-none text-sm bg-card"
        />
      </div>
    </div>
  );
}

/**
 * The tag strip in the call detail's side panel: one tap to remember the
 * verdict (client / good lead / bad lead / spam) once the call is done.
 * Tapping the active tag clears it. Saves immediately — no Save button.
 */
export function CallTagRow({
  callId,
  tag,
}: {
  callId: number;
  tag: string | null;
}) {
  const queryClient = useQueryClient();
  const updateTag = useUpdateCallTag();
  return (
    <div className="p-4 border-t border-border">
      <TagPicker
        value={tag}
        disabled={updateTag.isPending}
        testidPrefix={`button-tag-call-${callId}`}
        onSelect={(next) =>
          updateTag.mutate(
            { id: callId, data: { tag: next } },
            {
              onSuccess: (detail) => {
                // Merge only the tag into the cached detail (the notes pad
                // owns `notes` the same way — field-scoped merges mean a
                // slow save of one field can never clobber the other), then
                // refresh the list so its chip matches.
                queryClient.setQueryData(
                  getGetCallQueryKey(callId),
                  (old: typeof detail | undefined) =>
                    old ? { ...old, tag: detail.tag } : detail,
                );
                queryClient.invalidateQueries({
                  queryKey: getListCallsQueryKey(),
                });
              },
            },
          )
        }
      />
    </div>
  );
}
