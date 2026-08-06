import { useEffect, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PanelErrorBoundary } from "@/components/PanelErrorBoundary";
import { PageHeader, LoadingSpinner } from "@/components/ui/shared";
import {
  useListBookings,
  useUpdateBooking,
  useCreateBooking,
  useSyncBookingToJobber,
  useGetCompany,
  useGetQuotePreview,
  useSendQuote,
  useSetBookingCrew,
  useListTeamMembers,
  useGetCurrentUser,
  getListBookingsQueryKey,
  getGetQuotePreviewQueryKey,
  Booking,
} from "@workspace/api-client-react";
import { Link } from "wouter";
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
import {
  companyTimeZone,
  defaultScheduledFor,
  formatZoned,
  isoToZonedInput,
  zonedInputToIso,
  zoneLabel,
} from "@/lib/time";
import {
  Calendar,
  MapPin,
  Phone,
  User,
  CheckCircle2,
  MoreHorizontal,
  RefreshCw,
  ExternalLink,
  AlertCircle,
  Plus,
  MessageSquareText,
  Pencil,
  DollarSign,
  ThumbsUp,
  CreditCard,
  Users,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  QuoteCalculator,
  emptyQuoteDraft,
  type QuoteDraft,
} from "@/components/QuoteCalculator";
import { companyQuoteRates } from "@/lib/rates";
import {
  messageContainsQuotePrice,
  quotedPriceAnchor,
} from "@workspace/pricing";

type BookingStatus = "pending" | "confirmed" | "completed" | "canceled";

/** Quotes always show cents, matching the printed estimates. */
/**
 * The headline number on a booking card.
 *
 * Once a quote has been texted, that price is what the customer was promised,
 * so it wins over anything recomputed from today's rates. If the two have since
 * diverged — the owner changed a rate, or the dispatcher re-priced the job —
 * say so, because the fix is to send an updated quote, not to quietly show a
 * number the customer has never seen.
 */
