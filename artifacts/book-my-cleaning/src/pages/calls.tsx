import { useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader, LoadingSpinner } from "@/components/ui/shared";
import {
  useListCalls,
  useGetCall,
  getGetCallQueryKey,
  useSimulateTestCall,
  Call,
  TranscriptSegment,
  ExtractedAnswer,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { Phone, PhoneIncoming, Clock, Play, User } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";

export function CallsPage() {
  const { data: calls, isLoading } = useListCalls();
  const testCall = useSimulateTestCall();
  const [selectedCallId, setSelectedCallId] = useState<number | null>(null);

  return (
    <AppLayout>
      <PageHeader
        title="Calls"
        description="All incoming calls handled by your AI receptionist."
      >
        <Button
          onClick={() => testCall.mutate(undefined)}
          disabled={testCall.isPending}
          variant="outline"
          className="gap-2"
        >
          <Play className="w-4 h-4" />
          {testCall.isPending ? "Simulating..." : "Test Call"}
        </Button>
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
                onClick={() => setSelectedCallId(call.id)}
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
                      {call.callerName || call.callerPhone}
                    </h4>
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
                <div>
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

function CallDetailModal({
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-0 overflow-hidden gap-0">
        <DialogHeader className="p-6 border-b border-border bg-secondary/50">
          <div className="flex items-start justify-between">
            <div>
              <DialogTitle className="text-xl">
                {isLoading
                  ? "Loading..."
                  : callDetail?.callerName || callDetail?.callerPhone}
              </DialogTitle>
              <DialogDescription className="mt-1">
                {callDetail &&
                  format(
                    new Date(callDetail.startedAt),
                    "MMMM d, yyyy 'at' h:mm a",
                  )}
              </DialogDescription>
            </div>
            {callDetail && <CallStatusBadge status={callDetail.status} />}
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
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
