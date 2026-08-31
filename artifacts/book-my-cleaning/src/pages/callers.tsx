import { useMemo, useState } from "react";
import { Link } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader, LoadingSpinner } from "@/components/ui/shared";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Search,
  Phone,
  PhoneIncoming,
  History,
  AlertCircle,
  Clock,
  User,
  CheckCircle2,
} from "lucide-react";
import {
  useListCallers,
  useListCallerCalls,
  getListCallerCallsQueryKey,
  Caller,
  Call,
} from "@workspace/api-client-react";
import { formatPhone } from "@/lib/phone";
import { format, formatDistanceToNow } from "date-fns";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CallDetailModal } from "@/pages/calls";
import { PhoneActions } from "@/components/PhoneActions";

function matchesSearch(caller: Caller, needle: string): boolean {
  const text = needle.trim().toLowerCase();
  if (!text) return true;
  if (caller.bestName && caller.bestName.toLowerCase().includes(text)) {
    return true;
  }
  const digits = text.replace(/\D/g, "");
  if (!digits) return false;
  return (
    caller.phone.replace(/\D/g, "").includes(digits) ||
    caller.phoneE164.replace(/\D/g, "").includes(digits)
  );
}

export function CallersPage() {
  const { data: callers, isLoading, isError } = useListCallers();
  const [search, setSearch] = useState("");
  const [selectedCallerId, setSelectedCallerId] = useState<number | null>(null);

  const visible = useMemo(
    () => (callers ?? []).filter((c) => matchesSearch(c, search)),
    [callers, search],
  );

  return (
    <AppLayout>
      <PageHeader
        title="Callers"
        description="Searchable history of every external phone number that has called your business."
      />

      <div className="relative mb-6 max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search callers by name or phone..."
          className="pl-9"
          aria-label="Search callers"
        />
      </div>

      <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="p-8">
            <LoadingSpinner />
          </div>
        ) : isError ? (
          <div className="p-8">
            <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-4">
              <AlertCircle className="h-4 w-4 shrink-0" />
              We couldn't load the callers list. Refresh to try again.
            </div>
          </div>
        ) : visible.length === 0 ? (
          <div className="p-12 text-center">
            <div className="w-12 h-12 bg-secondary rounded-full flex items-center justify-center mx-auto mb-4">
              <History className="w-6 h-6 text-muted-foreground" />
            </div>
            <h3 className="font-semibold text-muted-foreground mb-1">
              {search.trim()
                ? `No callers match "${search.trim()}"`
                : "No callers yet"}
            </h3>
            {!search.trim() && (
              <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                Valid external numbers appear here after a real call is synced
                from Quo.
              </p>
            )}
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {visible.map((caller) => (
              <div
                key={caller.id}
                onClick={() => setSelectedCallerId(caller.id)}
                data-testid={`row-caller-${caller.id}`}
                className="p-4 px-6 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between hover:bg-secondary cursor-pointer transition-colors"
              >
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-10 h-10 rounded-full bg-secondary text-muted-foreground flex items-center justify-center shrink-0">
                    <User className="w-5 h-5" />
                  </div>
                  <div>
                    <h4 className="font-medium text-foreground">
                      {caller.bestName}
                    </h4>
                    <div className="flex items-center gap-3 text-sm text-muted-foreground mt-0.5">
                      <span className="flex items-center gap-1">
                        <Phone className="w-3.5 h-3.5" />
                        {formatPhone(caller.phone)}
                      </span>
                      {caller.knownClient && (
                        <Link
                          href={`/clients?search=${encodeURIComponent(caller.phoneE164)}`}
                          onClick={(event) => event.stopPropagation()}
                          className="flex items-center gap-1 text-emerald-300 bg-emerald-500/10 px-1.5 py-0.5 rounded-sm text-xs font-medium border border-emerald-500/20 hover:bg-emerald-500/20"
                          aria-label={`Open ${caller.bestName} in Clients`}
                        >
                          <CheckCircle2 className="w-3 h-3" />
                          Client
                        </Link>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex flex-row items-center justify-between gap-3 pl-14 sm:pl-0 sm:flex-col sm:items-end sm:justify-start">
                  <div className="text-sm font-medium text-foreground">
                    {caller.callCount}{" "}
                    {caller.callCount === 1 ? "call" : "calls"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Latest:{" "}
                    {formatDistanceToNow(new Date(caller.latestCallAt), {
                      addSuffix: true,
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {selectedCallerId && (
        <CallerHistoryModal
          callerId={selectedCallerId}
          open={!!selectedCallerId}
          onOpenChange={(open) => !open && setSelectedCallerId(null)}
        />
      )}
    </AppLayout>
  );
}

function CallerHistoryModal({
  callerId,
  open,
  onOpenChange,
}: {
  callerId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: calls, isLoading } = useListCallerCalls(callerId, {
    query: { enabled: open, queryKey: getListCallerCallsQueryKey(callerId) },
  });
  const [selectedCallId, setSelectedCallId] = useState<number | null>(null);

  const callerBestName =
    calls?.[0]?.callerName ||
    (calls && calls.length > 0 ? formatPhone(calls[0].callerPhone) : "Caller");
  const callerPhone = calls?.[0]?.callerPhone;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-0 overflow-hidden gap-0">
          <DialogHeader className="p-6 border-b border-border bg-secondary/50">
            <div className="flex items-start justify-between">
              <div>
                <DialogTitle className="text-xl">
                  {isLoading ? "Loading caller..." : callerBestName}
                </DialogTitle>
                <DialogDescription className="mt-1 flex items-center gap-2">
                  <History className="w-4 h-4" />
                  Call History
                </DialogDescription>
                {callerPhone && (
                  <div className="mt-2 text-sm">
                    <PhoneActions phone={callerPhone} name={callerBestName} />
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-muted-foreground">
                  {calls?.length ?? 0} {calls?.length === 1 ? "Call" : "Calls"}
                </Badge>
              </div>
            </div>
          </DialogHeader>

          {isLoading ? (
            <div className="p-12">
              <LoadingSpinner />
            </div>
          ) : !calls || calls.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground">
              No calls found for this caller.
            </div>
          ) : (
            <ScrollArea className="flex-1">
              <div className="divide-y divide-gray-100">
                {calls.map((call: Call) => (
                  <div
                    key={call.id}
                    onClick={() => setSelectedCallId(call.id)}
                    data-testid={`row-caller-call-${call.id}`}
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
                        <div className="font-medium text-foreground">
                          {format(new Date(call.startedAt), "MMM d, yyyy")}
                        </div>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />{" "}
                            {format(new Date(call.startedAt), "h:mm a")}
                          </span>
                          <span>•</span>
                          <span>
                            {Math.floor(call.durationSeconds / 60)}m{" "}
                            {call.durationSeconds % 60}s
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <CallStatusBadge status={call.status} />
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </DialogContent>
      </Dialog>

      {/* Render the full CallDetailModal on top when a call is clicked */}
      {selectedCallId && (
        <CallDetailModal
          callId={selectedCallId}
          open={!!selectedCallId}
          onOpenChange={(val) => !val && setSelectedCallId(null)}
        />
      )}
    </>
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
