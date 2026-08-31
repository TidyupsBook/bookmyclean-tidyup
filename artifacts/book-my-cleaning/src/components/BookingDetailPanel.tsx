/**
 * Everything about one client's visit, opened from the schedule.
 *
 * The boards only carry enough to draw a block, so a dispatcher who wanted a
 * phone number used to be bounced to the Bookings list and left to find the
 * job again. This panel answers the three questions actually asked mid-shift:
 * who is it, how do I reach them, and how does the van get there.
 *
 * Money and Jobber state are absent for a cleaner because the server never
 * sends them — nothing here is hidden by CSS.
 */
import {
  useGetBooking,
  getGetBookingQueryKey,
  getListBookingsQueryKey,
  useGetCompany,
  useGetCurrentUser,
  useUpdateBooking,
  useApproveBooking,
  bookingDisplayName,
  type Booking,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import { useToast } from "@/hooks/use-toast";
import { LoadingSpinner } from "@/components/ui/shared";
import { Link, useLocation } from "wouter";
import {
  Calendar,
  MapPin,
  Phone,
  Mail,
  Users,
  User,
  Navigation,
  MessageSquare,
  StickyNote,
  Home,
  Pencil,
  Trash2,
  ThumbsUp,
  CalendarCheck,
  ExternalLink,
} from "lucide-react";
import { companyTimeZone, formatZoned, zoneLabel } from "@/lib/time";
import { formatDuration, formatPrice } from "@/lib/schedule";
import { fullAddress, directionsUrl } from "@/lib/directions";
import { mapFocusHref } from "@/lib/mapFocus";
import { zonedDayKey } from "@/lib/mapCalendar";
import { formatPhone, telHref } from "@/lib/phone";
import {
  clientApproved,
  jobberApprovalObserved,
} from "@/lib/bookingAcceptance";

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-secondary text-muted-foreground border-border",
  confirmed: "bg-brand-blue/10 text-brand-blue border-brand-blue/20",
  completed: "bg-green-500/10 text-green-400 border-green-500/20",
  canceled: "bg-red-500/10 text-red-400 border-red-500/20",
};

/**
 * "Confirmed" is spelled out here: it means the client said yes, and nothing
 * in the app can set it for any other reason.
 */
