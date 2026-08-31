import { useEffect, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PanelErrorBoundary } from "@/components/PanelErrorBoundary";
import { JobTimerPanel } from "@/components/JobTimerPanel";
import { PageHeader, LoadingSpinner } from "@/components/ui/shared";
import { JobberSyncButton } from "@/components/JobberSyncButton";
import {
  useListBookings,
  useUpdateBooking,
  useCreateBooking,
  useSyncBookingToJobber,
  useCreateBookingInvoice,
  useApproveBooking,
  useGetCompany,
  useGetQuotePreview,
  useSendQuote,
  useSetBookingCrew,
  useListTeamMembers,
  useGetCurrentUser,
  useListServices,
  getListBookingsQueryKey,
  getGetQuotePreviewQueryKey,
  Booking,
  missingBookingFields,
  isBookingFieldRequired,
  bookingDisplayName,
  type BookingFormFieldKey,
} from "@workspace/api-client-react";
import { Link, useLocation, useSearch } from "wouter";
import { mapFocusHref } from "@/lib/mapFocus";
import { zonedDayKey } from "@/lib/mapCalendar";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatDistanceToNow } from "date-fns";
import { PhoneActions } from "@/components/PhoneActions";
import { BookingJobberRetryStatus } from "@/components/BookingJobberRetryStatus";
import {
  companyTimeZone,
  defaultScheduledFor,
  formatZoned,
  isoToZonedInput,
  zonedInputToIso,
  zoneLabel,
} from "@/lib/time";
import { invoiceOpenTarget } from "@/lib/jobberInvoice";
import {
  Calendar,
  MapPin,
  Phone,
  User,
  MoreHorizontal,
  RefreshCw,
  ExternalLink,
  AlertCircle,
  Plus,
  MessageSquareText,
  Pencil,
  DollarSign,
  ThumbsUp,
  Users,
  Receipt,
  CalendarCheck,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import {
  QuoteCalculator,
  emptyQuoteDraft,
  type QuoteDraft,
} from "@/components/QuoteCalculator";
import { companyQuoteRates } from "@/lib/rates";
import { exactServicePrice } from "@/lib/servicePricing";
import {
  messageContainsQuotePrice,
  quotedPriceAnchor,
} from "@workspace/pricing";
import {
  BookingDetailDialog,
  BookingBadges,
  BookingPrice,
  CrewChecklist,
  assignableCrew,
  formatMoney,
  hasQuotePrice,
  type BookingDetailMode,
  type QuoteEntryMode,
} from "@/components/BookingDetailDialog";
import {
  CustomerTagChip,
  CustomerTagPicker,
} from "@/components/CustomerTagControls";
import {
  clientApproved,
  awaitingJobberSchedule,
  needsAcceptance,
  scheduleBlockedReason,
  bookingQueue,
  type BookingQueue,
} from "@/lib/bookingAcceptance";
import {
  collapseRecurringBookings,
  isRecurringBooking,
} from "@/lib/recurringBookings";
import { AddressPlacementWarning } from "@/components/AddressPlacementWarning";

// Re-exported for callers that treat this page as the home of booking rules.
export { clientApproved, scheduleBlockedReason };

type BookingStatus = "pending" | "confirmed" | "completed" | "canceled";

/**
 * The day this list starts, in the words the page uses everywhere.
 *
 * The server enforces the same floor (in the company's own timezone);
 * everything before it is Jobber-era history and is looked up in Jobber.
 */
const HISTORY_FLOOR_LABEL = "August 1, 2026";
/** ISO date of the history floor — must match the server's `BOOKING_HISTORY_FLOOR_DATE`. */
const HISTORY_FLOOR_ISO = "2026-08-01";

/**
 * The default lookback window for the bookings list: the later of the history
 * floor and 90 days ago. When the list is young this equals the history floor
 * so all bookings appear; as years of data accumulate it limits the initial
 * fetch to the last 90 days and a "Load older" affordance reveals the rest.
 */
function defaultBookingsSince(): string {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return ninetyDaysAgo > HISTORY_FLOOR_ISO ? ninetyDaysAgo : HISTORY_FLOOR_ISO;
}

function formatRate(rate: number): string {
  return `${Number(rate.toFixed(2))}%`;
}

/**
 * Pick the crew for one job. The whole crew is submitted at once — the API
 * replaces the assignment list — so a half-saved crew is not a state the
 * schedule can end up in.
 */
function AssignCrewDialog({
  booking,
  onClose,
}: {
  booking: Booking | null;
  onClose: () => void;
}) {
  const { data: team } = useListTeamMembers();
  const setCrew = useSetBookingCrew();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [selected, setSelected] = useState<number[]>([]);

  // Reset to whoever is currently on the job each time the dialog opens, so
  // an abandoned edit never leaks into the next booking.
  useEffect(() => {
    setSelected(booking ? (booking.crew ?? []).map((c) => c.id) : []);
  }, [booking]);

  const assignable = assignableCrew(team, selected);

  const toggle = (id: number) =>
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  const handleSave = () => {
    if (!booking) return;
    setCrew.mutate(
      { id: booking.id, data: { teamMemberIds: selected } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListBookingsQueryKey(),
          });
          toast({
            title: selected.length > 0 ? "Crew assigned" : "Crew cleared",
            description:
              selected.length > 0
                ? `${selected.length} ${selected.length === 1 ? "person" : "people"} on ${bookingDisplayName(booking)}'s job.`
                : `Nobody is assigned to ${bookingDisplayName(booking)}'s job.`,
          });
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open={booking !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign crew</DialogTitle>
          <DialogDescription>
            Choose everyone working{" "}
            {booking ? bookingDisplayName(booking) : "this"}&apos;s job. They
            will see it on their own schedule.
          </DialogDescription>
        </DialogHeader>

        {assignable.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            You haven&apos;t added any cleaners yet. Invite them from the Team
            page first.
          </p>
        ) : (
          <CrewChecklist
            members={assignable}
            selected={selected}
            onToggle={toggle}
          />
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={setCrew.isPending || assignable.length === 0}
          >
            {setCrew.isPending ? "Saving..." : "Save crew"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function BookingsPage() {
  // Default to a 90-day lookback window (or the history floor, whichever is
  // later). As years of data accumulate this keeps the initial fetch fast;
  // the "Load older" button below reveals bookings outside the window.
  const [showAll, setShowAll] = useState(false);
  const [showAllRecurring, setShowAllRecurring] = useState(false);
  const [queueFilter, setQueueFilter] = useState<"unscheduled" | BookingQueue>(
    "unscheduled",
  );
  const bookingsParams = showAll
    ? { since: HISTORY_FLOOR_ISO }
    : { since: defaultBookingsSince() };
  const { data: bookings, isLoading } = useListBookings(bookingsParams);
  const { data: me } = useGetCurrentUser();
  // Cleaners get a read-mostly view of their own jobs: no quoting, no
  // reassigning, no Jobber. The API enforces the same thing. Their work is
  // already scheduled, so never hide it behind the office dispatch queues.
  const canDispatch = (me?.role ?? "owner") !== "cleaner";
  const queueCounts = {
    unscheduled:
      bookings?.filter((booking) => {
        const queue = bookingQueue(booking);
        return queue === "awaiting_response" || queue === "approved";
      }).length ?? 0,
    awaiting_response:
      bookings?.filter(
        (booking) => bookingQueue(booking) === "awaiting_response",
      ).length ?? 0,
    approved:
      bookings?.filter((booking) => bookingQueue(booking) === "approved")
        .length ?? 0,
    scheduled:
      bookings?.filter((booking) => bookingQueue(booking) === "scheduled")
        .length ?? 0,
  };
  const queueBookings = canDispatch
    ? (bookings ?? []).filter((booking) => {
        const queue = bookingQueue(booking);
        return queueFilter === "unscheduled"
          ? queue === "awaiting_response" || queue === "approved"
          : queue === queueFilter;
      })
    : (bookings ?? []);
  const recurringDisplay = collapseRecurringBookings(
    queueBookings,
    showAllRecurring,
  );
  const visibleBookings = recurringDisplay.bookings;
  // The window is narrower than the history floor only once ≥90 days of
  // bookings exist; show the "Load older" button only at that point.
  const hasOlderWindow = defaultBookingsSince() > HISTORY_FLOOR_ISO;
  const [crewBooking, setCrewBooking] = useState<Booking | null>(null);
  // The click-the-card detail view. Only the id is stored; the booking itself
  // is re-derived from the live list on every render, so the dialog reflects
  // each mutation (accept, crew change, invoice) without its own fetch.
  const [detail, setDetail] = useState<{
    id: number;
    mode: BookingDetailMode;
  } | null>(null);
  const detailBooking = detail
    ? ((bookings ?? []).find((b: Booking) => b.id === detail.id) ?? null)
    : null;
  const { data: company } = useGetCompany();
  const jobberConnected = Boolean(company?.jobberConnected);
  const jobberNeedsReauth = Boolean(company?.jobberNeedsReauth);
  // Everything on this page is shown in the company's own time, not the
  // browser's, so what a dispatcher sees matches what the customer is texted.
  const timeZone = companyTimeZone(company);
  const updateBooking = useUpdateBooking();
  const syncJobber = useSyncBookingToJobber();
  const createInvoice = useCreateBookingInvoice();
  const approve = useApproveBooking();

  /** Record a yes locally, or explicitly schedule an already-approved quote. */
  const handleApprove = (booking: Booking, schedule: boolean) => {
    approve.mutate(
      { id: booking.id, data: { schedule } },
      {
        onSuccess: (result: any) => {
          queryClient.invalidateQueries({
            queryKey: getListBookingsQueryKey(),
          });
          const unmatched: string[] = result?.unmatchedCrew ?? [];
          if (result?.jobberError) {
            toast({
              title: "Jobber didn't schedule it",
              description: `${result.jobberError} The existing approval is unchanged; retry from this booking.`,
              variant: "destructive",
            });
            return;
          }
          if (schedule && result?.scheduledInJobber) {
            toast({
              title: "Scheduled in Jobber",
              description:
                unmatched.length > 0
                  ? `The job is on the Jobber calendar, but ${unmatched.join(", ")} couldn't be matched to a Jobber user — the visit went out without them. Match their name in Jobber and reassign the crew.`
                  : "The job is on the Jobber calendar at this booking's time.",
            });
            return;
          }
          toast({
            title: result?.recorded ? "Approval recorded" : "Already approved",
            description: `${bookingDisplayName(booking)} is confirmed.`,
          });
        },
        onError: (err: any) => {
          toast({
            title: schedule
              ? "Could not schedule in Jobber"
              : "Could not record the approval",
            description: err?.data?.error || err?.message || "Try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleCreateInvoice = (booking: Booking) => {
    createInvoice.mutate(
      { id: booking.id },
      {
        onSuccess: (updated: any) => {
          queryClient.invalidateQueries({
            queryKey: getListBookingsQueryKey(),
          });
          toast({
            title: "Invoice created in Jobber",
            description: updated.jobberInvoiceNumber
              ? `Invoice #${updated.jobberInvoiceNumber} is waiting in Jobber — review and send it from there.`
              : "The invoice is waiting in Jobber — review and send it from there.",
          });
        },
        onError: (err: any) => {
          toast({
            title: "Could not create the invoice",
            description: err?.data?.error || err?.message || "Try again.",
            variant: "destructive",
          });
        },
      },
    );
  };
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [formBooking, setFormBooking] = useState<Booking | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  // The quote dialog target: only the id is stored (like the detail view),
  // so the dialog reads the live booking after each save — the "no price
  // yet" notice and totals stay honest without a reopen. The mode decides
  // whether it opens ready to price (calculator expanded) or ready to send.
  const [quoteEntry, setQuoteEntry] = useState<{
    id: number;
    mode: QuoteEntryMode;
  } | null>(null);
  const quoteEntryBooking = quoteEntry
    ? ((bookings ?? []).find((b: Booking) => b.id === quoteEntry.id) ?? null)
    : null;

  // Deep links land here as /bookings#booking-<id> (dashboard activity feed,
  // schedule/map detail panels). Once the list has rendered, scroll the target
  // card into view and flash it so the dispatcher's eye lands on the right job.
  const [highlightId, setHighlightId] = useState<number | null>(null);
  // A link to a job the list doesn't hold is almost always a pre-cutoff job,
  // so say where it went instead of silently doing nothing.
  const [missingId, setMissingId] = useState<number | null>(null);
  useEffect(() => {
    if (isLoading) return;
    const match = /^#booking-(\d+)$/.exec(window.location.hash);
    if (!match) return;
    const id = Number(match[1]);
    const target = (bookings ?? []).find((booking) => booking.id === id);
    if (!target) {
      setMissingId(id);
      return;
    }
    // Calendar/map deep links often target an actual scheduled appointment.
    // Move to that queue first; otherwise the card exists in data but remains
    // hidden under the default Unscheduled view.
    const targetFilter =
      bookingQueue(target) === "scheduled" ? "scheduled" : "unscheduled";
    if (canDispatch && queueFilter !== targetFilter) {
      setQueueFilter(targetFilter);
      return;
    }
    if (isRecurringBooking(target) && !showAllRecurring) {
      setShowAllRecurring(true);
      return;
    }
    const el = document.getElementById(`booking-${id}`);
    if (!el) {
      return;
    }
    setMissingId(null);
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightId(id);
    const timer = setTimeout(() => setHighlightId(null), 2500);
    return () => clearTimeout(timer);
  }, [isLoading, bookings, queueFilter, canDispatch, showAllRecurring]);

  // "Create quote" from the Leads page ends here: the New Booking page saves
  // and arrives at /bookings?quote=<id>, and this opens the "Text a quote"
  // dialog on that booking so the send happens in the same motion — no
  // hunting the list for the row that was just made. The param is stripped
  // right away so a refresh (or closing the dialog) doesn't reopen it.
  const searchString = useSearch();
  const [, navigateTo] = useLocation();
  useEffect(() => {
    if (isLoading) return;
    const raw = new URLSearchParams(searchString).get("quote");
    if (!raw) return;
    const id = Number(raw);
    navigateTo("/bookings", { replace: true });
    if (!Number.isInteger(id) || id <= 0) return;
    const target = (bookings ?? []).find((b) => b.id === id);
    if (target) {
      setQuoteEntry({ id: target.id, mode: "send" });
    } else {
      // Same "that job isn't in this list" banner the hash deep-link uses.
      setMissingId(id);
    }
  }, [isLoading, bookings, searchString]);

  const handleStatusChange = (id: number, status: BookingStatus) => {
    updateBooking.mutate(
      { id, data: { status } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListBookingsQueryKey(),
          });
          toast({
            title: "Status updated",
            description: `Booking marked as ${status}.`,
          });
        },
      },
    );
  };

  /**
   * Completing a job is the moment the office invoices it — so one click
   * does both: flip the status, make sure the Jobber invoice exists (the
   * server refuses to mint duplicates), and open it in Jobber ready to
   * send. The tab is opened synchronously so the browser treats it as part
   * of the click, then pointed at the invoice once we know where it lives.
   */
  const handleMarkCompleted = (booking: Booking) => {
    const willInvoice =
      canDispatch &&
      jobberConnected &&
      Boolean(booking.jobberClientId) &&
      (booking.quotedAmount ?? 0) > 0;
    if (!willInvoice) {
      handleStatusChange(booking.id, "completed");
      return;
    }
    const win = window.open("", "_blank");
    // Point the pre-opened tab somewhere useful and report what that was —
    // the toast must never claim "invoice open" when the best we had was
    // the job page.
    const openForSend = (b: Booking) => {
      const target = invoiceOpenTarget(b);
      if (win && target) win.location.href = target.url;
      else win?.close();
      return target;
    };
    updateBooking.mutate(
      { id: booking.id, data: { status: "completed" } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListBookingsQueryKey(),
          });
          if (booking.jobberInvoiceId) {
            // Already invoiced once — don't mint another, just reopen it.
            const target = openForSend(booking);
            const n = booking.jobberInvoiceNumber;
            toast({
              title: "Marked completed",
              description:
                target?.kind === "invoice"
                  ? `Invoice ${n ? `#${n} ` : ""}is open in the other tab — send it from Jobber.`
                  : target
                    ? `Opened the Jobber job in the other tab — invoice ${n ? `#${n} ` : ""}is on it.`
                    : `This job already has invoice ${n ? `#${n} ` : ""}in Jobber — open it there to send it.`,
            });
            return;
          }
          createInvoice.mutate(
            { id: booking.id },
            {
              onSuccess: (updated: Booking) => {
                queryClient.invalidateQueries({
                  queryKey: getListBookingsQueryKey(),
                });
                const target = openForSend(updated);
                const n = updated.jobberInvoiceNumber;
                toast({
                  title: "Completed & invoiced",
                  description:
                    target?.kind === "invoice"
                      ? `Invoice ${n ? `#${n} ` : ""}is open in the other tab — review and send it.`
                      : target
                        ? `Invoice ${n ? `#${n} ` : ""}was created, but its direct link wasn't available — the Jobber job page is open instead, and the invoice is on it.`
                        : `Invoice ${n ? `#${n} ` : ""}was created in Jobber — open it there to review and send it.`,
                });
              },
              onError: (err: any) => {
                win?.close();
                toast({
                  title: "Completed, but the invoice didn't get made",
                  description:
                    err?.data?.error ||
                    err?.message ||
                    "Create it from this booking's menu when you're ready.",
                  variant: "destructive",
                });
              },
            },
          );
        },
        onError: (err: any) => {
          win?.close();
          toast({
            title: "Could not update the booking",
            description: err?.data?.error || err?.message || "Try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleSync = (id: number) => {
    syncJobber.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListBookingsQueryKey(),
          });
          toast({
            title: "Synced to Jobber",
            description:
              "Client and work request created in your Jobber account.",
          });
        },
        onError: (error: any) => {
          // Refetch so the persisted sync error shows inline on the card.
          queryClient.invalidateQueries({
            queryKey: getListBookingsQueryKey(),
          });
          toast({
            title: "Jobber sync failed",
            description:
              error?.message ||
              "Could not create the job in Jobber. Try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const openNew = () => {
    setFormBooking(null);
    setFormOpen(true);
  };

  const openEdit = (booking: Booking) => {
    setFormBooking(booking);
    setFormOpen(true);
  };

  return (
    <AppLayout>
      <PageHeader
        title={canDispatch ? "Unscheduled" : "My Jobs"}
        description={[
          jobberConnected
            ? "Quotes and approved cleans that still need a response or a scheduled appointment."
            : "Quotes and approved cleans waiting for the next step.",
          // Where the missing years went. Only the office looks jobs up in
          // Jobber — a cleaner has no login there, so pointing them at it
          // would just be a dead end.
          canDispatch
            ? `This list starts ${HISTORY_FLOOR_LABEL} — look up anything earlier in Jobber.`
            : null,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {canDispatch && (
          <div className="flex flex-wrap items-center gap-2">
            {/* Pulling from Jobber writes bookings, so it stays with the
                people allowed to change the schedule. */}
            <JobberSyncButton
              connected={jobberConnected}
              needsReauth={jobberNeedsReauth}
              connectHint="Connect Jobber to pull your scheduled jobs into this list."
              onSynced={() => {
                queryClient.invalidateQueries({
                  queryKey: getListBookingsQueryKey(),
                });
              }}
            />
            <Button onClick={openNew} className="gap-2">
              <Plus className="w-4 h-4" /> Add booking
            </Button>
          </div>
        )}
      </PageHeader>

      {canDispatch && (
        <div
          className="mb-4 flex flex-wrap gap-2"
          aria-label="Booking stage"
          data-testid="booking-queue-filters"
        >
          {(
            [
              ["unscheduled", "Unscheduled"],
              ["awaiting_response", "Quotes awaiting response"],
              ["approved", "Approved"],
              ["scheduled", "Scheduled"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              variant={queueFilter === value ? "default" : "outline"}
              size="sm"
              onClick={() => setQueueFilter(value)}
              data-testid={`button-queue-${value}`}
            >
              {label}{" "}
              <span className="ml-1 opacity-70">{queueCounts[value]}</span>
            </Button>
          ))}
        </div>
      )}

      {missingId !== null && (
        <div
          className="mb-4 flex items-start gap-2 rounded-lg border border-border bg-secondary/50 px-4 py-3 text-sm text-muted-foreground"
          data-testid="pre-cutoff-notice"
        >
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            That job isn't in this list — it was scheduled before{" "}
            {HISTORY_FLOOR_LABEL}. Look it up in Jobber.
          </span>
        </div>
      )}

      {/* "Load older" affordance — only shown once 90+ days of bookings exist
          and the default window is hiding some of them. */}
      {hasOlderWindow && !showAll && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-border bg-secondary/40 px-4 py-3 text-sm text-muted-foreground">
          <Calendar className="w-4 h-4 shrink-0" />
          <span className="flex-1">
            Showing the last 90 days. Some older bookings may not be listed.
          </span>
          <Button
            variant="outline"
            size="sm"
            data-testid="button-show-all-bookings"
            onClick={() => setShowAll(true)}
          >
            Load all from {HISTORY_FLOOR_LABEL}
          </Button>
        </div>
      )}

      {recurringDisplay.groupCount > 0 && (
        <div
          className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-brand-blue/20 bg-brand-blue/5 px-4 py-3 text-sm"
          data-testid="recurring-cleans-summary"
        >
          <CalendarCheck className="h-4 w-4 shrink-0 text-brand-blue" />
          <span className="flex-1 text-muted-foreground">
            <strong className="text-foreground">Recurring cleans</strong>
            {" — showing the next scheduled clean for each customer."}
          </span>
          <Button
            variant="outline"
            size="sm"
            data-testid="button-toggle-recurring-cleans"
            onClick={() => setShowAllRecurring((current) => !current)}
          >
            {showAllRecurring
              ? "Show next scheduled only"
              : `Open all recurring cleans${recurringDisplay.hiddenCount > 0 ? ` (${recurringDisplay.hiddenCount} more)` : ""}`}
          </Button>
        </div>
      )}

      <PanelErrorBoundary label="bookings list">
        {isLoading ? (
          <LoadingSpinner className="mt-20" />
        ) : !bookings || bookings.length === 0 ? (
          // An empty list here usually isn't "no bookings ever" — the list
          // starts at the history floor, so anything older is sitting in
          // Jobber. Say that rather than implying a brand-new business.
          <div
            className="bg-card border border-border rounded-xl shadow-sm p-12 text-center"
            data-testid="empty-bookings"
          >
            <div className="w-12 h-12 bg-secondary rounded-full flex items-center justify-center mx-auto mb-4">
              <Calendar className="w-6 h-6 text-muted-foreground" />
            </div>
            <h3 className="font-semibold text-muted-foreground mb-1">
              No bookings from {HISTORY_FLOOR_LABEL} onward
            </h3>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto mb-5">
              This list starts {HISTORY_FLOOR_LABEL} — jobs scheduled before
              that date live in Jobber. New bookings from your AI receptionist
              show up here, or add one yourself.
            </p>
            <Button onClick={openNew} variant="outline" className="gap-2">
              <Plus className="w-4 h-4" /> Add a booking
            </Button>
          </div>
        ) : visibleBookings.length === 0 ? (
          <div
            className="bg-card border border-border rounded-xl shadow-sm p-12 text-center"
            data-testid="empty-booking-queue"
          >
            <h3 className="font-semibold text-muted-foreground mb-1">
              Nothing in this queue
            </h3>
            <p className="text-sm text-muted-foreground">
              Choose another stage above to see the rest of the work.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {visibleBookings.map((booking: Booking) => (
              <div
                key={booking.id}
                id={`booking-${booking.id}`}
                data-testid={`card-booking-${booking.id}`}
                onClick={(e) => {
                  // The whole card opens the detail view — except when the
                  // click was really for something interactive inside it
                  // (kebab menu, links, buttons keep their own behavior).
                  const target = e.target as HTMLElement;
                  if (
                    target.closest(
                      "button, a, input, textarea, [role='menu'], [role='menuitem']",
                    )
                  )
                    return;
                  setDetail({ id: booking.id, mode: "detail" });
                }}
                className={`bg-card border rounded-xl p-5 shadow-sm hover:shadow-md transition-all flex flex-col cursor-pointer ${
                  highlightId === booking.id
                    ? "border-brand-blue ring-2 ring-brand-blue/40"
                    : canDispatch && needsAcceptance(booking)
                      ? // Waiting on the office — tinted so pending work is
                        // visible from across the room, matching the card's
                        // Accept button.
                        "border-amber-500/50"
                      : "border-border"
                }`}
              >
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h3 className="font-bold text-lg text-foreground">
                      {bookingDisplayName(booking)}
                    </h3>
                    <CustomerTagChip
                      tag={booking.tag}
                      testid={`chip-tag-booking-${booking.id}`}
                    />
                    <BookingBadges booking={booking} />
                    {isRecurringBooking(booking) && (
                      <span className="mt-1 inline-flex text-xs font-medium text-brand-blue">
                        Recurring clean
                      </span>
                    )}
                  </div>
                  <CustomerTagPicker
                    kind="booking"
                    id={booking.id}
                    value={booking.tag}
                    testidPrefix={`button-tag-booking-${booking.id}`}
                  />
                  <div className="flex items-center gap-2">
                    <BookingPrice booking={booking} />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-foreground"
                        >
                          <MoreHorizontal className="w-4 h-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {canDispatch && (
                          <>
                            <DropdownMenuItem onClick={() => openEdit(booking)}>
                              <Pencil className="w-4 h-4 mr-2" /> Edit &amp;
                              reschedule
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => setCrewBooking(booking)}
                            >
                              <Users className="w-4 h-4 mr-2" /> Assign crew
                            </DropdownMenuItem>
                          </>
                        )}
                        {canDispatch &&
                          booking.jobberClientId &&
                          !booking.jobberInvoiceId && (
                            <DropdownMenuItem
                              onClick={() => handleCreateInvoice(booking)}
                              disabled={createInvoice.isPending}
                              data-testid={`menu-create-invoice-${booking.id}`}
                            >
                              <Receipt className="w-4 h-4 mr-2" /> Create
                              invoice in Jobber
                            </DropdownMenuItem>
                          )}
                        {canDispatch &&
                          booking.jobberInvoiceNumber &&
                          (() => {
                            // Label honestly: "open invoice" only when the
                            // link really is the invoice, not the job page.
                            const target = invoiceOpenTarget(booking);
                            if (!target) {
                              return (
                                <DropdownMenuItem disabled>
                                  <Receipt className="w-4 h-4 mr-2" /> Invoiced
                                  — #{booking.jobberInvoiceNumber}
                                </DropdownMenuItem>
                              );
                            }
                            return (
                              <DropdownMenuItem
                                onClick={() =>
                                  window.open(target.url, "_blank")
                                }
                                data-testid={`menu-open-invoice-${booking.id}`}
                              >
                                <Receipt className="w-4 h-4 mr-2" />
                                {target.kind === "invoice" ? (
                                  <>
                                    Open invoice #{booking.jobberInvoiceNumber}{" "}
                                    in Jobber
                                  </>
                                ) : (
                                  <>
                                    Invoice #{booking.jobberInvoiceNumber} —
                                    open job in Jobber
                                  </>
                                )}
                              </DropdownMenuItem>
                            );
                          })()}
                        <DropdownMenuSeparator />
                        {/* Approval is how a booking becomes confirmed now —
                            there is no "mark confirmed" any more, because the
                            word means the client said yes. */}
                        {canDispatch &&
                          booking.status !== "canceled" &&
                          (() => {
                            const blocked = scheduleBlockedReason(
                              booking,
                              jobberConnected,
                              jobberNeedsReauth,
                            );
                            return (
                              <>
                                {!clientApproved(booking) && (
                                  <DropdownMenuItem
                                    onClick={() =>
                                      handleApprove(booking, false)
                                    }
                                    disabled={approve.isPending}
                                    data-testid={`menu-approve-${booking.id}`}
                                  >
                                    <ThumbsUp className="w-4 h-4 mr-2" />{" "}
                                    Approve — client said yes
                                  </DropdownMenuItem>
                                )}
                                {clientApproved(booking) &&
                                  !booking.jobberCreatedJobId &&
                                  (blocked ? (
                                    <DropdownMenuItem
                                      disabled
                                      data-testid={`menu-approve-schedule-${booking.id}`}
                                    >
                                      <CalendarCheck className="w-4 h-4 mr-2" />{" "}
                                      Schedule in Jobber — {blocked}
                                    </DropdownMenuItem>
                                  ) : (
                                    <DropdownMenuItem
                                      onClick={() =>
                                        handleApprove(booking, true)
                                      }
                                      disabled={approve.isPending}
                                      data-testid={`menu-approve-schedule-${booking.id}`}
                                    >
                                      <CalendarCheck className="w-4 h-4 mr-2" />{" "}
                                      Schedule in Jobber
                                    </DropdownMenuItem>
                                  ))}
                                <DropdownMenuSeparator />
                              </>
                            );
                          })()}
                        {booking.status !== "completed" ? (
                          <DropdownMenuItem
                            onClick={() => handleMarkCompleted(booking)}
                            data-testid={`menu-mark-completed-${booking.id}`}
                          >
                            Mark Completed
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            onClick={() =>
                              // Back to whatever it honestly was: confirmed
                              // only if the client's approval is on record.
                              handleStatusChange(
                                booking.id,
                                clientApproved(booking)
                                  ? "confirmed"
                                  : "pending",
                              )
                            }
                            data-testid={`menu-mark-not-completed-${booking.id}`}
                          >
                            Mark Not Completed
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                          onClick={() =>
                            handleStatusChange(booking.id, "canceled")
                          }
                          className="text-red-400"
                        >
                          Cancel Booking
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>

                <div className="space-y-2 text-sm text-muted-foreground flex-1">
                  <div className="flex items-start gap-3">
                    <Calendar className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>
                      {formatZoned(booking.scheduledFor, timeZone)}{" "}
                      <span className="text-xs opacity-60">
                        {zoneLabel(timeZone)}
                      </span>
                    </span>
                  </div>
                  <div className="flex items-start gap-3">
                    <MapPin className="w-4 h-4 mt-0.5 shrink-0" />
                    {booking.customerAddress ? (
                      // Straight to the live map, parked on this client's pin
                      // (which wears the address in a box so it stands out) —
                      // where the cleaner list books whoever gets clicked.
                      <Link
                        href={mapFocusHref(
                          booking.id,
                          zonedDayKey(booking.scheduledFor, timeZone),
                        )}
                        className="underline decoration-dotted underline-offset-2 hover:text-foreground transition-colors"
                        title="See this address on the live map"
                        data-testid={`link-map-address-${booking.id}`}
                      >
                        {booking.customerAddress}
                      </Link>
                    ) : (
                      <span>Address not provided</span>
                    )}
                    {booking.geocodingFailed && booking.customerAddress && (
                      <AddressPlacementWarning
                        address={booking.customerAddress}
                        testId={`warning-address-placement-booking-${booking.id}`}
                      />
                    )}
                  </div>
                  <div className="flex items-start gap-3">
                    <PhoneActions
                      phone={booking.customerPhone}
                      name={bookingDisplayName(booking)}
                      className="text-sm"
                    />
                  </div>
                  <div className="flex items-start gap-3">
                    <Users className="w-4 h-4 mt-0.5 shrink-0" />
                    {booking.crew && booking.crew.length > 0 ? (
                      <span>{booking.crew.map((c) => c.name).join(", ")}</span>
                    ) : canDispatch ? (
                      <button
                        type="button"
                        onClick={() => setCrewBooking(booking)}
                        className="text-brand-pink hover:underline"
                      >
                        Assign crew
                      </button>
                    ) : (
                      <span className="opacity-60">No crew assigned</span>
                    )}
                  </div>
                  <div className="flex items-start gap-3">
                    <User className="w-4 h-4 mt-0.5 shrink-0" />
                    <span className="font-medium text-foreground">
                      Requested: {booking.service}
                    </span>
                  </div>
                  {booking.quoteSentAt && (
                    <div className="flex items-start gap-3">
                      <MessageSquareText className="w-4 h-4 mt-0.5 shrink-0" />
                      <span>
                        Quote texted{" "}
                        {formatDistanceToNow(new Date(booking.quoteSentAt), {
                          addSuffix: true,
                        })}
                      </span>
                    </div>
                  )}
                </div>

                {/* The on-site clock. Shown to crew and office alike: crew tap
                  it at the house, the office bills from what it records. */}
                <JobTimerPanel booking={booking} canDispatch={canDispatch} />

                {/* Quoting, money and Jobber are dispatch work. Hidden for
                  cleaners to match what the API will actually allow. */}
                {canDispatch && (
                  <div className="mt-5 pt-4 border-t border-border grid gap-2">
                    {/* Approval is deliberately separate from scheduling:
                        first record the client's yes here, then choose when
                        to create the Jobber job. */}
                    {needsAcceptance(booking) && (
                      <Button
                        className="w-full gap-2"
                        onClick={() => handleApprove(booking, false)}
                        disabled={approve.isPending}
                        data-testid={`button-approve-${booking.id}`}
                      >
                        <ThumbsUp className="w-4 h-4" /> Approve quote — client
                        said yes
                      </Button>
                    )}
                    {awaitingJobberSchedule(booking) &&
                      (() => {
                        const blocked = scheduleBlockedReason(
                          booking,
                          jobberConnected,
                          jobberNeedsReauth,
                        );
                        return (
                          <Button
                            variant="outline"
                            className="w-full gap-2"
                            onClick={() =>
                              setDetail({ id: booking.id, mode: "accept" })
                            }
                            disabled={Boolean(blocked)}
                            title={blocked ?? undefined}
                            data-testid={`button-schedule-${booking.id}`}
                          >
                            <CalendarCheck className="w-4 h-4" />
                            {blocked
                              ? `Schedule in Jobber — ${blocked}`
                              : "Schedule in Jobber & assign crew"}
                          </Button>
                        );
                      })()}
                    <div className="grid grid-cols-2 gap-2">
                      {/* Price first, text second: this one opens the same
                          dialog with the calculator already expanded, and
                          nothing goes out unless Send is pressed. */}
                      <Button
                        variant="outline"
                        className="w-full gap-2 text-brand-pink border-brand-pink/20 hover:bg-brand-pink/10 hover:text-brand-pink"
                        onClick={() =>
                          setQuoteEntry({ id: booking.id, mode: "pricing" })
                        }
                        data-testid={`button-quote-price-${booking.id}`}
                      >
                        <DollarSign className="w-4 h-4" />
                        {hasQuotePrice(booking)
                          ? "Adjust quote"
                          : "Create quote"}
                      </Button>
                      <Button
                        variant="outline"
                        className="w-full gap-2 text-brand-blue border-brand-blue/20 hover:bg-brand-blue/10 hover:text-brand-blue"
                        onClick={() =>
                          setQuoteEntry({ id: booking.id, mode: "send" })
                        }
                        data-testid={`button-send-quote-${booking.id}`}
                      >
                        <MessageSquareText className="w-4 h-4" />
                        {booking.quoteSentAt
                          ? "Send updated quote"
                          : "Send quote"}
                      </Button>
                    </div>

                    {/* Whatever went wrong last time is shown whether or not
                        the booking made it over: a request that landed and a
                        quote that didn't is still a booking with a problem. */}
                    <div className="grid gap-2">
                      {booking.jobberSyncError && (
                        <div
                          className="rounded-md border border-red-800 bg-red-950/50 px-3 py-2 text-xs text-red-400"
                          data-testid={`text-sync-error-${booking.id}`}
                        >
                          <div className="flex items-start gap-2">
                            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                            <div>
                              <span className="font-medium">
                                Last sync failed:
                              </span>{" "}
                              {booking.jobberSyncError}
                              {booking.jobberSyncErrorAt && (
                                <span className="block text-red-400/70 mt-0.5">
                                  {formatDistanceToNow(
                                    new Date(booking.jobberSyncErrorAt),
                                    { addSuffix: true },
                                  )}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                      <BookingJobberRetryStatus booking={booking} />
                      {jobberNeedsReauth &&
                      !booking.jobberSynced &&
                      !(
                        booking.jobberAutomaticRetryStatus === "exhausted" &&
                        booking.jobberRetryUsesBookingConnection === true
                      ) &&
                      booking.jobberAutomaticRetryStatus !== "manual" ? (
                        <Link href="/setup">
                          <Button
                            variant="outline"
                            className="w-full gap-2 text-amber-400 border-amber-800 hover:bg-amber-950 hover:text-amber-300"
                          >
                            <RefreshCw className="w-4 h-4" /> Reconnect Jobber
                            to sync
                          </Button>
                        </Link>
                      ) : jobberConnected &&
                        booking.jobberAutomaticRetryStatus !== "manual" &&
                        (!jobberNeedsReauth ||
                          (booking.jobberAutomaticRetryStatus === "exhausted" &&
                            booking.jobberRetryUsesBookingConnection ===
                              true)) &&
                        (!booking.jobberSynced || booking.jobberSyncError) ? (
                        <Button
                          variant="outline"
                          className="w-full text-primary hover:text-primary hover:bg-primary/5 border-primary/20 gap-2"
                          onClick={() => handleSync(booking.id)}
                          disabled={syncJobber.isPending}
                          data-testid={`button-sync-to-jobber-${booking.id}`}
                        >
                          <RefreshCw
                            className={`w-4 h-4 ${syncJobber.isPending ? "animate-spin" : ""}`}
                          />
                          {syncJobber.isPending
                            ? "Syncing..."
                            : "Sync to Jobber"}
                        </Button>
                      ) : null}
                      {/* Links appear as soon as each piece exists — the quote
                          is drafted with the booking now, so waiting for a
                          texted quote would hide it for no reason. */}
                      {booking.jobberWebUri && (
                        <a
                          href={booking.jobberWebUri}
                          target="_blank"
                          rel="noopener noreferrer"
                          data-testid={`link-jobber-request-${booking.id}`}
                        >
                          <Button
                            variant="outline"
                            className="w-full gap-2 text-green-400 border-green-800 hover:bg-green-950 hover:text-green-300"
                          >
                            <ExternalLink className="w-4 h-4" /> View request in
                            Jobber
                          </Button>
                        </a>
                      )}
                      {booking.jobberQuoteWebUri && (
                        <a
                          href={booking.jobberQuoteWebUri}
                          target="_blank"
                          rel="noopener noreferrer"
                          data-testid={`link-jobber-quote-${booking.id}`}
                        >
                          <Button
                            variant="outline"
                            className="w-full gap-2 text-green-400 border-green-800 hover:bg-green-950 hover:text-green-300"
                          >
                            <ExternalLink className="w-4 h-4" />
                            {booking.jobberQuoteNumber
                              ? `Quote #${booking.jobberQuoteNumber} in Jobber`
                              : "View quote in Jobber"}
                          </Button>
                        </a>
                      )}
                      {booking.jobberJobWebUri && (
                        <a
                          href={booking.jobberJobWebUri}
                          target="_blank"
                          rel="noopener noreferrer"
                          data-testid={`link-jobber-job-${booking.id}`}
                        >
                          <Button
                            variant="outline"
                            className="w-full gap-2 text-green-400 border-green-800 hover:bg-green-950 hover:text-green-300"
                          >
                            <ExternalLink className="w-4 h-4" /> View scheduled
                            job in Jobber
                          </Button>
                        </a>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </PanelErrorBoundary>

      <BookingFormDialog
        key={formBooking?.id ?? "new"}
        booking={formBooking}
        timeZone={timeZone}
        open={formOpen}
        onOpenChange={setFormOpen}
      />
      {quoteEntry && quoteEntryBooking && (
        <QuoteDialog
          booking={quoteEntryBooking}
          initialMode={quoteEntry.mode}
          open
          onOpenChange={(open) => !open && setQuoteEntry(null)}
        />
      )}
      <AssignCrewDialog
        booking={crewBooking}
        onClose={() => setCrewBooking(null)}
      />
      <BookingDetailDialog
        booking={detailBooking}
        mode={detail?.mode ?? "detail"}
        onClose={() => setDetail(null)}
        canDispatch={canDispatch}
        timeZone={timeZone}
        jobberConnected={jobberConnected}
        jobberNeedsReauth={jobberNeedsReauth}
        onEdit={(b) => {
          setDetail(null);
          openEdit(b);
        }}
        onQuote={(b, mode) => {
          setDetail(null);
          setQuoteEntry({ id: b.id, mode });
        }}
        onCreateInvoice={handleCreateInvoice}
        invoicePending={createInvoice.isPending}
      />
    </AppLayout>
  );
}

function QuoteDialog({
  booking,
  initialMode = "send",
  open,
  onOpenChange,
}: {
  booking: Booking;
  /**
   * "pricing" opens with the calculator already expanded (the Create/Adjust
   * quote entry points); "send" keeps it collapsed, exactly as the texting
   * flow has always been.
   */
  initialMode?: QuoteEntryMode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: preview, isLoading } = useGetQuotePreview(booking.id, {
    query: { queryKey: getGetQuotePreviewQueryKey(booking.id) },
  });
  const sendQuote = useSendQuote();
  const updateBooking = useUpdateBooking();
  const { data: company } = useGetCompany();
  const { data: services } = useListServices();
  const rates = companyQuoteRates(company);
  const catalogPrice = exactServicePrice(services, booking.service);
  const [message, setMessage] = useState("");
  const [touched, setTouched] = useState(false);
  // Armed after the first Send click on a message whose price no longer
  // matches the calculator — the second click is the explicit confirmation.
  const [mismatchArmed, setMismatchArmed] = useState(false);

  // Inline price editing, so knocking $20 off a job doesn't mean closing the
  // dialog and finding the booking again. The draft starts from what's stored
  // on the booking; nothing is saved until "Save price" is pressed. Entering
  // via Create/Adjust quote starts with the calculator already open.
  const [showPricing, setShowPricing] = useState(initialMode === "pricing");
  const storedDraft: QuoteDraft = {
    hours: booking.quoteHours ?? null,
    crewLabel: booking.quoteCrewLabel ?? null,
    hourlyRate: booking.quoteHourlyRate ?? null,
    fuelSurcharge: booking.quoteFuelSurcharge ?? null,
    discountAmount: booking.quoteDiscountAmount ?? null,
    referralSource: booking.quoteReferralSource ?? null,
    deposit: booking.quoteDeposit ?? null,
  };
  const [draft, setDraft] = useState<QuoteDraft>(storedDraft);
  const [savedDraft, setSavedDraft] = useState<QuoteDraft>(storedDraft);
  const dirty = (Object.keys(draft) as (keyof QuoteDraft)[]).some(
    (k) => draft[k] !== savedDraft[k],
  );

  const handleSavePrice = () => {
    if (draft.hourlyRate != null && draft.hourlyRate < 0) {
      toast({
        title: "Check the rate",
        description: "An hourly rate can't be negative.",
        variant: "destructive",
      });
      return;
    }
    const priced =
      draft.hours != null && draft.hours > 0 && draft.hourlyRate != null;
    updateBooking.mutate(
      {
        id: booking.id,
        data: {
          quoteHours: draft.hours,
          quoteCrewLabel: draft.crewLabel,
          quoteHourlyRate: draft.hourlyRate,
          quoteFuelSurcharge: draft.fuelSurcharge,
          quoteDiscountAmount: draft.discountAmount,
          quoteReferralSource: draft.referralSource,
          quoteDeposit: draft.deposit,
          // Same rule as the booking form: once the calculator prices the
          // job, a flat receptionist price no longer applies.
          quotedAmount: priced ? null : (booking.quotedAmount ?? null),
        },
      },
      {
        onSuccess: () => {
          setSavedDraft(draft);
          queryClient.invalidateQueries({
            queryKey: getListBookingsQueryKey(),
          });
          queryClient.invalidateQueries({
            queryKey: getGetQuotePreviewQueryKey(booking.id),
          });
          // The old draft text quoted the old price, so let the regenerated
          // one replace it — keeping stale hand-edits would re-create the
          // exact mismatch the dispatcher just fixed.
          setTouched(false);
          setMismatchArmed(false);
          toast({
            title: "Price updated",
            description:
              "The booking now records the new price, and the message below has been redrafted to match.",
          });
        },
        onError: (error: any) => {
          toast({
            title: "Couldn't update the price",
            description: error?.message || "Please try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  // Seed the box from the server draft, but never clobber the dispatcher's edits.
  useEffect(() => {
    if (preview?.message && !touched) setMessage(preview.message);
  }, [preview?.message, touched]);

  // The price the calculator says this job costs — the number that will be
  // frozen against the booking when the text goes out.
  const anchor = preview?.totals ? quotedPriceAnchor(preview.totals) : null;
  const priceMismatch =
    anchor != null && preview?.totals
      ? !messageContainsQuotePrice(message, preview.totals)
      : false;

  const handleSend = () => {
    if (priceMismatch && !mismatchArmed) {
      // First click: warn instead of sending.
      setMismatchArmed(true);
      return;
    }
    sendQuote.mutate(
      {
        id: booking.id,
        data: {
          message,
          ...(priceMismatch ? { confirmPriceMismatch: true } : {}),
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListBookingsQueryKey(),
          });
          toast({
            title: "Quote sent",
            description: `Texted to ${bookingDisplayName(booking)} at ${booking.customerPhone}.`,
          });
          onOpenChange(false);
        },
        onError: (error: any) => {
          toast({
            title: "Couldn't send the quote",
            description: error?.message || "Please try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const blocked = preview ? !preview.canSend : false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Text a quote to {bookingDisplayName(booking)}
          </DialogTitle>
          <DialogDescription>
            {preview?.fromNumber
              ? `Sends from your Quo number ${preview.fromNumber}.`
              : "Sends from your own Quo number."}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <LoadingSpinner className="my-8" />
        ) : (
          <div className="space-y-4">
            {!hasQuotePrice(booking) && (
              <div
                className="text-sm text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3"
                data-testid="text-no-price"
              >
                {initialMode === "pricing" ? (
                  <>
                    No price set yet. Price the job below and press{" "}
                    <strong>Save price</strong> — the price is kept on the
                    booking, and you can text the quote right away or close this
                    and send it later.
                  </>
                ) : (
                  <>
                    No price set yet. Use <strong>Adjust price</strong> below to
                    price the job, or type the amount straight into the message.
                  </>
                )}
              </div>
            )}
            {preview?.totals && preview.totals.subtotal > 0 && (
              <div className="rounded-lg border border-border bg-secondary/40 p-3 space-y-1 text-sm">
                {preview.totals.lineItems.map((item, i) => (
                  <div
                    key={i}
                    className="flex justify-between gap-4 text-muted-foreground"
                  >
                    <span>
                      {item.quantity === 1
                        ? item.name
                        : `${item.name} — ${item.quantity} x ${formatMoney(item.unitPrice)}`}
                    </span>
                    <span className="tabular-nums">
                      {formatMoney(
                        Number((item.quantity * item.unitPrice).toFixed(2)),
                      )}
                    </span>
                  </div>
                ))}
                <div className="flex justify-between gap-4 border-t border-border/60 pt-1 mt-1">
                  <span>Subtotal</span>
                  <span className="tabular-nums">
                    {formatMoney(preview.totals.subtotal)}
                  </span>
                </div>
                {preview.totals.taxRate > 0 && (
                  <div className="flex justify-between gap-4 text-muted-foreground">
                    <span>
                      {preview.totals.taxLabel} (
                      {formatRate(preview.totals.taxRate)})
                    </span>
                    <span className="tabular-nums">
                      {formatMoney(preview.totals.taxAmount)}
                    </span>
                  </div>
                )}
                <div className="flex justify-between gap-4 font-semibold text-foreground">
                  <span>Total</span>
                  <span className="tabular-nums">
                    {formatMoney(preview.totals.total)}
                  </span>
                </div>
              </div>
            )}
            {blocked && (
              <div className="text-sm text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
                {preview?.blockedReason}
              </div>
            )}
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => setShowPricing((v) => !v)}
                className="flex items-center gap-2 text-sm font-medium text-brand-pink hover:underline"
                data-testid="button-adjust-price"
              >
                <DollarSign className="w-4 h-4" />
                {showPricing ? "Hide price adjustments" : "Adjust price"}
              </button>
              {showPricing && (
                <>
                  <QuoteCalculator
                    value={draft}
                    onChange={setDraft}
                    rates={rates}
                    serviceName={booking.service}
                    catalogPrice={catalogPrice}
                    flatAmount={booking.quotedAmount ?? null}
                  />
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs text-muted-foreground">
                      Saving updates the booking&apos;s price and redrafts the
                      message to match.
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleSavePrice}
                      disabled={!dirty || updateBooking.isPending}
                      data-testid="button-save-price"
                    >
                      {updateBooking.isPending ? "Saving..." : "Save price"}
                    </Button>
                  </div>
                </>
              )}
            </div>
            <div>
              <Label htmlFor="quote-message" className="mb-2 block">
                Message
              </Label>
              <Textarea
                id="quote-message"
                rows={10}
                value={message}
                onChange={(e) => {
                  setTouched(true);
                  // Any edit gets a fresh warning if the price is still wrong.
                  setMismatchArmed(false);
                  setMessage(e.target.value);
                }}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground mt-2">
                {message.length} characters · edit freely before sending
              </p>
            </div>
            {priceMismatch && anchor != null && (
              <div
                className="text-sm text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3"
                data-testid="text-price-mismatch"
              >
                <p>
                  This message no longer mentions the calculated price of{" "}
                  <strong className="tabular-nums">
                    {formatMoney(anchor)}
                  </strong>{" "}
                  — the booking will still record that amount, not whatever
                  number is in the text. To actually change the price, use{" "}
                  <strong>Adjust price</strong> above and save it, and the
                  message will be redrafted to match.
                </p>
                {mismatchArmed && (
                  <p className="mt-2 font-medium">
                    Press <strong>Send anyway</strong> if you really mean to
                    text it as written.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSend}
            disabled={
              sendQuote.isPending || blocked || !message.trim() || isLoading
            }
            className="gap-2"
          >
            <MessageSquareText className="w-4 h-4" />
            {sendQuote.isPending
              ? "Sending..."
              : mismatchArmed && priceMismatch
                ? "Send anyway"
                : "Send text"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BookingFormDialog({
  booking,
  timeZone,
  open,
  onOpenChange,
}: {
  booking: Booking | null;
  timeZone: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createBooking = useCreateBooking();
  const updateBooking = useUpdateBooking();
  const { data: company } = useGetCompany();
  const rates = companyQuoteRates(company);
  const isEdit = booking != null;

  const [customerName, setCustomerName] = useState(booking?.customerName ?? "");
  const [customerPhone, setCustomerPhone] = useState(
    booking?.customerPhone ?? "",
  );
  const [customerEmail, setCustomerEmail] = useState(
    booking?.customerEmail ?? "",
  );
  const [customerAddress, setCustomerAddress] = useState(
    booking?.customerAddress ?? "",
  );
  const [service, setService] = useState(booking?.service ?? "");
  const [scheduledFor, setScheduledFor] = useState(
    booking
      ? isoToZonedInput(booking.scheduledFor, timeZone)
      : defaultScheduledFor(timeZone),
  );
  const [quote, setQuote] = useState<QuoteDraft>(
    booking
      ? {
          hours: booking.quoteHours ?? null,
          crewLabel: booking.quoteCrewLabel ?? null,
          hourlyRate: booking.quoteHourlyRate ?? null,
          fuelSurcharge: booking.quoteFuelSurcharge ?? null,
          discountAmount: booking.quoteDiscountAmount ?? null,
          referralSource: booking.quoteReferralSource ?? null,
          deposit: booking.quoteDeposit ?? null,
        }
      : emptyQuoteDraft,
  );
  const [quoteNotes, setQuoteNotes] = useState(booking?.quoteNotes ?? "");

  const pending = createBooking.isPending || updateBooking.isPending;
  /**
   * The date keeps its own gate — every booking lands on the calendar. The
   * rest is whatever the owner toggled required in Settings → Booking form,
   * checked in handleSubmit so the message can name exactly what's missing.
   * `time` counts as filled here because the datetime-local box always
   * carries one.
   */
  const requiredFields = company?.bookingRequiredFields ?? [];
  const requiredMissing = missingBookingFields(requiredFields, {
    name: customerName,
    phone: customerPhone,
    email: customerEmail,
    address: customerAddress,
    service,
    time: scheduledFor,
  });
  const valid = Boolean(scheduledFor);
  const requiredMark = (key: BookingFormFieldKey) =>
    isBookingFieldRequired(requiredFields, key) ? (
      <span className="text-destructive font-normal">*</span>
    ) : null;

  const handleSubmit = () => {
    if (requiredMissing.length > 0) {
      toast({
        title: "Still needs a few required details",
        description: `Missing: ${requiredMissing.join(", ")}. Required fields can be changed in Settings → Booking form.`,
        variant: "destructive",
      });
      return;
    }
    // The dispatcher types the time the customer will hear, i.e. company time.
    const whenIso = zonedInputToIso(scheduledFor, timeZone);
    if (!whenIso) {
      toast({
        title: "Check the date",
        description: "That scheduled time isn't valid.",
        variant: "destructive",
      });
      return;
    }
    const priced =
      quote.hours != null && quote.hours > 0 && quote.hourlyRate != null;
    if (quote.hourlyRate != null && quote.hourlyRate < 0) {
      toast({
        title: "Check the rate",
        description: "An hourly rate can't be negative.",
        variant: "destructive",
      });
      return;
    }

    const payload = {
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim(),
      customerEmail: customerEmail.trim() || null,
      customerAddress: customerAddress.trim() || null,
      service: service.trim(),
      scheduledFor: whenIso,
      quoteHours: quote.hours,
      quoteCrewLabel: quote.crewLabel,
      quoteHourlyRate: quote.hourlyRate,
      quoteFuelSurcharge: quote.fuelSurcharge,
      quoteDiscountAmount: quote.discountAmount,
      quoteReferralSource: quote.referralSource,
      // Clear any flat price once the calculator has been used, so there is
      // only ever one answer to "what does this job cost?".
      quotedAmount: priced ? null : (booking?.quotedAmount ?? null),
      quoteDeposit: quote.deposit,
      quoteNotes: quoteNotes.trim() || null,
    };

    const onSuccess = () => {
      queryClient.invalidateQueries({ queryKey: getListBookingsQueryKey() });
      if (booking) {
        queryClient.invalidateQueries({
          queryKey: getGetQuotePreviewQueryKey(booking.id),
        });
      }
      toast({
        title: isEdit ? "Booking updated" : "Booking added",
        // A nameless booking still gets a sentence that reads like one.
        description: [bookingDisplayName(payload), payload.service]
          .filter(Boolean)
          .join(" — "),
      });
      onOpenChange(false);
    };
    const onError = (error: any) => {
      toast({
        title: isEdit
          ? "Couldn't update that booking"
          : "Couldn't add that booking",
        description: error?.message || "Please try again.",
        variant: "destructive",
      });
    };

    if (isEdit) {
      updateBooking.mutate(
        { id: booking!.id, data: payload },
        { onSuccess, onError },
      );
    } else {
      createBooking.mutate({ data: payload }, { onSuccess, onError });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit booking" : "Add a booking"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Change the details, price or time. The customer isn't told until you send a quote."
              : "For walk-ins, repeat customers, or a call the receptionist missed."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="b-name" className="mb-2 block">
                Customer name {requiredMark("name")}
              </Label>
              <Input
                id="b-name"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="Jay Patel"
              />
            </div>
            <div>
              <Label htmlFor="b-phone" className="mb-2 block">
                Phone {requiredMark("phone")}
              </Label>
              <Input
                id="b-phone"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
                placeholder="(780) 920-6391"
              />
            </div>
          </div>

          <div>
            <Label htmlFor="b-email" className="mb-2 block">
              Email{" "}
              {isBookingFieldRequired(requiredFields, "email") ? (
                requiredMark("email")
              ) : (
                <span className="text-muted-foreground font-normal">
                  (optional)
                </span>
              )}
            </Label>
            <Input
              id="b-email"
              type="email"
              value={customerEmail}
              onChange={(e) => setCustomerEmail(e.target.value)}
              placeholder="jay@example.com"
            />
          </div>

          <div>
            <Label htmlFor="b-service" className="mb-2 block">
              Service {requiredMark("service")}
            </Label>
            <Input
              id="b-service"
              value={service}
              onChange={(e) => setService(e.target.value)}
              placeholder="Move-out clean — 2 bed, 2 bath"
            />
          </div>

          <div>
            <Label htmlFor="b-address" className="mb-2 block">
              Address{" "}
              {isBookingFieldRequired(requiredFields, "address") ? (
                requiredMark("address")
              ) : (
                <span className="text-muted-foreground font-normal">
                  (optional)
                </span>
              )}
            </Label>
            <Input
              id="b-address"
              value={customerAddress}
              onChange={(e) => setCustomerAddress(e.target.value)}
              placeholder="5810 Mullen Place"
            />
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="b-when" className="mb-2 block">
                Scheduled for{" "}
                <span className="text-muted-foreground font-normal">
                  ({zoneLabel(timeZone)})
                </span>
              </Label>
              <Input
                id="b-when"
                type="datetime-local"
                value={scheduledFor}
                onChange={(e) => setScheduledFor(e.target.value)}
              />
            </div>
          </div>

          <QuoteCalculator
            value={quote}
            onChange={setQuote}
            rates={rates}
            serviceName={service}
            flatAmount={booking?.quotedAmount ?? null}
          />

          <div>
            <Label htmlFor="b-notes" className="mb-2 block">
              Quote notes{" "}
              <span className="text-muted-foreground font-normal">
                (optional — included in the text)
              </span>
            </Label>
            <Textarea
              id="b-notes"
              rows={3}
              value={quoteNotes}
              onChange={(e) => setQuoteNotes(e.target.value)}
              placeholder="Includes inside fridge and oven. Around 3 hours."
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={pending || !valid}>
            {pending ? "Saving..." : isEdit ? "Save changes" : "Add booking"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
