/**
 * One booking, opened by clicking its card on the Bookings page.
 *
 * The point of this dialog is the accept flow: a pending booking's Accept
 * button walks the owner through picking the crew and confirming, and one
 * confirm records the approval, saves the crew, and puts the job on the
 * Jobber calendar with those assignees — no trip to Jobber. The same view
 * serves already-accepted bookings for crew reassignment and the usual
 * actions (edit, quote, invoice, Jobber links).
 *
 * Ordering matters in the accept flow: the crew is saved BEFORE the approve
 * call, because the server reads the crew from the database at schedule time
 * to pick the Jobber visit's assignees. Approve is idempotent, so a Jobber
 * failure leaves the approval recorded, the sync error on the booking, and
 * this dialog offering a retry — the local state never lies about what
 * happened on the Jobber side.
 */
import { useState } from "react";
import {
  useApproveBooking,
  useListTeamMembers,
  useSetBookingCrew,
  useSyncBookingToJobber,
  getListBookingsQueryKey,
  Booking,
  bookingDisplayName,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { PhoneActions } from "@/components/PhoneActions";
import { BookingJobberRetryStatus } from "@/components/BookingJobberRetryStatus";
import { formatZoned, zoneLabel } from "@/lib/time";
import { invoiceOpenTarget } from "@/lib/jobberInvoice";
import { CustomerTagPicker } from "@/components/CustomerTagControls";
import {
  awaitingJobberSchedule,
  clientApproved,
  jobberApprovalObserved,
  needsAcceptance,
  sameCrew,
  scheduleBlockedReason,
} from "@/lib/bookingAcceptance";
import { formatDistanceToNow } from "date-fns";
import {
  AlertCircle,
  Calendar,
  CalendarCheck,
  CheckCircle2,
  CreditCard,
  DollarSign,
  ExternalLink,
  MapPin,
  MessageSquareText,
  Pencil,
  Receipt,
  RefreshCw,
  ThumbsUp,
  User,
  Users,
} from "lucide-react";

/**
 * How the quote dialog is entered: "send" is the texting flow as it always
 * was (pricing collapsed), "pricing" opens with the calculator expanded so
 * the price can be set or changed without being pushed toward sending.
 */
export type QuoteEntryMode = "send" | "pricing";

/**
 * Whether this booking already carries a price — the rule shared by the
 * Create/Adjust label and the quote dialog's "no price set yet" notice, so
 * the two can never disagree.
 *
 * A price exists in either form: calculator totals (the server folds a flat
 * receptionist price into quoteTotals.subtotal when the calculator hasn't
 * been used), or the flat quotedAmount itself — checked directly too, so the
 * label stays honest even if totals ever arrive null or unpriced.
 */
export function hasQuotePrice(booking: Booking): boolean {
  return (
    (booking.quoteTotals?.subtotal ?? 0) > 0 || (booking.quotedAmount ?? 0) > 0
  );
}

/** Quotes always show cents, matching the printed estimates. */
export function formatMoney(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  return `${sign}$${Math.abs(amount).toFixed(2)}`;
}

/**
 * The headline number on a booking.
 *
 * Once a quote has been texted, that price is what the customer was promised,
 * so it wins over anything recomputed from today's rates. If the two have since
 * diverged — the owner changed a rate, or the dispatcher re-priced the job —
 * say so, because the fix is to send an updated quote, not to quietly show a
 * number the customer has never seen.
 */
export function BookingPrice({ booking }: { booking: Booking }) {
  const sent = booking.quoteSentTotals;
  // Nullable only for cleaner logins, which never see this dashboard — but
  // the contract says nullable, so handle it rather than crash.
  const current = booking.quoteTotals;
  if (!current) return null;

  if (sent) {
    const changed = Math.abs(sent.total - current.total) >= 0.01;
    return (
      <div className="text-right">
        <span
          className="text-lg font-bold text-foreground tabular-nums block"
          data-testid={`price-sent-total-${booking.id}`}
          title={`Quoted to the customer: subtotal ${formatMoney(sent.subtotal)} + tax`}
        >
          {formatMoney(sent.total)}
        </span>
        {changed && (
          <span
            className="text-[11px] text-amber-400"
            data-testid={`price-divergence-notice-${booking.id}`}
            title={`Now prices at ${formatMoney(current.total)}. Send an updated quote to change what the customer owes.`}
          >
            now {formatMoney(current.total)}
          </span>
        )}
      </div>
    );
  }

  if (current.subtotal <= 0) return null;
  return (
    <span
      className="text-lg font-bold text-foreground tabular-nums"
      title={`Subtotal ${formatMoney(current.subtotal)} + tax`}
    >
      {formatMoney(current.total)}
    </span>
  );
}

export function BookingStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "pending":
      return (
        <Badge className="bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 border-0">
          Pending
        </Badge>
      );
    case "confirmed":
      // Named for what it means: the client said yes. Nothing else in the app
      // can put a booking in this state.
      return (
        <Badge className="bg-blue-500/15 text-blue-300 hover:bg-blue-500/25 border-0">
          Client confirmed
        </Badge>
      );
    case "completed":
      return (
        <Badge className="bg-green-500/15 text-green-300 hover:bg-green-500/25 border-0">
          Completed
        </Badge>
      );
    case "canceled":
      return (
        <Badge className="bg-secondary text-muted-foreground hover:bg-secondary border-0">
          Canceled
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

/**
 * The status story of one booking, as pills: status, approval (with who
 * recorded it), deposit, Jobber. Shared by the card and the detail dialog so
 * they can never tell two different stories about the same booking.
 */
export function BookingBadges({ booking }: { booking: Booking }) {
  const approvedInJobber = jobberApprovalObserved(booking);
  const approvedHere = Boolean(
    booking.quoteApprovedAt || booking.clientApprovedAt,
  );
  return (
    <div className="flex items-center gap-2 mt-1 flex-wrap">
      {/* A mirrored Jobber approval is more specific than the stale local
          "pending" status, so never show those contradictory pills together. */}
      {booking.status !== "pending" || !approvedInJobber ? (
        <BookingStatusBadge status={booking.status} />
      ) : null}
      {approvedHere ? (
        // Approval supersedes "quote sent" — showing both just adds noise to
        // a row the dispatcher scans at a glance. Who recorded a phone
        // approval rides along, because "the client agreed" is only as good
        // as its source.
        <span
          className="flex items-center gap-1 text-xs font-medium text-green-400 bg-green-500/10 px-2 py-0.5 rounded-full border border-green-500/20"
          data-testid={`badge-approved-${booking.id}`}
        >
          <ThumbsUp className="w-3 h-3" />
          {booking.quoteApprovedAt
            ? "Approved from quote link"
            : "Approved in Book My Cleaning"}
          {booking.clientApprovedBy
            ? ` · recorded by ${booking.clientApprovedBy}`
            : ""}
        </span>
      ) : booking.quoteSentAt ? (
        <span className="flex items-center gap-1 text-xs font-medium text-brand-blue bg-brand-blue/10 px-2 py-0.5 rounded-full border border-brand-blue/20">
          <MessageSquareText className="w-3 h-3" /> Quote sent
        </span>
      ) : null}
      {approvedInJobber ? (
        <span
          className="flex items-center gap-1 text-xs font-medium text-orange-300 bg-orange-500/10 px-2 py-0.5 rounded-full border border-orange-500/20"
          data-testid={`badge-approved-jobber-${booking.id}`}
        >
          <CheckCircle2 className="w-3 h-3" />
          {booking.jobberQuoteStatus?.toLowerCase() === "converted"
            ? "Converted to a job in Jobber"
            : "Approved in Jobber"}
        </span>
      ) : null}
      {booking.depositPaidAt && (
        <span className="flex items-center gap-1 text-xs font-medium text-brand-pink bg-brand-pink/10 px-2 py-0.5 rounded-full border border-brand-pink/20">
          <CreditCard className="w-3 h-3" /> Deposit paid
        </span>
      )}
      {booking.jobberSyncedRequestId &&
        (booking.jobberWebUri ? (
          <a
            href={booking.jobberWebUri}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs font-medium text-orange-400 bg-orange-500/10 px-2 py-0.5 rounded-full border border-orange-500/20 hover:bg-orange-500/20 transition-colors"
            data-testid={`badge-jobber-request-${booking.id}`}
          >
            <ExternalLink className="w-3 h-3" /> Jobber request
          </a>
        ) : (
          <span
            className="flex items-center gap-1 text-xs font-medium text-orange-400 bg-orange-500/10 px-2 py-0.5 rounded-full border border-orange-500/20"
            data-testid={`badge-jobber-request-${booking.id}`}
          >
            Jobber request
          </span>
        ))}
      {booking.jobberSyncedQuoteId &&
        (booking.jobberQuoteWebUri ? (
          <a
            href={booking.jobberQuoteWebUri}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs font-medium text-orange-400 bg-orange-500/10 px-2 py-0.5 rounded-full border border-orange-500/20 hover:bg-orange-500/20 transition-colors"
            data-testid={`badge-jobber-quote-${booking.id}`}
          >
            <ExternalLink className="w-3 h-3" /> Jobber quote
          </a>
        ) : (
          <span
            className="flex items-center gap-1 text-xs font-medium text-orange-400 bg-orange-500/10 px-2 py-0.5 rounded-full border border-orange-500/20"
            data-testid={`badge-jobber-quote-${booking.id}`}
          >
            Jobber quote
          </span>
        ))}
      {booking.jobberSynced && !booking.jobberCreatedJobId && (
        <span className="flex items-center gap-1 text-xs font-medium text-green-400 bg-green-500/10 px-2 py-0.5 rounded-full border border-green-500/20">
          <CheckCircle2 className="w-3 h-3" /> Synced to Jobber
        </span>
      )}
    </div>
  );
}

type CrewOption = {
  id: number;
  name: string;
  role: string;
  active: boolean;
  hasLogin?: boolean;
};

/**
 * Dispatchers don't clean, and someone taken off the roster shouldn't be
 * offered — but keep anyone already on this job so an old assignment stays
 * visible and can be removed rather than silently vanishing.
 */
export function assignableCrew<T extends CrewOption>(
  team: T[] | undefined,
  selected: number[],
): T[] {
  return (team ?? []).filter(
    (m) => m.role !== "dispatcher" && (m.active || selected.includes(m.id)),
  );
}

/** The checklist of cleaners, shared by every crew-picking surface. */
export function CrewChecklist({
  members,
  selected,
  onToggle,
}: {
  members: CrewOption[];
  selected: number[];
  onToggle: (id: number) => void;
}) {
  return (
    <div className="space-y-1 py-2 max-h-72 overflow-y-auto">
      {members.map((member) => {
        const isOn = selected.includes(member.id);
        return (
          <button
            key={member.id}
            type="button"
            onClick={() => onToggle(member.id)}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors ${
              isOn
                ? "bg-brand-pink/10 text-foreground"
                : "hover:bg-secondary text-muted-foreground"
            }`}
          >
            <div
              className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                isOn
                  ? "bg-brand-pink border-brand-pink"
                  : "border-muted-foreground/40"
              }`}
            >
              {isOn && <CheckCircle2 className="w-3 h-3 text-white" />}
            </div>
            <span className="flex-1 text-sm font-medium">{member.name}</span>
            {!member.hasLogin && (
              <span className="text-xs opacity-60">not signed up</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export type BookingDetailMode = "detail" | "accept";

export function BookingDetailDialog({
  booking,
  mode,
  onClose,
  canDispatch,
  timeZone,
  jobberConnected,
  jobberNeedsReauth,
  onEdit,
  onQuote,
  onCreateInvoice,
  invoicePending,
}: {
  booking: Booking | null;
  mode: BookingDetailMode;
  onClose: () => void;
  canDispatch: boolean;
  timeZone: string;
  jobberConnected: boolean;
  jobberNeedsReauth: boolean;
  onEdit: (booking: Booking) => void;
  onQuote: (booking: Booking, mode: QuoteEntryMode) => void;
  onCreateInvoice: (booking: Booking) => void;
  invoicePending: boolean;
}) {
  return (
    <Dialog open={booking !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="sm:max-w-lg max-h-[85vh] overflow-y-auto"
        data-testid="dialog-booking-detail"
      >
        {booking && (
          // Keyed so an abandoned crew edit never leaks into another booking.
          <BookingDetailBody
            key={booking.id}
            booking={booking}
            initialView={mode}
            canDispatch={canDispatch}
            timeZone={timeZone}
            jobberConnected={jobberConnected}
            jobberNeedsReauth={jobberNeedsReauth}
            onEdit={onEdit}
            onQuote={onQuote}
            onCreateInvoice={onCreateInvoice}
            invoicePending={invoicePending}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function BookingDetailBody({
  booking,
  initialView,
  canDispatch,
  timeZone,
  jobberConnected,
  jobberNeedsReauth,
  onEdit,
  onQuote,
  onCreateInvoice,
  invoicePending,
}: {
  booking: Booking;
  initialView: BookingDetailMode;
  canDispatch: boolean;
  timeZone: string;
  jobberConnected: boolean;
  jobberNeedsReauth: boolean;
  onEdit: (booking: Booking) => void;
  onQuote: (booking: Booking, mode: QuoteEntryMode) => void;
  onCreateInvoice: (booking: Booking) => void;
  invoicePending: boolean;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: team } = useListTeamMembers();
  const setCrew = useSetBookingCrew();
  const approve = useApproveBooking();
  const syncJobber = useSyncBookingToJobber();

  // "accept" is now the explicit scheduling step after approval; "crew" is
  // the same picker saving on its own.
  const [view, setView] = useState<"detail" | "accept" | "crew">(
    initialView === "accept" && clientApproved(booking) ? "accept" : "detail",
  );
  const [selected, setSelected] = useState<number[]>(() =>
    (booking.crew ?? []).map((c) => c.id),
  );

  // Re-seed from whoever is currently on the job each time a picker opens,
  // so a half-finished edit from earlier never carries over.
  const openPicker = (next: "accept" | "crew") => {
    setSelected((booking.crew ?? []).map((c) => c.id));
    setView(next);
  };

  const toggle = (id: number) =>
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  const assignable = assignableCrew(team, selected);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: getListBookingsQueryKey() });

  const runManualJobberSync = () => {
    syncJobber.mutate(
      { id: booking.id },
      {
        onSuccess: () => {
          refresh();
          toast({
            title: "Synced to Jobber",
            description:
              "Client and work request created in your Jobber account.",
          });
        },
        onError: (error: any) => {
          refresh();
          toast({
            title: "Jobber sync failed",
            description:
              error?.data?.error ||
              error?.message ||
              "Could not create the job in Jobber. Try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const blocked = scheduleBlockedReason(
    booking,
    jobberConnected,
    jobberNeedsReauth,
  );
  const alreadyApproved = clientApproved(booking);
  const alreadyScheduled = Boolean(booking.jobberCreatedJobId);
  // Whether the confirm will put the job on the Jobber calendar.
  const scheduleNow = alreadyApproved && !alreadyScheduled && !blocked;
  const active =
    booking.status !== "canceled" && booking.status !== "completed";
  const pending = setCrew.isPending || approve.isPending;

  /** Record the client's yes here, without contacting Jobber. */
  const runApprovalOnly = () => {
    approve.mutate(
      { id: booking.id, data: { schedule: false } },
      {
        onSuccess: (result: any) => {
          refresh();
          toast({
            title: result?.recorded ? "Approval recorded" : "Already approved",
            description: `${bookingDisplayName(booking)} is approved in Book My Cleaning. Schedule it in Jobber when you're ready.`,
          });
        },
        onError: (err: any) => {
          refresh();
          toast({
            title: "Could not record the approval",
            description: err?.data?.error || err?.message || "Try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  /**
   * Explicit scheduling: save the crew (only if it changed), then schedule
   * the already-approved quote. Crew first, because the Jobber visit's assignees are
   * read from the database when the job is created.
   */
  const runAccept = async () => {
    if (!scheduleNow) return;
    const current = (booking.crew ?? []).map((c) => c.id);
    if (!sameCrew(selected, current)) {
      try {
        await setCrew.mutateAsync({
          id: booking.id,
          data: { teamMemberIds: selected },
        });
      } catch (err: any) {
        // Nothing was accepted yet — the booking is exactly as it was.
        refresh();
        toast({
          title: "Couldn't save the crew",
          description:
            err?.data?.error ||
            err?.message ||
            "Nothing was accepted — fix the crew and try again.",
          variant: "destructive",
        });
        return;
      }
    }
    approve.mutate(
      { id: booking.id, data: { schedule: true } },
      {
        onSuccess: (result: any) => {
          refresh();
          setView("detail");
          const unmatched: string[] = result?.unmatchedCrew ?? [];
          if (result?.jobberError) {
            toast({
              title: "Jobber didn't schedule it",
              description: `${result.jobberError} The existing approval is unchanged; retry from this booking.`,
              variant: "destructive",
            });
            return;
          }
          if (result?.scheduledInJobber) {
            toast({
              title: "Scheduled in Jobber",
              description:
                unmatched.length > 0
                  ? `The job is on the Jobber calendar, but ${unmatched.join(", ")} couldn't be matched to a Jobber user — the visit went out without them. Match their name in Jobber and reassign the crew.`
                  : "The job is on the Jobber calendar with your chosen crew.",
            });
            return;
          }
          toast({
            title: "Could not schedule in Jobber",
            description: blocked ?? "Try again from this booking.",
            variant: "destructive",
          });
        },
        onError: (err: any) => {
          // The crew may already be saved; show the truth from the server.
          refresh();
          toast({
            title: "Could not schedule in Jobber",
            description: err?.data?.error || err?.message || "Try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  /** Plain crew save for bookings that don't need accepting. */
  const runSaveCrew = () => {
    setCrew.mutate(
      { id: booking.id, data: { teamMemberIds: selected } },
      {
        onSuccess: () => {
          refresh();
          setView("detail");
          toast({
            title: selected.length > 0 ? "Crew assigned" : "Crew cleared",
            description:
              selected.length > 0
                ? `${selected.length} ${selected.length === 1 ? "person" : "people"} on ${bookingDisplayName(booking)}'s job.`
                : `Nobody is assigned to ${bookingDisplayName(booking)}'s job.`,
          });
        },
        onError: (err: any) => {
          toast({
            title: "Couldn't save the crew",
            description: err?.data?.error || err?.message || "Try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  if (view === "accept") {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Schedule in Jobber</DialogTitle>
          <DialogDescription>
            Pick the crew and put this approved job on the Jobber calendar.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-border bg-secondary/40 p-3 text-sm space-y-1">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">
              {formatZoned(booking.scheduledFor, timeZone)}{" "}
              <span className="text-xs opacity-60">{zoneLabel(timeZone)}</span>
            </span>
            <BookingPrice booking={booking} />
          </div>
          <div className="text-muted-foreground">{booking.service}</div>
        </div>

        {!alreadyScheduled && blocked && (
          <div
            className="text-sm text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3"
            data-testid="text-accept-jobber-blocked"
          >
            Jobber scheduling isn&apos;t available yet — {blocked}.
          </div>
        )}

        {assignable.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">
            You haven&apos;t added any cleaners yet — invite them from the Team
            page. You can still schedule the job without a crew.
          </p>
        ) : (
          <CrewChecklist
            members={assignable}
            selected={selected}
            onToggle={toggle}
          />
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setView("detail")}
            disabled={pending || !scheduleNow}
          >
            Back
          </Button>
          <Button
            onClick={runAccept}
            disabled={pending}
            className="gap-2"
            data-testid="button-accept-confirm"
          >
            <CalendarCheck className="w-4 h-4" />
            {pending ? "Scheduling..." : "Schedule & assign crew"}
          </Button>
        </DialogFooter>
      </>
    );
  }

  if (view === "crew") {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Assign crew</DialogTitle>
          <DialogDescription>
            Choose everyone working {bookingDisplayName(booking)}&apos;s job.
            They will see it on their own schedule.
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
          <Button
            variant="ghost"
            onClick={() => setView("detail")}
            disabled={pending}
          >
            Back
          </Button>
          <Button
            onClick={runSaveCrew}
            disabled={pending || assignable.length === 0}
            data-testid="button-crew-save"
          >
            {setCrew.isPending ? "Saving..." : "Save crew"}
          </Button>
        </DialogFooter>
      </>
    );
  }

  const invoiceTarget = invoiceOpenTarget(booking);
  return (
    <>
      <DialogHeader>
        <div className="flex items-start justify-between gap-3 pr-6">
          <DialogTitle className="text-xl">
            {/* A nameless booking shows its phone number (or "No name")
                here, never a blank heading. */}
            {bookingDisplayName(booking)}
          </DialogTitle>
          <BookingPrice booking={booking} />
        </div>
        <BookingBadges booking={booking} />
        <DialogDescription className="sr-only">
          Booking details for {bookingDisplayName(booking)}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-2 text-sm text-muted-foreground">
        <div className="flex items-start gap-3">
          <Calendar className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            {formatZoned(booking.scheduledFor, timeZone)}{" "}
            <span className="text-xs opacity-60">{zoneLabel(timeZone)}</span>
          </span>
        </div>
        <div className="flex items-start gap-3">
          <MapPin className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{booking.customerAddress || "Address not provided"}</span>
        </div>
        <div className="flex items-start gap-3">
          <PhoneActions
            phone={booking.customerPhone}
            name={bookingDisplayName(booking)}
            className="text-sm"
          />
        </div>
        <div className="flex items-start gap-3" data-testid="detail-crew">
          <Users className="w-4 h-4 mt-0.5 shrink-0" />
          {booking.crew && booking.crew.length > 0 ? (
            <span>{booking.crew.map((c) => c.name).join(", ")}</span>
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
        <CustomerTagPicker
          kind="booking"
          id={booking.id}
          value={booking.tag}
          testidPrefix={`button-tag-booking-detail-${booking.id}`}
        />
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

      {booking.jobberSyncError && (
        <div
          className="rounded-md border border-red-800 bg-red-950/50 px-3 py-2 text-xs text-red-400"
          data-testid="detail-sync-error"
        >
          <div className="flex items-start gap-2">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div>
              <span className="font-medium">Last sync failed:</span>{" "}
              {booking.jobberSyncError}
              {booking.jobberSyncErrorAt && (
                <span className="block text-red-400/70 mt-0.5">
                  {formatDistanceToNow(new Date(booking.jobberSyncErrorAt), {
                    addSuffix: true,
                  })}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
      <BookingJobberRetryStatus
        booking={booking}
        testId="detail-jobber-retry-status"
      />

      {canDispatch && (
        <div className="pt-3 border-t border-border grid gap-2">
          {jobberConnected &&
            booking.jobberAutomaticRetryStatus !== "manual" &&
            (!jobberNeedsReauth ||
              (booking.jobberAutomaticRetryStatus === "exhausted" &&
                booking.jobberRetryUsesBookingConnection === true)) &&
            (!booking.jobberSynced || booking.jobberSyncError) && (
              <Button
                variant="outline"
                className="w-full gap-2 text-primary hover:text-primary hover:bg-primary/5 border-primary/20"
                onClick={runManualJobberSync}
                disabled={syncJobber.isPending}
                data-testid="button-detail-sync-jobber"
              >
                <RefreshCw
                  className={`w-4 h-4 ${syncJobber.isPending ? "animate-spin" : ""}`}
                />
                {syncJobber.isPending ? "Syncing..." : "Sync to Jobber"}
              </Button>
            )}
          {needsAcceptance(booking) && (
            <Button
              className="w-full gap-2"
              onClick={runApprovalOnly}
              disabled={approve.isPending}
              data-testid="button-detail-accept"
            >
              <ThumbsUp className="w-4 h-4" /> Approve quote — client said yes
            </Button>
          )}
          {awaitingJobberSchedule(booking) &&
            (blocked ? (
              <Button
                variant="outline"
                className="w-full gap-2"
                disabled
                data-testid="button-detail-schedule"
              >
                <CalendarCheck className="w-4 h-4" /> Schedule in Jobber —{" "}
                {blocked}
              </Button>
            ) : (
              <Button
                className="w-full gap-2"
                onClick={() => openPicker("accept")}
                data-testid="button-detail-schedule"
              >
                <CalendarCheck className="w-4 h-4" />
                {booking.jobberSyncError
                  ? "Retry scheduling in Jobber"
                  : "Schedule in Jobber & assign crew"}
              </Button>
            ))}
          <div className="grid grid-cols-2 gap-2">
            {active && (
              <Button
                variant="outline"
                className="gap-2"
                onClick={() => openPicker("crew")}
                data-testid="button-detail-crew"
              >
                <Users className="w-4 h-4" />
                {booking.crew && booking.crew.length > 0
                  ? "Change crew"
                  : "Assign crew"}
              </Button>
            )}
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => onEdit(booking)}
              data-testid="button-detail-edit"
            >
              <Pencil className="w-4 h-4" /> Edit &amp; reschedule
            </Button>
            {/* Set or change the price without being pushed into texting —
                the dialog opens with the calculator already expanded. */}
            <Button
              variant="outline"
              className="gap-2 text-brand-pink border-brand-pink/20 hover:bg-brand-pink/10 hover:text-brand-pink"
              onClick={() => onQuote(booking, "pricing")}
              data-testid="button-detail-quote-price"
            >
              <DollarSign className="w-4 h-4" />
              {hasQuotePrice(booking) ? "Adjust quote" : "Create quote"}
            </Button>
            <Button
              variant="outline"
              className="gap-2 text-brand-blue border-brand-blue/20 hover:bg-brand-blue/10 hover:text-brand-blue"
              onClick={() => onQuote(booking, "send")}
              data-testid="button-detail-quote"
            >
              <MessageSquareText className="w-4 h-4" />
              {booking.quoteSentAt ? "Send updated quote" : "Send quote"}
            </Button>
            {booking.jobberClientId && !booking.jobberInvoiceId ? (
              <Button
                variant="outline"
                className="gap-2"
                onClick={() => onCreateInvoice(booking)}
                disabled={invoicePending}
                data-testid="button-detail-invoice"
              >
                <Receipt className="w-4 h-4" /> Create invoice
              </Button>
            ) : booking.jobberInvoiceNumber && invoiceTarget ? (
              <Button
                variant="outline"
                className="gap-2"
                onClick={() => window.open(invoiceTarget.url, "_blank")}
                data-testid="button-detail-invoice"
              >
                <Receipt className="w-4 h-4" /> Invoice #
                {booking.jobberInvoiceNumber}
              </Button>
            ) : null}
          </div>
          {(booking.jobberWebUri ||
            booking.jobberQuoteWebUri ||
            booking.jobberJobWebUri) && (
            <div className="flex flex-wrap gap-2">
              {booking.jobberWebUri && (
                <a
                  href={booking.jobberWebUri}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="link-detail-jobber-request"
                >
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 text-green-400 border-green-800 hover:bg-green-950 hover:text-green-300"
                  >
                    <ExternalLink className="w-3.5 h-3.5" /> Request in Jobber
                  </Button>
                </a>
              )}
              {booking.jobberQuoteWebUri && (
                <a
                  href={booking.jobberQuoteWebUri}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="link-detail-jobber-quote"
                >
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 text-green-400 border-green-800 hover:bg-green-950 hover:text-green-300"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    {booking.jobberQuoteNumber
                      ? `Quote #${booking.jobberQuoteNumber}`
                      : "Quote in Jobber"}
                  </Button>
                </a>
              )}
              {booking.jobberJobWebUri && (
                <a
                  href={booking.jobberJobWebUri}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="link-detail-jobber-job"
                >
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 text-green-400 border-green-800 hover:bg-green-950 hover:text-green-300"
                  >
                    <ExternalLink className="w-3.5 h-3.5" /> Job in Jobber
                  </Button>
                </a>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