function statusLabel(status: string): string {
  if (status === "confirmed") return "Client confirmed";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function BookingDetailPanel({
  bookingId,
  onClose,
}: {
  bookingId: number | null;
  onClose: () => void;
}) {
  const { data: company } = useGetCompany();
  const timeZone = companyTimeZone(company);
  const { data: booking, isLoading } = useGetBooking(bookingId ?? 0, {
    query: {
      queryKey: getGetBookingQueryKey(bookingId ?? 0),
      enabled: bookingId !== null,
    },
  });

  return (
    <Dialog
      open={bookingId !== null}
      onOpenChange={(open) => !open && onClose()}
    >
      <DialogContent
        className="max-w-lg max-h-[85vh] overflow-y-auto"
        data-testid="dialog-booking-detail"
      >
        {isLoading || !booking ? (
          <div className="py-10">
            <LoadingSpinner />
          </div>
        ) : (
          <BookingDetail
            booking={booking}
            timeZone={timeZone}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function BookingDetail({
  booking,
  timeZone,
  onClose,
}: {
  booking: Booking;
  timeZone: string;
  onClose: () => void;
}) {
  const [, setLocation] = useLocation();
  const { data: me } = useGetCurrentUser();
  // Correcting a customer's address is dispatch work — the server refuses it
  // from a cleaner, so don't show them a control that will only fail.
  const canEdit = me?.role === "owner" || me?.role === "dispatcher";
  const phone = telHref(booking.customerPhone);
  const price = formatPrice(booking.quotedAmount ?? null);
  const duration = formatDuration(booking.durationMinutes ?? 0);
  const home = [
    booking.bedrooms ? `${booking.bedrooms} bed` : null,
    booking.bathrooms ? `${booking.bathrooms} bath` : null,
    booking.frequency,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <DialogHeader>
        <div className="flex items-start justify-between gap-3 pr-6">
          <DialogTitle
            className="text-xl"
            data-testid="text-detail-customer-name"
          >
            {bookingDisplayName(booking)}
          </DialogTitle>
          <Badge
            variant="outline"
            className={`shrink-0 ${
              STATUS_STYLES[booking.status] ?? STATUS_STYLES.pending
            }`}
          >
            {statusLabel(booking.status)}
          </Badge>
        </div>
        <DialogDescription>
          {booking.service}
          {duration ? ` · ${duration}` : ""}
          {price ? ` · ${price}` : ""}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 text-sm">
        <Row icon={<Calendar className="w-4 h-4" />}>
          {formatZoned(booking.scheduledFor, timeZone)}{" "}
          <span className="text-xs opacity-60">{zoneLabel(timeZone)}</span>
        </Row>

        {/* Keyed by the job: the panel stays mounted as the dispatcher moves
            between bookings, and a half-typed address must never follow them
            onto someone else's job. */}
        <AddressSection
          key={booking.id}
          booking={booking}
          canEdit={canEdit}
          onShowOnMap={() => {
            onClose();
            setLocation(
              mapFocusHref(
                booking.id,
                zonedDayKey(booking.scheduledFor, timeZone),
              ),
            );
          }}
        />

        <div className="grid grid-cols-2 gap-2">
          {phone ? (
            <Button
              asChild
              variant="outline"
              data-testid="button-call-customer"
            >
              <a href={phone}>
                <Phone className="w-4 h-4" />
                Call
              </a>
            </Button>
          ) : null}
          {booking.customerPhone ? (
            <Button
              asChild
              variant="outline"
              onClick={onClose}
              data-testid="button-text-customer"
            >
              <Link
                href={`/messages?to=${encodeURIComponent(
                  booking.customerPhone,
                )}&name=${encodeURIComponent(bookingDisplayName(booking))}`}
              >
                <MessageSquare className="w-4 h-4" />
                Text
              </Link>
            </Button>
          ) : null}
          {booking.customerEmail ? (
            <Button
              asChild
              variant="outline"
              data-testid="button-email-customer"
            >
              <a href={`mailto:${booking.customerEmail}`}>
                <Mail className="w-4 h-4" />
                Email
              </a>
            </Button>
          ) : null}
        </div>

        <div className="space-y-2 pt-1 border-t border-border">
          <Row icon={<Phone className="w-4 h-4" />}>
            {formatPhone(booking.customerPhone) || (
              <span className="opacity-60">No phone number</span>
            )}
          </Row>
          {booking.customerEmail ? (
            <Row icon={<Mail className="w-4 h-4" />}>
              {booking.customerEmail}
            </Row>
          ) : null}
          <Row icon={<Users className="w-4 h-4" />}>
            {booking.crew && booking.crew.length > 0 ? (
              booking.crew.map((c) => c.name).join(", ")
            ) : (
              <span className="opacity-60">No crew assigned yet</span>
            )}
          </Row>
          <Row icon={<User className="w-4 h-4" />}>
            Requested: {booking.service}
          </Row>
          {home ? <Row icon={<Home className="w-4 h-4" />}>{home}</Row> : null}
          {booking.extras && booking.extras.length > 0 ? (
            <Row icon={<StickyNote className="w-4 h-4" />}>
              Extras: {booking.extras.join(", ")}
            </Row>
          ) : null}
          {booking.internalNotes ? (
            <Row icon={<StickyNote className="w-4 h-4" />}>
              <span className="italic">{booking.internalNotes}</span>
            </Row>
          ) : null}
        </div>

        {canEdit ? <ApprovalSection booking={booking} /> : null}

        <Button
          asChild
          variant="outline"
          className="w-full"
          onClick={onClose}
          data-testid="link-open-in-bookings"
        >
          <Link href={`/bookings#booking-${booking.id}`}>
            Open in Bookings to edit
          </Link>
        </Button>
      </div>
    </>
  );
}

/**
 * Approval, from the schedule.
 *
 * The dispatcher who just got off the phone with the customer is usually
 * looking at the board, not the Bookings list. Approval and scheduling are
 * separate actions here too, so recording a yes never contacts Jobber.
 */
function ApprovalSection({ booking }: { booking: Booking }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: company } = useGetCompany();
  const approve = useApproveBooking();

  const approved = clientApproved(booking);
  const approvedInJobber = jobberApprovalObserved(booking);
  const blocked = company?.jobberNeedsReauth
    ? "Reconnect Jobber to schedule this job."
    : !company?.jobberConnected
      ? "Connect Jobber to schedule this job."
      : !booking.jobberQuoteId
        ? "This booking has no Jobber quote yet."
        : null;

  const run = (schedule: boolean) => {
    approve.mutate(
      { id: booking.id, data: { schedule } },
      {
        onSuccess: (result: any) => {
          queryClient.invalidateQueries({
            queryKey: getGetBookingQueryKey(booking.id),
          });
          queryClient.invalidateQueries({
            queryKey: getListBookingsQueryKey(),
          });
          queryClient.invalidateQueries({ queryKey: ["/api/bookings/range"] });
          const unmatched: string[] = result?.unmatchedCrew ?? [];
          if (result?.jobberError) {
            toast({
              title: "Jobber didn't schedule it",
              description: `${result.jobberError} The existing approval is unchanged.`,
              variant: "destructive",
            });
            return;
          }
          toast({
            title: schedule ? "Scheduled in Jobber" : "Approval recorded",
            description:
              unmatched.length > 0
                ? `${unmatched.join(", ")} couldn't be matched to a Jobber user — the visit went out without them.`
                : `${bookingDisplayName(booking)} is confirmed.`,
          });
        },
        onError: (error: any) => {
          toast({
            title: schedule
              ? "Could not schedule in Jobber"
              : "Could not record the approval",
            description:
              error?.data?.error || error?.message || "Please try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <div className="space-y-2 pt-1 border-t border-border">
      {approved ? (
        <Row icon={<ThumbsUp className="w-4 h-4" />}>
          <span data-testid="text-approval-state">
            {approvedInJobber &&
            !booking.clientApprovedAt &&
            !booking.quoteApprovedAt
              ? "Approved in Jobber"
              : booking.quoteApprovedAt
                ? "Approved from quote link"
                : "Approved in Book My Cleaning"}
            {booking.clientApprovedBy
              ? ` · recorded by ${booking.clientApprovedBy}`
              : ""}
          </span>
        </Row>
      ) : (
        <Button
          variant="outline"
          className="w-full"
          disabled={approve.isPending || booking.status === "canceled"}
          onClick={() => run(false)}
          data-testid="button-approve-booking"
        >
          <ThumbsUp className="w-4 h-4" />
          Approve quote — client said yes
        </Button>
      )}
      {!approved || booking.jobberCreatedJobId ? null : (
        <Button
          variant="outline"
          className="w-full"
          disabled={
            approve.isPending ||
            blocked !== null ||
            booking.status === "canceled"
          }
          title={blocked ?? undefined}
          onClick={() => run(true)}
          data-testid="button-approve-schedule-booking"
        >
          <CalendarCheck className="w-4 h-4" />
          {blocked ? `Schedule in Jobber — ${blocked}` : "Schedule in Jobber"}
        </Button>
      )}
      {booking.jobberJobWebUri ? (
        <Button
          asChild
          variant="outline"
          className="w-full"
          data-testid="link-jobber-job"
        >
          <a
            href={booking.jobberJobWebUri}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink className="w-4 h-4" />
            View scheduled job in Jobber
          </a>
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The address, and everything a dispatcher does with it: look at it on our own
 * map, drive to it, correct it, or take it off the job entirely.
 *
 * Editing lives here rather than only in the Bookings form because a wrong
 * address is usually noticed mid-shift, from the schedule — being sent back to
 * another page to fix a missing city is how it stays missing. Saving clears
 * the old map pin server-side, so a corrected address can't keep pointing the
 * van at the previous house.
 */
function AddressSection({
  booking,
  canEdit,
  onShowOnMap,
}: {
  booking: Booking;
  canEdit: boolean;
  onShowOnMap: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateBooking = useUpdateBooking();
  const [editing, setEditing] = useState(false);
  const [street, setStreet] = useState(booking.customerAddress ?? "");
  const [addressLine2, setAddressLine2] = useState(booking.addressLine2 ?? "");
  const [city, setCity] = useState(booking.addressCity ?? "");
  const [province, setProvince] = useState(booking.addressProvince ?? "");
  const [postal, setPostal] = useState(booking.addressPostal ?? "");

  const address = fullAddress(booking);
  const directions = directionsUrl(booking);

  const refresh = () => {
    queryClient.invalidateQueries({
      queryKey: getGetBookingQueryKey(booking.id),
    });
    queryClient.invalidateQueries({ queryKey: getListBookingsQueryKey() });
    // Prefix matches every dated range and map view currently cached — the pin
    // moved, so none of them are right any more.
    queryClient.invalidateQueries({ queryKey: ["/api/bookings/range"] });
    queryClient.invalidateQueries({ queryKey: ["/api/map/data"] });
  };

  const save = (
    data: {
      customerAddress: string | null;
      addressLine2: string | null;
      addressCity: string | null;
      addressProvince: string | null;
      addressPostal: string | null;
    },
    done: string,
  ) => {
    updateBooking.mutate(
      { id: booking.id, data },
      {
        onSuccess: () => {
          refresh();
          setEditing(false);
          toast({ title: done });
        },
        onError: (error: any) => {
          toast({
            title: "Couldn't save that address",
            description: error?.message || "Please try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const startEditing = () => {
    setStreet(booking.customerAddress ?? "");
    setAddressLine2(booking.addressLine2 ?? "");
    setCity(booking.addressCity ?? "");
    setProvince(booking.addressProvince ?? "");
    setPostal(booking.addressPostal ?? "");
    setEditing(true);
  };

  if (editing) {
    return (
      <div className="space-y-3 rounded-lg border border-border p-3">
        <div className="space-y-1.5">
          <Label htmlFor="detail-street">Street address</Label>
          <AddressAutocomplete
            id="detail-street"
            testId="input-detail-street"
            value={street}
            onChange={setStreet}
            placeholder="123 Main St"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="detail-address-line-2">
            Unit / suite / apartment (optional)
          </Label>
          <Input
            id="detail-address-line-2"
            data-testid="input-detail-address-line-2"
            value={addressLine2}
            onChange={(e) => setAddressLine2(e.target.value)}
            placeholder="Unit 204"
          />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="detail-city">City</Label>
            <Input
              id="detail-city"
              data-testid="input-detail-city"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder="Edmonton"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="detail-province">Province</Label>
            <Input
              id="detail-province"
              data-testid="input-detail-province"
              value={province}
              onChange={(e) => setProvince(e.target.value)}
              placeholder="AB"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="detail-postal">Postal code</Label>
            <Input
              id="detail-postal"
              data-testid="input-detail-postal"
              value={postal}
              onChange={(e) => setPostal(e.target.value)}
              placeholder="T5J 0N3"
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Adding the city is what makes directions and the map pin accurate — a
          street on its own matches dozens of houses.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            className="bg-brand-pink hover:bg-brand-pink/90"
            disabled={updateBooking.isPending}
            data-testid="button-save-address"
            onClick={() =>
              save(
                {
                  customerAddress: street.trim() || null,
                  addressLine2: addressLine2.trim() || null,
                  addressCity: city.trim() || null,
                  addressProvince: province.trim() || null,
                  addressPostal: postal.trim() || null,
                },
                "Address updated",
              )
            }
          >
            {updateBooking.isPending ? "Saving…" : "Save address"}
          </Button>
          <Button
            variant="ghost"
            disabled={updateBooking.isPending}
            data-testid="button-cancel-address"
            onClick={() => setEditing(false)}
          >
            Cancel
          </Button>
          {address ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  className="text-red-400 hover:text-red-300"
                  disabled={updateBooking.isPending}
                  data-testid="button-remove-address"
                >
                  <Trash2 className="w-4 h-4" />
                  Remove
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove this address?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The job stays on the schedule, but it loses its map pin and
                    directions until an address is added again.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep it</AlertDialogCancel>
                  <AlertDialogAction
                    data-testid="button-confirm-remove-address"
                    onClick={() =>
                      save(
                        {
                          customerAddress: null,
                          addressLine2: null,
                          addressCity: null,
                          addressProvince: null,
                          addressPostal: null,
                        },
                        "Address removed",
                      )
                    }
                  >
                    Remove address
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <>
      <Row icon={<MapPin className="w-4 h-4" />}>
        {address ? (
          <span data-testid="text-detail-address">{address}</span>
        ) : (
          <span className="opacity-60">Address not provided</span>
        )}
        {canEdit ? (
          <button
            type="button"
            className="ml-2 text-xs underline underline-offset-2 text-muted-foreground hover:text-foreground"
            data-testid="button-edit-address"
            onClick={startEditing}
          >
            <Pencil className="w-3 h-3 inline mr-1" />
            {address ? "Change" : "Add"}
          </button>
        ) : null}
      </Row>

      {/* Looking at where a job is stays inside the app — the live map opens
          on this pin. Leaving for Google Maps is reserved for the one thing
          it does better: turn-by-turn driving. */}
      {address ? (
        <Button
          variant="outline"
          className="w-full"
          data-testid="button-show-on-map"
          onClick={onShowOnMap}
        >
          <MapPin className="w-4 h-4" />
          Show on map
        </Button>
      ) : null}

      {/* The whole reason the panel exists: one tap from here to the door. */}
      {directions ? (
        <Button
          asChild
          className="w-full bg-brand-pink hover:bg-brand-pink/90"
          data-testid="button-get-directions"
        >
          <a href={directions} target="_blank" rel="noopener noreferrer">
            <Navigation className="w-4 h-4" />
            Get directions
          </a>
        </Button>
      ) : address ? (
        <p className="text-xs text-muted-foreground">
          Add a city to this address and directions will appear here.
        </p>
      ) : null}
    </>
  );
}

function Row({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 text-muted-foreground">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="text-foreground/90">{children}</span>
    </div>
  );
}
