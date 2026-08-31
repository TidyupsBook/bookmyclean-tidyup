import {
  useGetDashboardSummary,
  useGetCurrentUser,
  useGetCompany,
  useUpdateCompany,
  getGetCompanyQueryKey,
  useListBookings,
  getListBookingsQueryKey,
  getGetDashboardSummaryQueryKey,
  useConfirmBookingTime,
  useUpdateBooking,
  useSendRescheduleText,
  useGetRescheduleTextPreview,
  useGetRecentActivity,
  getGetRecentActivityQueryKey,
  useResendGivenUpText,
  useListCalls,
  getListCallsQueryKey,
  useGetMapConfig,
  useGetMapData,
  getGetMapDataQueryKey,
  useListJobberQuotes,
  useGetSchedule,
  getGetScheduleQueryKey,
  useListStaffConversations,
  getListStaffConversationsQueryKey,
  useGetStaffConversation,
  getGetStaffConversationQueryKey,
  useSendStaffMessage,
  Booking,
  Company,
  DashboardSummary,
  ScheduleJob,
  ActivityItem,
  bookingDisplayName,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import {
  DatabasePausedNotice,
  useDatabasePaused,
} from "@/components/DatabasePausedNotice";
import { PanelErrorBoundary } from "@/components/PanelErrorBoundary";
import { PageHeader, LoadingSpinner } from "@/components/ui/shared";
import { JobberSyncButton } from "@/components/JobberSyncButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  PhoneIncoming,
  CalendarCheck,
  Clock,
  CheckCircle2,
  AlertCircle,
  MessageSquareText,
  Globe,
  X,
  CalendarClock,
  DollarSign,
  PhoneCall,
  MapPin,
  ArrowRight,
  Inbox,
  FileText,
} from "lucide-react";
import { format } from "date-fns";
import { MiniMap, type SearchTarget } from "@/components/MiniMap";
import {
  QuoteCalculator,
  emptyQuoteDraft,
  type QuoteDraft,
} from "@/components/QuoteCalculator";
import { AddressLookup } from "@/components/AddressLookup";
import { useHiddenCleaners, useHiddenPins } from "@/components/CleanerRoster";
import { todayInZone } from "@/lib/schedule";
import { companyQuoteRates } from "@/lib/rates";
import { saveDashboardQuoteHandoff } from "@/lib/dashboardQuoteHandoff";
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
  const databasePaused = useDatabasePaused();
  const { data: summary, isLoading: isSummaryLoading } =
    useGetDashboardSummary();
  const { data: company } = useGetCompany();
  const tz = companyTimeZone(company);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  if (isSummaryLoading) {
    return (
      <AppLayout>
        <LoadingSpinner className="mt-20" />
      </AppLayout>
    );
  }

  // Money leads for owners and dispatchers. The API hands crew a null
  // revenue — they get call volume in that slot instead, so no client-side
  // guess about who may see dollars.
  const statCards = summary
    ? [
        summary.revenueThisMonth != null
          ? {
              label: "Revenue This Month",
              value: money(summary.revenueThisMonth),
              icon: DollarSign,
              color: "text-green-400",
              bg: "bg-green-500/10",
              testid: "stat-revenue",
            }
          : {
              label: "Calls Today",
              value: String(summary.callsToday),
              icon: PhoneIncoming,
              color: "text-blue-600",
              bg: "bg-brand-purple/20",
              testid: "stat-calls-today",
            },
        {
          label: "Upcoming Bookings",
          value: String(summary.upcomingBookings),
          icon: CalendarCheck,
          color: "text-brand-blue",
          bg: "bg-brand-blue/10",
          testid: "stat-upcoming",
        },
        {
          label: "Pending Approval",
          value: String(summary.pendingBookings),
          icon: Clock,
          color: "text-amber-500",
          bg: "bg-amber-500/10",
          testid: "stat-pending",
        },
        {
          label: "Completed This Month",
          value: String(summary.completedThisMonth),
          icon: CheckCircle2,
          color: "text-green-400",
          bg: "bg-green-500/10",
          testid: "stat-completed",
        },
        // The Leads inbox tile: clicking it goes straight to the review
        // queue. Dispatch-side only — the Leads API refuses cleaners, so
        // crew get neither the count nor a link to a guaranteed 403.
        ...(isCleaner
          ? []
          : [
              {
                label: "New Leads",
                value: String(summary.newLeads),
                icon: Inbox,
                color: "text-brand-pink",
                bg: "bg-brand-pink/10",
                testid: "stat-new-leads",
                href: "/leads",
              },
            ]),
      ]
    : [];

  return (
    <AppLayout>
      <PageHeader
        title={greetingTitle(me?.name, tz)}
        description={
          company?.name
            ? `Here's what's happening at ${company.name}.`
            : "Here's what's happening today."
        }
      >
        {/* Pulling from Jobber writes bookings, so it stays with the people
            allowed to change the schedule. */}
        {!isCleaner && (
          <JobberSyncButton
            connected={Boolean(company?.jobberConnected)}
            needsReauth={Boolean(company?.jobberNeedsReauth)}
            connectHint="Connect Jobber to see your scheduled jobs reflected in these numbers."
            onSynced={() => {
              // The numbers, the feed and the booking nudges are what this
              // page shows; all of them can change when an import lands.
              queryClient.invalidateQueries({
                queryKey: getGetDashboardSummaryQueryKey(),
              });
              queryClient.invalidateQueries({
                queryKey: getListBookingsQueryKey(),
              });
            }}
          />
        )}
      </PageHeader>

      {/* Unlike the nudges below, a paused database blocks everyone —
          cleaners included — so this one is not gated by role. */}
      {databasePaused && <DatabasePausedNotice />}

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
      {!isCleaner && (
        <PanelErrorBoundary label="dropped texts">
          <DroppedTextsCard />
        </PanelErrorBoundary>
      )}

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
          {statCards.map((stat) => {
            const Icon = stat.icon;
            const card = (
              <div
                key={stat.label}
                className={`bg-card border border-border rounded-xl p-5 shadow-sm ${
                  "href" in stat && stat.href
                    ? "hover:border-brand-pink/40 transition-colors cursor-pointer"
                    : ""
                }`}
                data-testid={stat.testid}
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
            return "href" in stat && stat.href ? (
              <Link key={stat.label} href={stat.href}>
                {card}
              </Link>
            ) : (
              card
            );
          })}
        </div>
      </PanelErrorBoundary>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8 items-start">
        <div className="lg:col-span-2 space-y-6">
          <PanelErrorBoundary label="today's schedule">
            <TodayScheduleCard tz={tz} />
          </PanelErrorBoundary>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">
            <PanelErrorBoundary label="today's map">
              <DashboardMiniMap tz={tz} />
            </PanelErrorBoundary>
            {/* Prices sit beside the map, directly under today's board: a
                dispatcher can answer both "where?" and "how much?" without
                leaving the call or unexpectedly changing pages. */}
            {!isCleaner && (
              <PanelErrorBoundary label="quotes summary">
                <QuotesSummaryCard company={company} />
              </PanelErrorBoundary>
            )}
          </div>
        </div>
        <div className="space-y-6">
          {/* Calls are owner/dispatcher business — the API refuses crew, so
              the poll isn't even mounted for them. */}
          {!isCleaner && (
            <PanelErrorBoundary label="live call status">
              <LiveCallCard
                isLive={Boolean(company?.isLive)}
                quoConnected={Boolean(company?.quoConnected)}
              />
            </PanelErrorBoundary>
          )}
          <PanelErrorBoundary label="team chat">
            <TeamChatCard />
          </PanelErrorBoundary>
          <PanelErrorBoundary label="quick summary">
            <QuickSummaryCard summary={summary} />
          </PanelErrorBoundary>
        </div>
      </div>

      {/* Fielding a call is the common case this replaces the old activity
          feed for: type the customer's address, see who's closest right
          now. Dispatch/owner only — cleaners have no reason to route work. */}
      {!isCleaner && (
        <PanelErrorBoundary label="find nearest cleaner">
          <NearestCleanerCard tz={tz} />
        </PanelErrorBoundary>
      )}
    </AppLayout>
  );
}