function BookingPrice({ booking }: { booking: Booking }) {
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
          title={`Quoted to the customer: subtotal ${formatMoney(sent.subtotal)} + tax & fees`}
        >
          {formatMoney(sent.total)}
        </span>
        {changed && (
          <span
            className="text-[11px] text-amber-400"
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
      title={`Subtotal ${formatMoney(current.subtotal)} + tax & fees`}
    >
      {formatMoney(current.total)}
    </span>
  );
}

function formatMoney(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  return `${sign}$${Math.abs(amount).toFixed(2)}`;
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

  // Dispatchers don't clean, and someone taken off the roster shouldn't be
  // offered — but keep anyone already on this job so an old assignment stays
  // visible and can be removed rather than silently vanishing.
  const assignable = (team ?? []).filter(
    (m) => m.role !== "dispatcher" && (m.active || selected.includes(m.id)),
  );

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
                ? `${selected.length} ${selected.length === 1 ? "person" : "people"} on ${booking.customerName}'s job.`
                : `Nobody is assigned to ${booking.customerName}'s job.`,
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
            Choose everyone working {booking?.customerName}&apos;s job. They
            will see it on their own schedule.
          </DialogDescription>
        </DialogHeader>

        {assignable.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            You haven&apos;t added any cleaners yet. Invite them from the Team
            page first.
          </p>
        ) : (
          <div className="space-y-1 py-2 max-h-72 overflow-y-auto">
            {assignable.map((member) => {
              const isOn = selected.includes(member.id);
              return (
                <button
                  key={member.id}
                  type="button"
                  onClick={() => toggle(member.id)}
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
                  <span className="flex-1 text-sm font-medium">
                    {member.name}
                  </span>
                  {!member.hasLogin && (
                    <span className="text-xs opacity-60">not signed up</span>
                  )}
                </button>
              );
            })}
          </div>
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
  const { data: bookings, isLoading } = useListBookings();
  const { data: me } = useGetCurrentUser();
  // Cleaners get a read-mostly view of their own jobs: no quoting, no
  // reassigning, no Jobber. The API enforces the same thing.
  const canDispatch = (me?.role ?? "owner") !== "cleaner";
  const [crewBooking, setCrewBooking] = useState<Booking | null>(null);
  const { data: company } = useGetCompany();
  const jobberConnected = Boolean(company?.jobberConnected);
  const jobberNeedsReauth = Boolean(company?.jobberNeedsReauth);
  // Everything on this page is shown in the company's own time, not the
  // browser's, so what a dispatcher sees matches what the customer is texted.
  const timeZone = companyTimeZone(company);
  const updateBooking = useUpdateBooking();
  const syncJobber = useSyncBookingToJobber();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [formBooking, setFormBooking] = useState<Booking | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [quoteBooking, setQuoteBooking] = useState<Booking | null>(null);

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
        title="Bookings"
        description={
          jobberConnected
            ? "Jobs booked from AI receptionist calls, plus anything you add by hand."
            : "Quote, schedule and book — all in one place."
        }
      >
        {canDispatch && (
          <Button onClick={openNew} className="gap-2">
            <Plus className="w-4 h-4" /> Add booking
          </Button>
        )}
      </PageHeader>

      <PanelErrorBoundary label="bookings list">
        {isLoading ? (
          <LoadingSpinner className="mt-20" />
        ) : !bookings || bookings.length === 0 ? (
          <div className="bg-card border border-border rounded-xl shadow-sm p-12 text-center">
            <div className="w-12 h-12 bg-secondary rounded-full flex items-center justify-center mx-auto mb-4">
              <Calendar className="w-6 h-6 text-muted-foreground" />
            </div>
            <h3 className="font-semibold text-muted-foreground mb-1">
              No bookings yet
            </h3>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto mb-5">
              When your AI receptionist books a customer it will appear here —
              or add one yourself for a walk-in or repeat client.
            </p>
            <Button onClick={openNew} variant="outline" className="gap-2">
              <Plus className="w-4 h-4" /> Add your first booking
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {bookings.map((booking: Booking) => (
              <div
                key={booking.id}
                className="bg-card border border-border rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow flex flex-col"
              >
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h3 className="font-bold text-lg text-foreground">
                      {booking.customerName}
                    </h3>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <BookingStatusBadge status={booking.status} />
                      {booking.quoteApprovedAt ? (
                        // Approval supersedes "quote sent" — showing both just
                        // adds noise to a row the dispatcher scans at a glance.
                        <span className="flex items-center gap-1 text-xs font-medium text-green-400 bg-green-500/10 px-2 py-0.5 rounded-full border border-green-500/20">
                          <ThumbsUp className="w-3 h-3" /> Quote approved
                        </span>
                      ) : booking.quoteSentAt ? (
                        <span className="flex items-center gap-1 text-xs font-medium text-brand-blue bg-brand-blue/10 px-2 py-0.5 rounded-full border border-brand-blue/20">
                          <MessageSquareText className="w-3 h-3" /> Quote sent
                        </span>
                      ) : null}
                      {booking.depositPaidAt && (
                        <span className="flex items-center gap-1 text-xs font-medium text-brand-pink bg-brand-pink/10 px-2 py-0.5 rounded-full border border-brand-pink/20">
                          <CreditCard className="w-3 h-3" /> Deposit paid
                        </span>
                      )}
                      {booking.jobberSynced && (
                        <span className="flex items-center gap-1 text-xs font-medium text-green-400 bg-green-500/10 px-2 py-0.5 rounded-full border border-green-500/20">
                          <CheckCircle2 className="w-3 h-3" /> Jobber
                        </span>
                      )}
                    </div>
                  </div>
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
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() =>
                            handleStatusChange(booking.id, "confirmed")
                          }
                        >
                          Mark Confirmed
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() =>
                            handleStatusChange(booking.id, "completed")
                          }
                        >
                          Mark Completed
                        </DropdownMenuItem>
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
                    <span>
                      {booking.customerAddress || "Address not provided"}
                    </span>
                  </div>
                  <div className="flex items-start gap-3">
                    <Phone className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>{booking.customerPhone}</span>
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

                {/* Quoting, money and Jobber are dispatch work. Hidden for
                  cleaners to match what the API will actually allow. */}
                {canDispatch && (
                  <div className="mt-5 pt-4 border-t border-border grid gap-2">
                    <Button
                      variant="outline"
                      className="w-full gap-2 text-brand-blue border-brand-blue/20 hover:bg-brand-blue/10 hover:text-brand-blue"
                      onClick={() => setQuoteBooking(booking)}
                    >
                      <MessageSquareText className="w-4 h-4" />
                      {booking.quoteSentAt
                        ? "Send updated quote"
                        : "Send quote"}
                    </Button>

                    {jobberNeedsReauth && !booking.jobberSynced ? (
                      <Link href="/setup">
                        <Button
                          variant="outline"
                          className="w-full gap-2 text-amber-400 border-amber-800 hover:bg-amber-950 hover:text-amber-300"
                        >
                          <RefreshCw className="w-4 h-4" /> Reconnect Jobber to
                          sync
                        </Button>
                      </Link>
                    ) : jobberConnected && !booking.jobberSynced ? (
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
                        <Button
                          variant="outline"
                          className="w-full text-primary hover:text-primary hover:bg-primary/5 border-primary/20 gap-2"
                          onClick={() => handleSync(booking.id)}
                          disabled={syncJobber.isPending}
                        >
                          <RefreshCw
                            className={`w-4 h-4 ${syncJobber.isPending ? "animate-spin" : ""}`}
                          />
                          {syncJobber.isPending
                            ? "Syncing..."
                            : "Sync to Jobber"}
                        </Button>
                      </div>
                    ) : booking.jobberSynced && booking.jobberWebUri ? (
                      <a
                        href={booking.jobberWebUri}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <Button
                          variant="outline"
                          className="w-full gap-2 text-green-400 border-green-800 hover:bg-green-950 hover:text-green-300"
                        >
                          <ExternalLink className="w-4 h-4" /> View in Jobber
                        </Button>
                      </a>
                    ) : null}
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
      {quoteBooking && (
        <QuoteDialog
          booking={quoteBooking}
          open
          onOpenChange={(open) => !open && setQuoteBooking(null)}
        />
      )}
      <AssignCrewDialog
        booking={crewBooking}
        onClose={() => setCrewBooking(null)}
      />
    </AppLayout>
  );
}

function QuoteDialog({
  booking,
  open,
  onOpenChange,
}: {
  booking: Booking;
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
  const rates = companyQuoteRates(company);
  const [message, setMessage] = useState("");
  const [touched, setTouched] = useState(false);
  // Armed after the first Send click on a message whose price no longer
  // matches the calculator — the second click is the explicit confirmation.
  const [mismatchArmed, setMismatchArmed] = useState(false);

  // Inline price editing, so knocking $20 off a job doesn't mean closing the
  // dialog and finding the booking again. The draft starts from what's stored
  // on the booking; nothing is saved until "Save price" is pressed.
  const [showPricing, setShowPricing] = useState(false);
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
            description: `Texted to ${booking.customerName} at ${booking.customerPhone}.`,
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
          <DialogTitle>Text a quote to {booking.customerName}</DialogTitle>
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
            {(booking.quoteTotals?.subtotal ?? 0) === 0 && (
              <div className="text-sm text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
                No price set yet. Use <strong>Adjust price</strong> below to
                price the job, or type the amount straight into the message.
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
                {preview.totals.feesRate > 0 && (
                  <div className="flex justify-between gap-4 text-muted-foreground">
                    <span>
                      {preview.totals.feesLabel} (
                      {formatRate(preview.totals.feesRate)})
                    </span>
                    <span className="tabular-nums">
                      {formatMoney(preview.totals.feesAmount)}
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
  const valid =
    customerName.trim() &&
    customerPhone.trim() &&
    service.trim() &&
    scheduledFor;

  const handleSubmit = () => {
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
        description: `${payload.customerName} — ${payload.service}.`,
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
                Customer name
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
                Phone
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
            <Label htmlFor="b-service" className="mb-2 block">
              Service
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
              <span className="text-muted-foreground font-normal">
                (optional)
              </span>
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

function BookingStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "pending":
      return (
        <Badge className="bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 border-0">
          Pending
        </Badge>
      );
    case "confirmed":
      return (
        <Badge className="bg-blue-500/15 text-blue-300 hover:bg-blue-500/25 border-0">
          Confirmed
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
