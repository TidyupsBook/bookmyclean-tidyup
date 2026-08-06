import {
  useGetDashboardSummary,
  useGetRecentActivity,
  useGetCurrentUser,
  ActivityItem,
  useGetCompany,
  useUpdateCompany,
  getGetCompanyQueryKey,
  useListBookings,
  getListBookingsQueryKey,
  useConfirmBookingTime,
  useUpdateBooking,
  useSendRescheduleText,
  Booking,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PanelErrorBoundary } from "@/components/PanelErrorBoundary";
import { PageHeader, LoadingSpinner } from "@/components/ui/shared";
import { useToast } from "@/hooks/use-toast";
import {
  PhoneIncoming,
  CalendarCheck,
  Clock,
  TrendingUp,
  PhoneMissed,
  CheckCircle2,
  UserPlus,
  PhoneForwarded,
  AlertCircle,
  MessageSquareText,
  ThumbsUp,
  CreditCard,
  Globe,
  X,
  CalendarClock,
  Users,
} from "lucide-react";
import { format } from "date-fns";
import {
  companyTimeZone,
  formatZoned,
  isoToZonedInput,
  zonedInputToIso,
  zoneLabel,
} from "@/lib/time";

export function DashboardPage() {
  const { data: me } = useGetCurrentUser();
  // Crew see the whole dashboard except the owner/dispatch nudges below. The
  // feed itself is safe for them: the API masks customer phone numbers and
  // dollar amounts out of the messages before a cleaner ever receives them.
  const isCleaner = me?.role === "cleaner";
  const { data: summary, isLoading: isSummaryLoading } =
    useGetDashboardSummary();
  const { data: activity, isLoading: isActivityLoading } =
    useGetRecentActivity();
  const { data: company } = useGetCompany();

  if (isSummaryLoading || isActivityLoading) {
    return (
      <AppLayout>
        <LoadingSpinner className="mt-20" />
      </AppLayout>
    );
  }

  const statCards = summary
    ? [
        {
          label: "Calls Today",
          value: summary.callsToday,
          icon: PhoneIncoming,
          color: "text-blue-600",
          bg: "bg-brand-purple/20",
        },
        {
          label: "Answered Rate",
          value: `${Math.round(summary.answeredRate * 100)}%`,
          icon: TrendingUp,
          color: "text-green-400",
          bg: "bg-green-500/100/10",
        },
        {
          label: "Bookings This Week",
          value: summary.bookingsThisWeek,
          icon: CalendarCheck,
          color: "text-indigo-600",
          bg: "bg-indigo-100",
        },
        {
          label: "Avg Call Length",
          value: `${Math.round(summary.avgCallSeconds / 60)}m ${summary.avgCallSeconds % 60}s`,
          icon: Clock,
          color: "text-orange-600",
          bg: "bg-orange-100",
        },
      ]
    : [];

  return (
    <AppLayout>
      <PageHeader
        title="Dashboard"
        description={
          company?.isLive
            ? "Your AI receptionist is live and monitoring calls."
            : "Complete setup to take your AI receptionist live."
        }
      />

      {/* Every nudge below is run-the-business work for an owner or
          dispatcher. Crew see the numbers, not the to-do list. */}
      {!isCleaner &&
        company &&
        company.quoConnected &&
        company.quoNeedsReauth && (
          <div className="mb-8 bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-4">
            <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center shrink-0 mt-0.5">
              <AlertCircle className="w-5 h-5 text-red-600" />
            </div>
            <div>
              <h3 className="font-semibold text-red-900">
                Quo connection needs attention
              </h3>
              <p className="text-sm text-red-800 mt-1 mb-3">
                Quo is rejecting your API key
                {company.quoKeyLast4 ? ` (…${company.quoKeyLast4})` : ""}, so
                calls and transcripts have stopped flowing. Reconnect with a
                fresh key to get your receptionist back online.
              </p>
              <a
                href="/setup"
                className="text-sm font-medium text-red-700 bg-card border border-red-300 px-3 py-1.5 rounded shadow-sm hover:bg-red-50"
              >
                Reconnect Quo
              </a>
            </div>
          </div>
        )}

      {!isCleaner &&
        company &&
        company.quoConnected &&
        !company.ringThroughNumber &&
        !company.notificationNumber && (
          <div className="mb-8 bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-4">
            <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center shrink-0 mt-0.5">
              <AlertCircle className="w-5 h-5 text-amber-600" />
            </div>
            <div>
              <h3 className="font-semibold text-amber-900">
                Add a notification number
              </h3>
              <p className="text-sm text-amber-800 mt-1 mb-3">
                We have no phone number on file to text you if your Quo
                connection breaks or comes back online. Add a ring-through or
                notification number so outages don't go unnoticed.
              </p>
              <a
                href="/settings"
                className="text-sm font-medium text-amber-700 bg-card border border-amber-300 px-3 py-1.5 rounded shadow-sm hover:bg-amber-50"
              >
                Add a Number
              </a>
            </div>
          </div>
        )}

      {!isCleaner && company && <TimezoneNudge company={company} />}
      {!isCleaner && company && <BookingTimeReview company={company} />}

      {!isCleaner && company && !company.isLive && (
        <div className="mb-8 bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-4">
          <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center shrink-0 mt-0.5">
            <span className="text-amber-600 font-bold">!</span>
          </div>
          <div>
            <h3 className="font-semibold text-amber-900">Finish your setup</h3>
            <p className="text-sm text-amber-800 mt-1 mb-3">
              Your AI receptionist is not answering calls yet. Complete the
              onboarding checklist to go live.
            </p>
            <a
              href="/setup"
              className="text-sm font-medium text-amber-700 bg-card border border-amber-300 px-3 py-1.5 rounded shadow-sm hover:bg-amber-50"
            >
              Resume Setup
            </a>
          </div>
        </div>
      )}

      <PanelErrorBoundary label="stats overview">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {statCards.map((stat, i) => {
            const Icon = stat.icon;
            return (
              <div
                key={i}
                className="bg-card border border-border rounded-xl p-5 shadow-sm"
              >
                <div className="flex items-center gap-3 mb-3">
                  <div
                    className={`w-8 h-8 rounded-lg flex items-center justify-center ${stat.bg}`}
                  >
                    <Icon className={`w-4 h-4 ${stat.color}`} />
                  </div>
                  <div className="text-sm font-medium text-muted-foreground">
                    {stat.label}
                  </div>
                </div>
                <div className="text-3xl font-serif font-bold text-muted-foreground">
                  {stat.value}
                </div>
              </div>
            );
          })}
        </div>
      </PanelErrorBoundary>

      <PanelErrorBoundary label="recent activity feed">
        <div className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-border bg-secondary/50">
            <h2 className="font-semibold text-muted-foreground">
              Recent Activity
            </h2>
          </div>
          <div className="divide-y divide-gray-100">
            {activity?.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground text-sm">
                No recent activity. Once your AI starts taking calls, they will
                appear here.
              </div>
            ) : (
              activity?.map((item: ActivityItem) => (
                <div
                  key={item.id}
                  className="p-4 px-6 flex items-start gap-4 hover:bg-secondary transition-colors"
                >
                  <ActivityIcon type={item.type} />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-muted-foreground">
                      {item.message}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {format(new Date(item.occurredAt), "MMM d, h:mm a")}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </PanelErrorBoundary>
    </AppLayout>
  );
}

// Companies created before timezone auto-detection sat on this DB default
// (see lib/db companies schema). Only they get the confirmation nudge — an
// owner who *chose* a zone (e.g. runs the business from another region)
// should never be prompted to overwrite it.
const DEFAULT_TZ = "America/Edmonton";

/**
 * One-time nudge for companies still on the default timezone whose browser
 * reports a different zone. Dismissal is remembered per company + zone pair
 * in localStorage so owners aren't nagged again.
 */
function TimezoneNudge({
  company,
}: {
  company: { id: number; timezone?: string | null };
}) {
  const detected = (() => {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      // Only trust a zone the runtime itself recognizes as valid IANA.
      if (tz) new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return tz || null;
    } catch {
      return null;
    }
  })();
  const stored = company.timezone || null;
  const dismissKey = `tzNudgeDismissed:${company.id}:${stored}:${detected}`;
  // Track dismissal per key: if the company or mismatch pair changes, the
  // stored flag for the *new* key is re-read instead of reusing mount state.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const dismissed = (() => {
    if (dismissedKey === dismissKey) return true;
    try {
      return localStorage.getItem(dismissKey) === "1";
    } catch {
      return true;
    }
  })();
  const update = useUpdateCompany();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Only nudge the legacy-default cohort with a real, different detected zone.
  if (stored !== DEFAULT_TZ || !detected || detected === stored || dismissed)
    return null;

  const dismiss = () => {
    setDismissedKey(dismissKey);
    try {
      localStorage.setItem(dismissKey, "1");
    } catch {
      // Private-mode storage failures just mean the nudge may reappear.
    }
  };

  const accept = () => {
    update.mutate(
      { data: { timezone: detected } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetCompanyQueryKey() });
          toast({
            title: "Time zone updated",
            description: `Booking times now use ${detected.replace(/_/g, " ")}.`,
          });
        },
        onError: (error: any) => {
          toast({
            title: "Couldn't update time zone",
            description: error?.message || "Please try again from Settings.",
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <div className="mb-8 bg-blue-50 border border-blue-200 rounded-xl p-4 flex items-start gap-4">
      <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center shrink-0 mt-0.5">
        <Globe className="w-5 h-5 text-blue-600" />
      </div>
      <div className="flex-1">
        <h3 className="font-semibold text-blue-900">
          Is your time zone right?
        </h3>
        <p className="text-sm text-blue-800 mt-1 mb-3">
          Your company is set to{" "}
          <span className="font-medium">{stored.replace(/_/g, " ")}</span>, but
          your browser reports{" "}
          <span className="font-medium">{detected.replace(/_/g, " ")}</span>.
          Booking times are shown in the company time zone, so a wrong zone
          shifts every appointment.
        </p>
        <div className="flex items-center gap-3">
          <button
            onClick={accept}
            disabled={update.isPending}
            className="text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 px-3 py-1.5 rounded shadow-sm"
          >
            {update.isPending
              ? "Switching…"
              : `Switch to ${detected.replace(/_/g, " ")}`}
          </button>
          <button
            onClick={dismiss}
            className="text-sm font-medium text-blue-700 hover:text-blue-900 px-2 py-1.5"
          >
            Keep {stored.replace(/_/g, " ")}
          </button>
        </div>
      </div>
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className="text-blue-400 hover:text-blue-600 shrink-0"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

/**
 * After a timezone switch, bookings whose displayed wall-clock hour shifted
 * are flagged server-side. This panel walks the owner through each one:
 * confirm the new displayed time, or adjust it in place. Times are always
 * rendered in the *company* zone (see lib/time.ts).
 */
function BookingTimeReview({
  company,
}: {
  company: { timezone?: string | null };
}) {
  const { data: bookings } = useListBookings();
  const tz = companyTimeZone(company);
  // Bookings just rescheduled from this panel: the row disappears once the
  // review flag clears, so the "text the customer" offer lives up here.
  const [textOffers, setTextOffers] = useState<
    { id: number; customerName: string; iso: string }[]
  >([]);

  const flagged = (bookings ?? []).filter(
    (b) =>
      b.needsTimeReview &&
      (b.status === "pending" || b.status === "confirmed") &&
      new Date(b.scheduledFor).getTime() > Date.now(),
  );
  if (flagged.length === 0 && textOffers.length === 0) return null;

  const addOffer = (offer: { id: number; customerName: string; iso: string }) =>
    setTextOffers((prev) => [...prev.filter((o) => o.id !== offer.id), offer]);
  const removeOffer = (id: number) =>
    setTextOffers((prev) => prev.filter((o) => o.id !== id));

  return (
    <>
      {flagged.length > 0 && (
        <div className="mb-8 bg-amber-50 border border-amber-200 rounded-xl overflow-hidden">
          <div className="p-4 flex items-start gap-4">
            <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center shrink-0 mt-0.5">
              <CalendarClock className="w-5 h-5 text-amber-600" />
            </div>
            <div>
              <h3 className="font-semibold text-amber-900">
                {flagged.length === 1
                  ? "1 booking shifted"
                  : `${flagged.length} bookings shifted`}{" "}
                after your time zone change
              </h3>
              <p className="text-sm text-amber-800 mt-1">
                These upcoming appointments now display at a different hour than
                before. Confirm each time is what you agreed with the customer,
                or adjust it.
              </p>
            </div>
          </div>
          <div className="divide-y divide-amber-200/70 border-t border-amber-200">
            {flagged.map((b) => (
              <ReviewRow
                key={b.id}
                booking={b}
                tz={tz}
                onRescheduled={addOffer}
              />
            ))}
          </div>
        </div>
      )}
      {textOffers.length > 0 && (
        <div className="mb-8 bg-blue-50 border border-blue-200 rounded-xl overflow-hidden">
          <div className="divide-y divide-blue-200/70">
            {textOffers.map((o) => (
              <RescheduleTextOffer
                key={o.id}
                offer={o}
                tz={tz}
                onDone={() => removeOffer(o.id)}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Offered right after a reschedule: one tap texts the customer the new time
 * (in the company zone, from the same Quo line as their quote thread).
 */
function RescheduleTextOffer({
  offer,
  tz,
  onDone,
}: {
  offer: { id: number; customerName: string; iso: string };
  tz: string;
  onDone: () => void;
}) {
  const send = useSendRescheduleText();
  const { toast } = useToast();

  const onSend = () =>
    send.mutate(
      { id: offer.id },
      {
        onSuccess: () => {
          toast({
            title: "Text sent",
            description: `${offer.customerName} was texted the new time.`,
          });
          onDone();
        },
        onError: (error: any) =>
          toast({
            title: "Couldn't send the text",
            description: error?.message || "Please try again.",
            variant: "destructive",
          }),
      },
    );

  return (
    <div className="p-4 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-start gap-4 min-w-0">
        <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center shrink-0 mt-0.5">
          <MessageSquareText className="w-5 h-5 text-blue-600" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-blue-950">
            Text {offer.customerName} the new time?
          </p>
          <p className="text-sm text-blue-800 mt-0.5">
            They'll get a text saying their appointment is now{" "}
            <span className="font-semibold">
              {formatZoned(offer.iso, tz)} {zoneLabel(tz, new Date(offer.iso))}
            </span>
            .
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={onSend}
          disabled={send.isPending}
          className="text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 px-3 py-1.5 rounded shadow-sm"
        >
          {send.isPending ? "Sending…" : "Send text"}
        </button>
        <button
          onClick={onDone}
          disabled={send.isPending}
          className="text-sm font-medium text-blue-700 hover:text-blue-900 px-2 py-1.5"
        >
          Skip
        </button>
      </div>
    </div>
  );
}

function ReviewRow({
  booking,
  tz,
  onRescheduled,
}: {
  booking: Booking;
  tz: string;
  onRescheduled: (offer: {
    id: number;
    customerName: string;
    iso: string;
  }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [wallClock, setWallClock] = useState(() =>
    isoToZonedInput(booking.scheduledFor, tz),
  );
  const confirm = useConfirmBookingTime();
  const update = useUpdateBooking();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const busy = confirm.isPending || update.isPending;

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: getListBookingsQueryKey() });

  const onConfirm = () =>
    confirm.mutate(
      { id: booking.id },
      {
        onSuccess: refresh,
        onError: (error: any) =>
          toast({
            title: "Couldn't confirm the time",
            description: error?.message || "Please try again.",
            variant: "destructive",
          }),
      },
    );

  const onSave = () => {
    const iso = zonedInputToIso(wallClock, tz);
    if (!iso) {
      toast({
        title: "That time doesn't exist",
        description: `Because of a daylight-saving change, that hour is skipped in ${tz.replace(/_/g, " ")}. Pick a different time.`,
        variant: "destructive",
      });
      return;
    }
    update.mutate(
      { id: booking.id, data: { scheduledFor: iso } },
      {
        onSuccess: () => {
          refresh();
          toast({
            title: "Booking rescheduled",
            description: `${booking.customerName} is now booked for ${formatZoned(iso, tz)} ${zoneLabel(tz)}.`,
          });
          onRescheduled({
            id: booking.id,
            customerName: booking.customerName,
            iso,
          });
        },
        onError: (error: any) =>
          toast({
            title: "Couldn't reschedule",
            description: error?.message || "Please try again.",
            variant: "destructive",
          }),
      },
    );
  };

  const prevTz = booking.timeReviewPreviousTimezone;

  return (
    <div className="px-4 py-3 sm:pl-[4.5rem] bg-amber-50/60">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-amber-950">
            {booking.customerName} — {booking.service}
          </p>
          <p className="text-sm text-amber-800 mt-0.5">
            Now shows{" "}
            <span className="font-semibold">
              {formatZoned(booking.scheduledFor, tz)}{" "}
              {zoneLabel(tz, new Date(booking.scheduledFor))}
            </span>
            {prevTz && (
              <>
                {" "}
                <span className="text-amber-700">
                  (was {formatZoned(booking.scheduledFor, prevTz)}{" "}
                  {zoneLabel(prevTz, new Date(booking.scheduledFor))})
                </span>
              </>
            )}
          </p>
        </div>
        {!editing ? (
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={onConfirm}
              disabled={busy}
              className="text-sm font-medium text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-60 px-3 py-1.5 rounded shadow-sm"
            >
              {confirm.isPending ? "Confirming…" : "Time is correct"}
            </button>
            <button
              onClick={() => setEditing(true)}
              disabled={busy}
              className="text-sm font-medium text-amber-800 bg-card border border-amber-300 hover:bg-amber-100 disabled:opacity-60 px-3 py-1.5 rounded shadow-sm"
            >
              Adjust
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 shrink-0">
            <input
              type="datetime-local"
              value={wallClock}
              onChange={(e) => setWallClock(e.target.value)}
              className="text-sm border border-amber-300 rounded px-2 py-1.5 bg-card text-amber-950"
              aria-label={`New time for ${booking.customerName}'s booking (${zoneLabel(tz)})`}
            />
            <button
              onClick={onSave}
              disabled={busy || !wallClock}
              className="text-sm font-medium text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-60 px-3 py-1.5 rounded shadow-sm"
            >
              {update.isPending ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => setEditing(false)}
              disabled={busy}
              className="text-sm font-medium text-amber-700 hover:text-amber-900 px-2 py-1.5"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ActivityIcon({ type }: { type: ActivityItem["type"] }) {
  switch (type) {
    case "call_answered":
      return (
        <div className="w-8 h-8 rounded-full bg-brand-purple/20 flex items-center justify-center shrink-0">
          <PhoneForwarded className="w-4 h-4 text-blue-600" />
        </div>
      );
    case "booking_created":
      return (
        <div className="w-8 h-8 rounded-full bg-green-500/100/10 flex items-center justify-center shrink-0">
          <CalendarCheck className="w-4 h-4 text-green-400" />
        </div>
      );
    case "jobber_synced":
      return (
        <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
          <CheckCircle2 className="w-4 h-4 text-indigo-600" />
        </div>
      );
    case "jobber_sync_failed":
      return (
        <div className="w-8 h-8 rounded-full bg-red-500/10 flex items-center justify-center shrink-0">
          <AlertCircle className="w-4 h-4 text-red-400" />
        </div>
      );
    case "reschedule_texted":
      return (
        <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
          <CalendarClock className="w-4 h-4 text-blue-600" />
        </div>
      );
    case "quote_sent":
      return (
        <div className="w-8 h-8 rounded-full bg-brand-blue/10 flex items-center justify-center shrink-0">
          <MessageSquareText className="w-4 h-4 text-brand-blue" />
        </div>
      );
    case "quote_approved":
      return (
        <div className="w-8 h-8 rounded-full bg-green-500/10 flex items-center justify-center shrink-0">
          <ThumbsUp className="w-4 h-4 text-green-400" />
        </div>
      );
    case "deposit_paid":
      return (
        <div className="w-8 h-8 rounded-full bg-brand-pink/10 flex items-center justify-center shrink-0">
          <CreditCard className="w-4 h-4 text-brand-pink" />
        </div>
      );
    case "team_invited":
      return (
        <div className="w-8 h-8 rounded-full bg-brand-purple/10 flex items-center justify-center shrink-0">
          <UserPlus className="w-4 h-4 text-brand-purple" />
        </div>
      );
    case "crew_assigned":
      return (
        <div className="w-8 h-8 rounded-full bg-brand-purple/10 flex items-center justify-center shrink-0">
          <Users className="w-4 h-4 text-brand-purple" />
        </div>
      );
    case "test_call":
      return (
        <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center shrink-0">
          <PhoneIncoming className="w-4 h-4 text-muted-foreground" />
        </div>
      );
    default:
      return (
        <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center shrink-0">
          <div className="w-2 h-2 rounded-full bg-secondary" />
        </div>
      );
  }
}