const E164_PHONE = /^\+[1-9]\d{1,14}$/;

/**
 * The redesigned dashboard no longer shows the full activity feed, but a text
 * that exhausted its retries is still actionable. Keep those entries visible
 * until an owner or dispatcher confirms the destination and re-queues them.
 */
export function DroppedTextsCard() {
  const { data: activity, isLoading } = useGetRecentActivity();
  const droppedTexts = (activity ?? []).filter(
    (item) => item.type === "text_given_up" && item.canResendText,
  );

  if (isLoading || droppedTexts.length === 0) return null;

  return (
    <section
      className="mb-8 overflow-hidden rounded-xl border border-amber-200 bg-amber-50"
      aria-labelledby="dropped-texts-heading"
    >
      <div className="border-b border-amber-200 px-5 py-4">
        <h2 id="dropped-texts-heading" className="font-semibold text-amber-950">
          Texts that need attention
        </h2>
        <p className="mt-1 text-sm text-amber-800">
          Confirm or correct the phone number before trying again.
        </p>
      </div>
      <div className="divide-y divide-amber-200">
        {droppedTexts.map((item) => (
          <DroppedTextRow key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}

function DroppedTextRow({ item }: { item: ActivityItem }) {
  const [editing, setEditing] = useState(false);
  const [phone, setPhone] = useState(item.resendPhone ?? "");
  const [showValidation, setShowValidation] = useState(false);
  const resend = useResendGivenUpText();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const validPhone = E164_PHONE.test(phone.trim());

  const cancel = () => {
    setPhone(item.resendPhone ?? "");
    setShowValidation(false);
    setEditing(false);
  };

  const submit = () => {
    setShowValidation(true);
    if (!validPhone) return;

    resend.mutate(
      { id: item.id, data: { toPhone: phone.trim() } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getGetRecentActivityQueryKey(),
          });
          setEditing(false);
          toast({
            title: "Text queued",
            description: `We'll try ${phone.trim()} now and keep retrying if needed.`,
          });
        },
        onError: (error: any) =>
          toast({
            title: "Couldn't resend the text",
            description: error?.message || "Please try again.",
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <div className="px-5 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm text-amber-950">{item.message}</p>
          <p className="mt-1 text-xs text-amber-700">
            {format(new Date(item.occurredAt), "MMM d, h:mm a")}
          </p>
        </div>
        {!editing && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0 border-amber-300 bg-white text-amber-950 hover:bg-amber-100"
            onClick={() => setEditing(true)}
          >
            Check number & resend
          </Button>
        )}
      </div>

      {editing && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-white p-4">
          <label
            htmlFor={`resend-phone-${item.id}`}
            className="text-sm font-medium text-foreground"
          >
            Send this text to
          </label>
          <Input
            id={`resend-phone-${item.id}`}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            onChange={(event) => {
              setPhone(event.target.value);
              setShowValidation(false);
            }}
            aria-invalid={showValidation && !validPhone}
            aria-describedby={`resend-phone-help-${item.id}`}
            className="mt-2"
          />
          <p
            id={`resend-phone-help-${item.id}`}
            className={`mt-1.5 text-xs ${
              showValidation && !validPhone
                ? "text-destructive"
                : "text-muted-foreground"
            }`}
          >
            {showValidation && !validPhone
              ? "Enter a valid E.164 number, such as +15551234567."
              : "Use E.164 format: +, country code, then the phone number."}
          </p>
          <div className="mt-3 flex gap-2">
            <Button
              type="button"
              size="sm"
              onClick={submit}
              disabled={resend.isPending}
            >
              {resend.isPending ? "Queuing…" : "Resend text"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={cancel}
              disabled={resend.isPending}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
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
  // Time-review bookings are always upcoming — no need to fetch history.
  const reviewWindow = {
    since: new Date().toISOString().slice(0, 10),
    until: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10),
  };
  const { data: bookings } = useListBookings(reviewWindow);
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
  // The exact text the server would send, so the owner can tweak it (fix an
  // odd customer name, add a personal line) before it goes out.
  const { data: preview, isLoading: isPreviewLoading } =
    useGetRescheduleTextPreview(offer.id);
  const [draft, setDraft] = useState<string | null>(null);
  const message = draft ?? preview?.message ?? "";

  const onSend = () =>
    send.mutate(
      { id: offer.id, data: message.trim() ? { message: message.trim() } : {} },
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
    <div className="p-4">
      <div className="flex items-start gap-4 min-w-0">
        <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center shrink-0 mt-0.5">
          <MessageSquareText className="w-5 h-5 text-blue-600" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-blue-950">
            Text {offer.customerName} the new time?
          </p>
          <p className="text-sm text-blue-800 mt-0.5">
            They'll get a text saying their appointment is now{" "}
            <span className="font-semibold">
              {formatZoned(offer.iso, tz)} {zoneLabel(tz, new Date(offer.iso))}
            </span>
            . Tweak the wording below if you like before it goes out.
          </p>
          {isPreviewLoading ? (
            <p className="text-sm text-blue-700 mt-2 italic">
              Loading the draft…
            </p>
          ) : (
            <textarea
              value={message}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
              maxLength={1600}
              disabled={send.isPending}
              className="mt-2 w-full text-sm text-blue-950 bg-white border border-blue-200 rounded-md p-2.5 focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-60"
              data-testid={`textarea-reschedule-draft-${offer.id}`}
            />
          )}
          {preview && !preview.canSend && preview.blockedReason && (
            <p className="text-sm text-red-700 mt-1.5">
              {preview.blockedReason}
            </p>
          )}
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={onSend}
              disabled={send.isPending || isPreviewLoading || !message.trim()}
              className="text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 px-3 py-1.5 rounded shadow-sm"
              data-testid={`button-send-reschedule-text-${offer.id}`}
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
            description: `${bookingDisplayName(booking)} is now booked for ${formatZoned(iso, tz)} ${zoneLabel(tz, new Date(iso))}.`,
          });
          onRescheduled({
            id: booking.id,
            // The offer banner and its toast repeat this label verbatim, so
            // the fallback has to ride along here — a nameless booking must
            // not produce a "Text  the new time?" banner.
            customerName: bookingDisplayName(booking),
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
            {bookingDisplayName(booking)} — {booking.service}
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
              aria-label={`New time for ${bookingDisplayName(booking)}'s booking (${zoneLabel(tz)})`}
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

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** "Good morning, Sam" — by the company's clock, not the browser's. */
function greetingTitle(name: string | undefined, tz: string): string {
  let hour = new Date().getHours();
  try {
    hour =
      Number(
        new Intl.DateTimeFormat("en-US", {
          timeZone: tz,
          hour: "numeric",
          hour12: false,
        }).format(new Date()),
      ) % 24;
  } catch {
    // A bad stored zone shouldn't break the page over a greeting.
  }
  const daypart = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const first = name?.trim().split(/\s+/)[0];
  return first ? `Good ${daypart}, ${first}` : `Good ${daypart}`;
}

const CALL_POLL_MS = 10_000;

/**
 * The dashboard's answer to "is the phone actually working right now?".
 * Polls the same call list the header banner uses, so the two can't
 * disagree; test calls don't count as live here.
 */
function LiveCallCard({
  isLive,
  quoConnected,
}: {
  isLive: boolean;
  quoConnected: boolean;
}) {
  const { data: calls } = useListCalls(undefined, {
    query: {
      queryKey: getListCallsQueryKey(undefined),
      refetchInterval: CALL_POLL_MS,
    },
  });
  const live = (calls ?? []).find(
    (c) => c.status === "in_progress" && !c.isTest,
  );
  const latest = (calls ?? [])[0];

  return (
    <div
      className={`bg-card border rounded-xl shadow-sm p-5 ${
        live ? "border-red-500/40" : "border-border"
      }`}
      data-testid="card-live-call"
    >
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-muted-foreground flex items-center gap-2">
          <PhoneCall className="w-4 h-4 text-brand-pink" />
          Live Calls
        </h2>
        {live ? (
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
          </span>
        ) : (
          <span
            className={`inline-flex rounded-full h-2.5 w-2.5 ${
              isLive && quoConnected ? "bg-green-500" : "bg-amber-500"
            }`}
          />
        )}
      </div>
      {live ? (
        <div data-testid="live-call-active">
          <p className="text-sm font-semibold text-red-400">Call in progress</p>
          <p className="text-sm text-foreground mt-1 truncate">
            {live.callerName || "Unknown caller"}
          </p>
          <p className="text-xs text-muted-foreground">{live.callerPhone}</p>
          <Link
            href="/calls"
            className="inline-flex items-center gap-1 mt-3 text-xs font-medium text-brand-blue hover:underline"
          >
            Open calls <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      ) : (
        <div data-testid="live-call-idle">
          <p className="text-sm text-foreground">
            {isLive && quoConnected
              ? "Phone connected — watching for calls."
              : "Your receptionist isn't answering yet."}
          </p>
          {isLive && quoConnected ? (
            latest && (
              <p className="text-xs text-muted-foreground mt-2">
                Last call: {latest.callerName || latest.callerPhone} ·{" "}
                {format(new Date(latest.startedAt), "MMM d, h:mm a")}
              </p>
            )
          ) : (
            <Link
              href="/setup"
              className="inline-flex items-center gap-1 mt-2 text-xs font-medium text-brand-blue hover:underline"
            >
              Finish setup <ArrowRight className="w-3 h-3" />
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

const MAP_POLL_MS = 30_000;
const NO_HIDDEN_CLEANERS = new Set<number>();
const NO_HIDDEN_PINS = new Set<number>();

/**
 * Today's jobs and crew on one small map — same data and the same
 * hide-a-cleaner preferences as the Live Map, so what's hidden there stays
 * hidden here. Quietly steps aside when maps aren't configured: the
 * dashboard must not nag about an optional feature.
 */
function DashboardMiniMap({ tz }: { tz: string }) {
  const [authFailed, setAuthFailed] = useState(false);
  // Same cached query the page body uses — the booking links inside pin
  // cards are dispatch-side only, matching the Live Map's gate.
  const { data: me } = useGetCurrentUser();
  const { data: config } = useGetMapConfig();
  const { hidden: hiddenCleaners } = useHiddenCleaners();
  const { hidden: hiddenPins } = useHiddenPins();
  const ready = Boolean(config?.configured && config.apiKey) && !authFailed;
  const params = useMemo(() => ({ date: todayInZone(tz) }), [tz]);
  const { data: mapData } = useGetMapData(params, {
    query: {
      queryKey: getGetMapDataQueryKey(params),
      refetchInterval: MAP_POLL_MS,
      enabled: ready,
    },
  });

  if (!ready) return null;

  return (
    <div data-testid="card-minimap">
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-semibold text-muted-foreground flex items-center gap-2 text-sm">
          <MapPin className="w-4 h-4 text-brand-pink" />
          Today's Map
        </h2>
        <Link
          href="/map"
          className="inline-flex items-center gap-1 text-xs font-medium text-brand-blue hover:underline"
          data-testid="link-live-map"
        >
          Open live map <ArrowRight className="w-3 h-3" />
        </Link>
      </div>
      <MiniMap
        apiKey={config!.apiKey}
        mapData={mapData}
        timeZone={tz}
        hiddenCleaners={hiddenCleaners}
        hiddenPins={hiddenPins}
        bookingFocus={null}
        searchTarget={null}
        canBook={me?.role === "owner" || me?.role === "dispatcher"}
        onAuthFailed={() => setAuthFailed(true)}
      />
    </div>
  );
}

/**
 * Compact Jobber quote pulse for dispatch. Jobber has no literal "expired"
 * quote status: archived is the closest "closed without converting" bucket,
 * while drafts and change requests are still work waiting on a response.
 */
function QuotesSummaryCard({ company }: { company: Company | undefined }) {
  const { data: quotes, isLoading, isError } = useListJobberQuotes();
  const [, navigate] = useLocation();
  const [customerName, setCustomerName] = useState("");
  const [serviceName, setServiceName] = useState("");
  const [quote, setQuote] = useState<QuoteDraft>(emptyQuoteDraft);
  const rates = companyQuoteRates(company);
  const counts = useMemo(() => {
    const all = quotes ?? [];
    return {
      awaiting: all.filter((quote) =>
        ["draft", "awaiting_response", "changes_requested"].includes(
          quote.status,
        ),
      ).length,
      approved: all.filter((quote) =>
        ["approved", "converted"].includes(quote.status),
      ).length,
      expired: all.filter((quote) => quote.status === "archived").length,
    };
  }, [quotes]);
  const recentPriced = useMemo(
    () => (quotes ?? []).filter((item) => item.totalCents != null).slice(0, 3),
    [quotes],
  );
  const canContinue =
    customerName.trim().length > 0 &&
    (quote.hours ?? 0) > 0 &&
    (quote.hourlyRate ?? 0) > 0;

  const rows = [
    {
      label: "Awaiting",
      value: counts.awaiting,
      valueClass: "text-amber-500",
      testId: "quote-summary-awaiting",
    },
    {
      label: "Approved",
      value: counts.approved,
      valueClass: "text-green-400",
      testId: "quote-summary-approved",
    },
    {
      label: "Expired",
      value: counts.expired,
      valueClass: "text-muted-foreground",
      testId: "quote-summary-expired",
    },
  ];

  return (
    <div
      className="bg-card border border-border rounded-xl shadow-sm p-5"
      data-testid="card-quotes-summary"
    >
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="font-semibold text-muted-foreground flex items-center gap-2">
          <FileText className="w-4 h-4 text-brand-pink" />
          Quotes
        </h2>
        <Link
          href="/quotes"
          className="inline-flex items-center gap-1 text-xs font-medium text-brand-blue hover:underline"
          data-testid="link-quotes-summary"
        >
          View quotes <ArrowRight className="w-3 h-3" />
        </Link>
      </div>
      {isLoading ? (
        <div className="h-10 rounded bg-secondary/60 animate-pulse" />
      ) : isError ? (
        <p className="text-sm text-muted-foreground">
          Quotes are unavailable right now.
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-3 gap-2">
            {rows.map((row) => (
              <Link
                key={row.label}
                href="/quotes"
                className="rounded-lg border border-border/70 bg-secondary/30 px-2 py-2.5 text-center hover:border-brand-pink/35 hover:bg-secondary/60 transition-colors"
              >
                <dt className="text-[11px] text-muted-foreground">
                  {row.label}
                </dt>
                <dd
                  className={`mt-0.5 text-xl font-serif font-bold tabular-nums ${row.valueClass}`}
                  data-testid={row.testId}
                >
                  {row.value}
                </dd>
              </Link>
            ))}
          </dl>
          <div className="mt-3 space-y-1" data-testid="quote-price-list">
            {recentPriced.length > 0 ? (
              recentPriced.map((item) => (
                <Link
                  key={item.id}
                  href="/quotes"
                  className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-xs hover:bg-secondary/50"
                >
                  <span className="min-w-0 truncate text-muted-foreground">
                    {item.clientName || item.title || "Untitled quote"}
                  </span>
                  <strong className="shrink-0 tabular-nums text-foreground">
                    {money(item.totalCents! / 100)}
                  </strong>
                </Link>
              ))
            ) : (
              <p className="px-2 text-xs text-muted-foreground">
                No priced Jobber quotes yet.
              </p>
            )}
          </div>
        </>
      )}
      <div className="mt-5 border-t border-border pt-5 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Quick quote</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Calculate here. The booking desk opens only when you choose to
            continue.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
          <Input
            value={customerName}
            onChange={(event) => setCustomerName(event.target.value)}
            placeholder="Customer name"
            aria-label="Quick quote customer name"
          />
          <Input
            value={serviceName}
            onChange={(event) => setServiceName(event.target.value)}
            placeholder="Service (Cleaning)"
            aria-label="Quick quote service"
          />
        </div>
        <QuoteCalculator
          value={quote}
          onChange={setQuote}
          rates={rates}
          serviceName={serviceName || "Cleaning"}
        />
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          disabled={!canContinue}
          data-testid="button-continue-dashboard-quote"
          onClick={() => {
            saveDashboardQuoteHandoff({
              customerName: customerName.trim(),
              serviceName: serviceName.trim(),
              quote,
            });
            navigate("/bookings/new?intent=quote&from=dashboard");
          }}
        >
          Continue with this quote
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          Nothing is saved or sent until you continue and confirm it.
        </p>
      </div>
    </div>
  );
}

/**
 * A live dispatch aid, not a saved route: the map starts with every home
 * address and any current crew location, then an address lookup adds a
 * temporary destination pin plus the nearest-cleaner ranking above it.
 */
function NearestCleanerCard({ tz }: { tz: string }) {
  const [authFailed, setAuthFailed] = useState(false);
  const [searchTarget, setSearchTarget] = useState<SearchTarget | null>(null);
  const { data: config } = useGetMapConfig();
  const { data: me } = useGetCurrentUser();
  const ready = Boolean(config?.configured && config.apiKey) && !authFailed;
  const params = useMemo(() => ({ date: todayInZone(tz) }), [tz]);
  const { data: mapData } = useGetMapData(params, {
    query: {
      queryKey: getGetMapDataQueryKey(params),
      refetchInterval: MAP_POLL_MS,
      enabled: ready,
    },
  });

  // Google Maps is optional. The regular Today's Map card already keeps this
  // quiet when no key is configured, so this companion stays quiet as well.
  if (!ready) return null;

  return (
    <section
      className="bg-card border border-border rounded-xl shadow-sm p-5"
      data-testid="card-nearest-cleaner"
    >
      <div className="flex flex-col gap-1 mb-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-semibold text-muted-foreground flex items-center gap-2">
            <MapPin className="w-4 h-4 text-brand-pink" />
            Find nearest cleaner
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Search an address to compare it with today&apos;s live crew and
            every cleaner&apos;s home base.
          </p>
        </div>
        <Link
          href="/map"
          className="inline-flex items-center gap-1 text-xs font-medium text-brand-blue hover:underline shrink-0"
        >
          Open live map <ArrowRight className="w-3 h-3" />
        </Link>
      </div>
      <AddressLookup
        mapData={mapData}
        target={searchTarget}
        onTarget={setSearchTarget}
        testIdPrefix="dashboard-nearest"
        placeholder="Enter a customer address to find the closest cleaner"
      />
      <div className="mt-3 h-[360px] overflow-hidden rounded-xl border border-border">
        <MiniMap
          apiKey={config!.apiKey}
          mapData={mapData}
          timeZone={tz}
          hiddenCleaners={NO_HIDDEN_CLEANERS}
          hiddenPins={NO_HIDDEN_PINS}
          bookingFocus={null}
          searchTarget={searchTarget}
          canBook={me?.role === "owner" || me?.role === "dispatcher"}
          onAuthFailed={() => setAuthFailed(true)}
        />
      </div>
    </section>
  );
}

function QuickSummaryCard({
  summary,
}: {
  summary: DashboardSummary | undefined;
}) {
  if (!summary) return null;
  const rows = [
    {
      label: "Total Bookings",
      value: summary.totalBookings,
      testid: "summary-total",
    },
    {
      label: "This Week",
      value: summary.bookingsThisWeek,
      testid: "summary-week",
    },
    {
      label: "This Month",
      value: summary.bookingsThisMonth,
      testid: "summary-month",
    },
  ];
  return (
    <div
      className="bg-card border border-border rounded-xl shadow-sm p-5"
      data-testid="card-quick-summary"
    >
      <h2 className="font-semibold text-muted-foreground mb-3">
        Quick Summary
      </h2>
      <dl className="space-y-2.5">
        {rows.map((r) => (
          <div
            key={r.label}
            className="flex items-center justify-between text-sm"
          >
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd
              className="font-semibold text-foreground tabular-nums"
              data-testid={r.testid}
            >
              {r.value}
            </dd>
          </div>
        ))}
        <div className="flex items-center justify-between text-sm pt-2.5 border-t border-border">
          <dt className="text-muted-foreground">Cancelled</dt>
          <dd
            className={`font-semibold tabular-nums ${
              summary.canceledBookings === 0 ? "text-green-400" : "text-red-400"
            }`}
            data-testid="summary-cancelled"
          >
            {summary.canceledBookings}
          </dd>
        </div>
      </dl>
    </div>
  );
}

const TODAY_SHOWN = 6;
const CHAT_SHOWN = 5;

/** "9:00 AM" in the company's own timezone — never the browser's. */
function timeOfDay(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  });
}

/**
 * Today at a glance: every visit on today's board in time order, with who
 * is taking it. The full schedule page answers "this week"; this card
 * answers "what's happening right now" without leaving the dashboard.
 */
function TodayScheduleCard({ tz }: { tz: string }) {
  const today = todayInZone(tz);
  const { data: schedule } = useGetSchedule(
    { date: today },
    {
      query: {
        queryKey: getGetScheduleQueryKey({ date: today }),
        // The dashboard sits open all day; keep the board honest without
        // hammering the API.
        refetchInterval: 60_000,
      },
    },
  );

  const rows = useMemo(() => {
    if (!schedule) return [];
    const all: { job: ScheduleJob; cleaner: string | null }[] = [];
    for (const lane of schedule.cleaners)
      for (const job of lane.jobs) all.push({ job, cleaner: lane.name });
    for (const job of schedule.unassigned) all.push({ job, cleaner: null });
    return all
      .filter(({ job }) => job.status !== "canceled")
      .sort(
        (a, b) =>
          new Date(a.job.scheduledFor).getTime() -
          new Date(b.job.scheduledFor).getTime(),
      );
  }, [schedule]);

  const shown = rows.slice(0, TODAY_SHOWN);

  return (
    <div
      className="bg-card border border-border rounded-xl shadow-sm overflow-hidden"
      data-testid="card-today-schedule"
    >
      <div className="px-6 py-4 border-b border-border bg-secondary/50 flex items-center justify-between">
        <h2 className="font-semibold text-muted-foreground flex items-center gap-2">
          <CalendarCheck className="w-4 h-4 text-brand-blue" />
          Today's Schedule
        </h2>
        <Link
          href="/schedule"
          className="text-xs text-brand-blue hover:underline flex items-center gap-1"
          data-testid="link-full-schedule"
        >
          Full schedule <ArrowRight className="w-3 h-3" />
        </Link>
      </div>
      {shown.length === 0 ? (
        <div className="p-6 text-center text-sm text-muted-foreground">
          Nothing on the board today.
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {shown.map(({ job, cleaner }) => {
            const done = job.status === "completed";
            return (
              <li
                key={job.bookingId}
                className={`px-6 py-2.5 flex items-center gap-3 text-sm ${done ? "opacity-60" : ""}`}
                data-testid={`today-job-${job.bookingId}`}
              >
                <span className="w-16 shrink-0 font-medium text-foreground">
                  {timeOfDay(job.scheduledFor, tz)}
                </span>
                <span
                  className={`flex-1 truncate ${done ? "line-through" : ""}`}
                >
                  {job.customerName}
                </span>
                {done ? (
                  <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
                ) : cleaner ? (
                  <span className="text-xs text-muted-foreground truncate max-w-[8rem]">
                    {cleaner}
                  </span>
                ) : (
                  <span className="text-xs font-medium text-amber-600 bg-amber-500/10 px-2 py-0.5 rounded-full shrink-0">
                    Unassigned
                  </span>
                )}
              </li>
            );
          })}
          {rows.length > shown.length && (
            <li className="px-6 py-2 text-xs text-muted-foreground">
              + {rows.length - shown.length} more today — see the full schedule
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/**
 * The last few words of the crew's day, without leaving the dashboard. One
 * conversation at a time — by default the most recent — with just enough of
 * a composer to answer "on my way" without opening the full chat page.
 */
function TeamChatCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [chosenId, setChosenId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  const { data: convos } = useListStaffConversations({
    query: {
      queryKey: getListStaffConversationsQueryKey(),
      refetchInterval: 15_000,
    },
  });
  const activeId = chosenId ?? convos?.[0]?.id ?? null;

  // A chosen conversation that no longer exists (deleted, or this seat lost
  // access to it) must not leave the card polling a dead thread forever.
  useEffect(() => {
    if (
      chosenId !== null &&
      convos !== undefined &&
      !convos.some((c) => c.id === chosenId)
    ) {
      setChosenId(null);
    }
  }, [convos, chosenId]);

  const { data: convo } = useGetStaffConversation(activeId ?? 0, {
    query: {
      queryKey: getGetStaffConversationQueryKey(activeId ?? 0),
      enabled: activeId !== null,
      refetchInterval: 10_000,
    },
  });
  const send = useSendStaffMessage();

  const submit = () => {
    const body = draft.trim();
    if (!body || activeId === null || send.isPending) return;
    send.mutate(
      { id: activeId, data: { body } },
      {
        onSuccess: () => {
          setDraft("");
          queryClient.invalidateQueries({
            queryKey: getGetStaffConversationQueryKey(activeId),
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

  const messages = (convo?.messages ?? []).slice(-CHAT_SHOWN);

  return (
    <div
      className="bg-card border border-border rounded-xl shadow-sm overflow-hidden"
      data-testid="card-team-chat"
    >
      <div className="px-6 py-4 border-b border-border bg-secondary/50 flex items-center justify-between gap-2">
        <h2 className="font-semibold text-muted-foreground flex items-center gap-2">
          <MessageSquareText className="w-4 h-4 text-brand-pink" />
          Team Chat
        </h2>
        <Link
          href="/team-chat"
          className="text-xs text-brand-blue hover:underline flex items-center gap-1"
          data-testid="link-open-team-chat"
        >
          Open <ArrowRight className="w-3 h-3" />
        </Link>
      </div>
      {!convos || convos.length === 0 ? (
        <div className="p-6 text-center text-sm text-muted-foreground">
          No team chats yet.{" "}
          <Link href="/team-chat" className="text-brand-blue hover:underline">
            Start one
          </Link>
          .
        </div>
      ) : (
        <div className="p-4 space-y-3">
          {convos.length > 1 && (
            <select
              value={activeId ?? undefined}
              onChange={(e) => setChosenId(Number(e.target.value))}
              className="w-full text-xs bg-secondary border border-border rounded-md px-2 py-1.5 text-foreground"
              data-testid="select-chat-conversation"
            >
              {convos.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                  {c.unreadCount > 0 ? ` (${c.unreadCount} new)` : ""}
                </option>
              ))}
            </select>
          )}
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {messages.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-3">
                No messages yet — say hi.
              </p>
            ) : (
              messages.map((m) => (
                <div key={m.id} className="text-sm leading-snug">
                  <span className="font-medium text-foreground">
                    {convo && m.memberId === convo.myMemberId
                      ? "You"
                      : m.authorName}
                  </span>{" "}
                  <span className="text-muted-foreground break-words">
                    {m.body}
                  </span>
                </div>
              ))
            )}
          </div>
          <div className="flex gap-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="Message the team…"
              maxLength={2000}
              className="h-8 text-sm"
              data-testid="input-chat-message"
            />
            <Button
              size="sm"
              className="h-8"
              onClick={submit}
              disabled={send.isPending || !draft.trim()}
              data-testid="button-chat-send"
            >
              Send
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
