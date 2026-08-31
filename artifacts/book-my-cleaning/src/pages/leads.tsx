import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader, LoadingSpinner } from "@/components/ui/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  useListLeads,
  useDismissLead,
  useBulkDismissLeads,
  useSyncLeads,
  useSyncLeadToJobber,
  useUpdateLeadTag,
  useGetLeadSyncStatus,
  useGetLeadSyncPreview,
  useUpdateLeadContact,
  getListLeadsQueryKey,
  getGetLeadSyncStatusQueryKey,
  getGetLeadSyncPreviewQueryKey,
  getGetDashboardSummaryQueryKey,
  useGetMapConfig,
  useGetCompany,
  Lead,
} from "@workspace/api-client-react";
import { CallDetailModal } from "./calls";
import { LeadsMap } from "@/components/LeadsMap";
import { LeadsTable } from "@/components/LeadsTable";
import {
  LeadCalledBadge,
  LeadSourceBadge,
  LeadStatusBadge,
} from "@/components/lead-badges";
import { TagChip, TagPicker } from "@/components/TagControls";
import {
  Inbox,
  RefreshCw,
  AlertCircle,
  Phone,
  Mail,
  MapPin,
  CalendarClock,
  Globe,
  Megaphone,
  Briefcase,
  FileSpreadsheet,
  MessageSquare,
  BedDouble,
  Bath,
  ExternalLink,
  List,
  Table2 as TableIcon,
  Map as MapIcon,
  X,
  PhoneIncoming,
  CheckCircle2,
  DollarSign,
  Pencil,
  ChevronDown,
  Trash2,
  Eye,
  Info,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Link } from "wouter";
import { acknowledgeWebsiteLeads } from "@/lib/websiteLeadAlerts";
import { AddressPlacementWarning } from "@/components/AddressPlacementWarning";

/**
 * The Leads inbox: Facebook/Instagram lead-ad rows synced from the leads
 * Google Sheet, requests from our own website form, and requests submitted
 * on the Jobber form — ready to be reviewed and turned into bookings.
 *
 * Everything shown is the customer's raw text on purpose — "1 or 2"
 * bedrooms and a requested date like "this weekend?" are what the customer
 * actually typed, and the dispatcher should see that, not a guess at what
 * it meant.
 */

type LeadFilter = "new" | "converted" | "dismissed" | "all";

type LeadSource = "all" | "form" | "jobber" | "sheet";
const FILTERS: { id: LeadFilter; label: string }[] = [
  { id: "new", label: "New" },
  { id: "converted", label: "Converted" },
  { id: "dismissed", label: "Dismissed" },
  { id: "all", label: "All" },
];

const SOURCE_FILTERS: { id: LeadSource; label: string }[] = [
  { id: "all", label: "All sources" },
  { id: "form", label: "Website form" },
  { id: "jobber", label: "From Jobber" },
  { id: "sheet", label: "From Google Sheet" },
];
function Detail({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Phone;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <Icon className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
      <span className="text-muted-foreground shrink-0">{label}:</span>
      <span className="text-foreground min-w-0 break-words">{children}</span>
    </div>
  );
}

/** Inline form to add or edit a phone number or email on a lead card. */
function ContactEditForm({
  lead,
  field,
  onClose,
  onSaved,
}: {
  lead: Lead;
  field: "phone" | "email";
  onClose: () => void;
  onSaved: (updated: Lead) => void;
}) {
  const { toast } = useToast();
  const update = useUpdateLeadContact();
  const current =
    field === "phone" ? lead.phoneDisplay.trim() || "" : (lead.email ?? "");
  const [value, setValue] = useState(current);

  const handleSave = () => {
    const data =
      field === "phone" ? { phone: value.trim() } : { email: value.trim() };
    update.mutate(
      { id: lead.id, data },
      {
        onSuccess: (updated) => {
          onSaved(updated);
          onClose();
        },
        onError: (err) => {
          const msg =
            err instanceof Error ? err.message : "Couldn't save that.";
          toast({
            title: "Couldn't save",
            description: msg,
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <div
      className="flex items-center gap-2 mt-1"
      data-testid={`edit-${field}-form-${lead.id}`}
    >
      <Input
        className="h-7 text-sm flex-1"
        placeholder={
          field === "phone" ? "e.g. 555-123-4567" : "e.g. name@example.com"
        }
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSave();
          if (e.key === "Escape") onClose();
        }}
        autoFocus
        data-testid={`edit-${field}-input-${lead.id}`}
      />
      <Button
        size="sm"
        className="h-7 px-2.5"
        disabled={update.isPending}
        onClick={handleSave}
        data-testid={`edit-${field}-save-${lead.id}`}
      >
        Save
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2"
        onClick={onClose}
        data-testid={`edit-${field}-cancel-${lead.id}`}
      >
        <X className="w-3.5 h-3.5" />
      </Button>
    </div>
  );
}
/**
 * One lead in the inbox. Renders compact — a single header line with the
 * name, status and a one-line summary — and opens to the full details and
 * actions when clicked. The map's selected card opens already expanded
 * (clicking a pin means "show me this lead").
 */
function LeadCard({
  lead: initialLead,
  defaultExpanded = false,
  selectionMode = false,
  selected = false,
  onSelectionChange,
}: {
  lead: Lead;
  defaultExpanded?: boolean;
  /** The list view can temporarily turn new cards into multi-select rows. */
  selectionMode?: boolean;
  selected?: boolean;
  onSelectionChange?: (checked: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [lead, setLead] = useState(initialLead);
  // Keep in sync when the parent list re-fetches and passes new data.
  useEffect(() => {
    setLead(initialLead);
  }, [initialLead]);

  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const dismiss = useDismissLead();
  const syncJobber = useSyncLeadToJobber();
  const updateTag = useUpdateLeadTag();
  // Which contact field is being edited inline right now; null = closed.
  const [editingField, setEditingField] = useState<"phone" | "email" | null>(
    null,
  );
  // When the owner clicks "Create quote" on a lead with no phone, we show an
  // inline nudge instead of navigating — then clear it when phone is added.
  const [showQuotePhoneNudge, setShowQuotePhoneNudge] = useState(false);
  // The call detail modal opened from the "Called" row; null = closed.
  const [viewCallId, setViewCallId] = useState<number | null>(null);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
    queryClient.invalidateQueries({
      queryKey: getGetDashboardSummaryQueryKey(),
    });
  };

  const handleContactSaved = (updated: Lead) => {
    setLead(updated);
    // The quote form reads this lead through its own prefill query. Update it
    // immediately so navigating straight from a repaired card cannot reuse a
    // stale "no phone" snapshot while the list invalidation refetches.
    queryClient.setQueryData(["lead-prefill", updated.id], updated);
    queryClient.setQueryData<Lead[]>(getListLeadsQueryKey(), (current) =>
      current?.map((candidate) =>
        candidate.id === updated.id ? updated : candidate,
      ),
    );
    refresh();
    // If the phone just got filled in and the owner had the quote nudge open,
    // clear it now that the destination exists.
    if (updated.phoneE164) setShowQuotePhoneNudge(false);
  };

  const address = [lead.streetAddress, lead.city, lead.province, lead.postCode]
    .filter(Boolean)
    .join(", ");
  const source = [lead.platform, lead.campaignName].filter(Boolean).join(" · ");
  const submitted = lead.createdTime || null;

  // The collapsed card's one-line glance: enough to recognize the lead
  // without opening it.
  const summary = [lead.phoneDisplay?.trim(), lead.service, address]
    .filter(Boolean)
    .join(" · ");

  const missingPhone = !lead.phoneE164;
  const missingEmail = !lead.email;

  // One dismiss for every entry point on the card — the quick X in the
  // header and the button in the expanded actions behave identically.
  const handleDismiss = () =>
    dismiss.mutate(
      { id: lead.id },
      {
        onSuccess: refresh,
        onError: () =>
          toast({
            title: "Couldn't dismiss that lead",
            description: "It may already be archived.",
            variant: "destructive",
          }),
      },
    );

  return (
    <div
      className={cn(
        "bg-card border border-border rounded-xl shadow-sm",
        selected && "ring-2 ring-primary border-primary",
      )}
      data-testid={`lead-card-${lead.id}`}
    >
      <div className="flex items-start">
        {/* This lives outside the expandable card button so checking a lead
            never opens the card. Only New leads are dismissable in bulk. */}
        {selectionMode && lead.status === "new" && (
          <div className="shrink-0 pt-5 pl-5">
            <Checkbox
              checked={selected}
              onCheckedChange={(checked) =>
                onSelectionChange?.(checked === true)
              }
              aria-label={`Select lead ${lead.name || lead.id}`}
              data-testid={`card-select-lead-${lead.id}`}
            />
          </div>
        )}
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          className="flex-1 min-w-0 text-left p-5 space-y-1"
          data-testid={`button-toggle-lead-${lead.id}`}
        >
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-semibold text-foreground">
                  {lead.name || "No name given"}
                </h3>
                <LeadStatusBadge status={lead.status} />
                {/* Where the lead came from: each source has its own color
                  (purple = website form, green = Jobber, blue = sheet) so
                  the office can tell them apart at a glance. */}
                <LeadSourceBadge lead={lead} />
                {/* They've been on the phone with us — server-decided, so it
                  means the same thing here and on mobile. */}
                <LeadCalledBadge lead={lead} />
                {lead.source === "sheet" && lead.sourceTab && (
                  <span className="text-xs text-muted-foreground">
                    {lead.sourceTab}
                  </span>
                )}
                {/* The verdict rides in the header so it's visible while
                  scanning collapsed rows — spotting spam is the point. */}
                <TagChip tag={lead.tag} testid={`chip-tag-lead-${lead.id}`} />
              </div>
              {source && (
                <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                  <Megaphone className="w-3 h-3" /> {source}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span
                className="text-xs text-muted-foreground"
                title={submitted ?? undefined}
              >
                {formatDistanceToNow(new Date(lead.createdAt), {
                  addSuffix: true,
                })}
              </span>
              <ChevronDown
                className={cn(
                  "w-4 h-4 text-muted-foreground transition-transform",
                  expanded && "rotate-180",
                )}
              />
            </div>
          </div>
          {/* Collapsed: a one-line glance so the row is still scannable. */}
          {!expanded && summary && (
            <p
              className="text-xs text-muted-foreground truncate"
              data-testid={`text-lead-summary-${lead.id}`}
            >
              {summary}
            </p>
          )}
          {/* Collapsed: surface missing-phone warning so it's visible without
            opening the card — the owner needs to know before quoting. */}
          {!expanded && missingPhone && (
            <p
              className="text-xs text-amber-400 flex items-center gap-1"
              data-testid={`hint-no-phone-${lead.id}`}
            >
              <AlertCircle className="w-3 h-3 shrink-0" />
              No phone — add one before quoting
            </p>
          )}
          {/* A failed Jobber push is actionable — it must not hide behind the
            click. The full reason and the retry live in the expanded view. */}
          {!expanded &&
            lead.source === "form" &&
            !lead.jobberSynced &&
            lead.jobberPushError && (
              <p
                className="text-xs text-red-400 flex items-center gap-1"
                data-testid={`hint-jobber-error-${lead.id}`}
              >
                <AlertCircle className="w-3 h-3 shrink-0" />
                Couldn't send to Jobber — open for details
              </p>
            )}
        </button>
        {lead.geocodingFailed && address && (
          <div className="px-5 pb-3 -mt-2">
            <AddressPlacementWarning
              address={address}
              testId={`warning-address-placement-lead-${lead.id}`}
            />
          </div>
        )}
        {/* Quick dismiss — one tap from the collapsed row, no expanding.
            Sits OUTSIDE the toggle button (a button can't nest a button),
            so tapping it never opens the card. */}
        {lead.status !== "dismissed" && !selectionMode && (
          <button
            type="button"
            title="Dismiss lead"
            aria-label="Dismiss lead"
            disabled={dismiss.isPending}
            onClick={handleDismiss}
            className="shrink-0 p-2 mt-4 mr-3 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-50"
            data-testid={`button-quick-dismiss-${lead.id}`}
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {expanded && (
        <div className="px-5 pb-5 space-y-3">
          {/* One tap after the conversation: client, good lead, bad lead,
              or spam. Tapping the active tag again clears it. */}
          <TagPicker
            value={lead.tag}
            disabled={updateTag.isPending}
            testidPrefix={`button-tag-lead-${lead.id}`}
            onSelect={(tag) =>
              updateTag.mutate(
                { id: lead.id, data: { tag } },
                {
                  onSuccess: (updated) => {
                    setLead(updated);
                    refresh();
                  },
                  onError: () =>
                    toast({
                      title: "Couldn't save that tag",
                      description: "Try again in a moment.",
                      variant: "destructive",
                    }),
                },
              )
            }
          />
          <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5">
            {/* Phone — show the number when present, or an amber "No phone"
                badge the owner can click to add one. */}
            <div>
              {lead.phoneDisplay ? (
                <Detail icon={Phone} label="Phone">
                  {lead.phoneE164 ? (
                    <a
                      href={`tel:${lead.phoneE164}`}
                      className="hover:underline"
                    >
                      {lead.phoneDisplay.trim()}
                    </a>
                  ) : (
                    lead.phoneDisplay.trim()
                  )}
                  <button
                    className="ml-1.5 text-muted-foreground hover:text-foreground"
                    title="Edit phone number"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingField(
                        editingField === "phone" ? null : "phone",
                      );
                    }}
                    data-testid={`edit-phone-btn-${lead.id}`}
                  >
                    <Pencil className="w-3 h-3 inline" />
                  </button>
                </Detail>
              ) : (
                <div className="flex items-center gap-1.5 text-sm">
                  <Phone className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <button
                    className="text-amber-400 hover:text-amber-300 font-medium text-xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingField(
                        editingField === "phone" ? null : "phone",
                      );
                    }}
                    data-testid={`badge-no-phone-${lead.id}`}
                  >
                    No phone — add one
                  </button>
                </div>
              )}
              {editingField === "phone" && (
                <ContactEditForm
                  lead={lead}
                  field="phone"
                  onClose={() => setEditingField(null)}
                  onSaved={handleContactSaved}
                />
              )}
            </div>

            {/* Email — show when present, or an amber "No email" badge. */}
            <div>
              {lead.email ? (
                <Detail icon={Mail} label="Email">
                  {lead.email}
                  <button
                    className="ml-1.5 text-muted-foreground hover:text-foreground"
                    title="Edit email"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingField(
                        editingField === "email" ? null : "email",
                      );
                    }}
                    data-testid={`edit-email-btn-${lead.id}`}
                  >
                    <Pencil className="w-3 h-3 inline" />
                  </button>
                </Detail>
              ) : (
                <div className="flex items-center gap-1.5 text-sm">
                  <Mail className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <button
                    className="text-amber-400 hover:text-amber-300 font-medium text-xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingField(
                        editingField === "email" ? null : "email",
                      );
                    }}
                    data-testid={`badge-no-email-${lead.id}`}
                  >
                    No email — add one
                  </button>
                </div>
              )}
              {editingField === "email" && (
                <ContactEditForm
                  lead={lead}
                  field="email"
                  onClose={() => setEditingField(null)}
                  onSaved={handleContactSaved}
                />
              )}
            </div>

            {lead.service && (
              <Detail icon={CheckCircle2} label="Service">
                {lead.service}
              </Detail>
            )}
            {address && (
              <Detail icon={MapPin} label="Address">
                {address}
              </Detail>
            )}
            {lead.bedrooms && (
              <Detail icon={BedDouble} label="Bedrooms">
                {lead.bedrooms}
              </Detail>
            )}
            {lead.bathrooms && (
              <Detail icon={Bath} label="Bathrooms">
                {lead.bathrooms}
              </Detail>
            )}
            {lead.dateOfServiceRequested && (
              <Detail icon={CalendarClock} label="Requested">
                {/* Free text from the ad, rendered as-is — never parsed. */}
                {lead.dateOfServiceRequested}
              </Detail>
            )}
            {lead.heardAbout && (
              <Detail icon={Megaphone} label="Heard about us">
                {lead.heardAbout}
              </Detail>
            )}
            {/* How fresh the phone conversation is — only when a call in
                the company's history matched this lead's number. Clicking
                opens the matching call's transcript/recording in-place. */}
            {lead.hasCalled && lead.lastCallAt && (
              <div data-testid={`text-last-call-${lead.id}`}>
                {lead.lastCallId != null ? (
                  <button
                    type="button"
                    className="flex items-start gap-2 text-sm w-full text-left hover:opacity-80 transition-opacity"
                    onClick={(e) => {
                      e.stopPropagation();
                      setViewCallId(lead.lastCallId!);
                    }}
                    data-testid={`link-last-call-${lead.id}`}
                  >
                    <PhoneIncoming className="w-3.5 h-3.5 text-teal-400 mt-0.5 shrink-0" />
                    <span className="text-muted-foreground shrink-0">
                      Called:
                    </span>
                    <span className="text-teal-400 underline underline-offset-2">
                      {formatDistanceToNow(new Date(lead.lastCallAt), {
                        addSuffix: true,
                      })}
                      {" — view call"}
                    </span>
                  </button>
                ) : (
                  <Detail icon={PhoneIncoming} label="Called">
                    {formatDistanceToNow(new Date(lead.lastCallAt), {
                      addSuffix: true,
                    })}
                  </Detail>
                )}
              </div>
            )}
            {/* For call-source leads: a direct link to the specific call that
                was saved as this lead. Distinct from lastCallId (which is the
                most recent call from this number) — callId is the originating
                call and never changes even when newer calls push lastCallId
                forward. Only shown when it differs from the displayed
                lastCallId, to avoid a duplicate "view call" link. */}
            {lead.callId != null &&
              lead.source === "call" &&
              lead.callId !== lead.lastCallId && (
                <button
                  type="button"
                  className="flex items-start gap-2 text-sm w-full text-left hover:opacity-80 transition-opacity"
                  onClick={(e) => {
                    e.stopPropagation();
                    setViewCallId(lead.callId!);
                  }}
                  data-testid={`link-origin-call-${lead.id}`}
                >
                  <PhoneIncoming className="w-3.5 h-3.5 text-teal-400 mt-0.5 shrink-0" />
                  <span className="text-muted-foreground shrink-0">
                    Saved from call:
                  </span>
                  <span className="text-teal-400 underline underline-offset-2">
                    view original call
                  </span>
                </button>
              )}
            {lead.message && (
              <div className="sm:col-span-2">
                <Detail icon={MessageSquare} label="Their message">
                  {/* The customer's own words, verbatim — never parsed. */}
                  <span className="whitespace-pre-wrap">{lead.message}</span>
                </Detail>
              </div>
            )}
          </div>

          {/* A form lead pushes itself into Jobber on submit; this banner is the
          failure case, with the retry right on it. Sheet leads never push, so
          they can never show it. */}
          {lead.source === "form" &&
            !lead.jobberSynced &&
            lead.jobberPushError && (
              <div
                className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 flex items-start gap-2"
                data-testid={`lead-jobber-error-${lead.id}`}
              >
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <div className="text-sm min-w-0">
                  <p className="text-red-400 font-medium">
                    Couldn't send this request to Jobber
                  </p>
                  <p className="text-red-400/80 break-words">
                    {lead.jobberPushError}
                  </p>
                </div>
              </div>
            )}

          {/* "Create quote" without a dialable phone — shown when the owner
              clicks the button and the lead has no E.164 number. */}
          {showQuotePhoneNudge && (
            <div
              className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 flex items-start gap-2"
              data-testid={`nudge-quote-phone-${lead.id}`}
            >
              <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div className="text-sm min-w-0">
                <p className="text-amber-400 font-medium">
                  A phone number is needed to text a quote
                </p>
                <p className="text-amber-400/80 mt-0.5">
                  Add the customer's number above, then try again.
                </p>
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 pt-1 flex-wrap">
            {lead.status !== "converted" && (
              <Button
                size="sm"
                onClick={() => navigate(`/bookings/new?leadId=${lead.id}`)}
                data-testid={`button-create-booking-${lead.id}`}
              >
                <PhoneIncoming className="w-3.5 h-3.5 mr-1.5" />
                Create booking
              </Button>
            )}
            {lead.status !== "converted" && (
              // Same prefilled form, arranged around the price instead of the
              // calendar — and after saving, the desk lands straight in the
              // "Text a quote" step for the new booking.
              <Button
                size="sm"
                variant="outline"
                className={cn(
                  missingPhone &&
                    "border-amber-500/50 text-amber-400 hover:text-amber-300",
                )}
                onClick={() => {
                  if (missingPhone) {
                    setShowQuotePhoneNudge(true);
                    setEditingField("phone");
                  } else {
                    navigate(`/bookings/new?leadId=${lead.id}&intent=quote`);
                  }
                }}
                data-testid={`button-create-quote-${lead.id}`}
              >
                <DollarSign className="w-3.5 h-3.5 mr-1.5" />
                Create quote
              </Button>
            )}
            {lead.status === "converted" && lead.convertedBookingId != null && (
              <Link href={`/bookings#booking-${lead.convertedBookingId}`}>
                <Button size="sm" variant="outline">
                  <CheckCircle2 className="w-3.5 h-3.5 mr-1.5 text-green-400" />
                  View booking
                </Button>
              </Link>
            )}
            {lead.status !== "dismissed" && (
              <Button
                size="sm"
                variant="ghost"
                disabled={dismiss.isPending}
                onClick={handleDismiss}
                data-testid={`button-dismiss-${lead.id}`}
              >
                <X className="w-3.5 h-3.5 mr-1.5" />
                Dismiss
              </Button>
            )}
            {lead.source === "form" &&
              !lead.jobberSynced &&
              lead.jobberPushError &&
              lead.status !== "converted" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={syncJobber.isPending}
                  onClick={() =>
                    syncJobber.mutate(
                      { id: lead.id },
                      {
                        onSuccess: (updated) => {
                          refresh();
                          toast(
                            updated.jobberSynced
                              ? { title: "Request sent to Jobber" }
                              : {
                                  title: "Couldn't send it to Jobber",
                                  description:
                                    updated.jobberPushError ??
                                    "The reason is on the lead card.",
                                  variant: "destructive",
                                },
                          );
                        },
                        onError: (err) =>
                          toast({
                            title: "Couldn't send it to Jobber",
                            description:
                              err instanceof Error ? err.message : undefined,
                            variant: "destructive",
                          }),
                      },
                    )
                  }
                  data-testid={`button-retry-jobber-${lead.id}`}
                >
                  <RefreshCw
                    className={cn(
                      "w-3.5 h-3.5 mr-1.5",
                      syncJobber.isPending && "animate-spin",
                    )}
                  />
                  Retry Jobber sync
                </Button>
              )}
            {/* At most one of these renders: Jobber-linked leads (imported from
            Jobber's form, or pushed there by ours) carry a Jobber link, and
            only sheet leads carry a Meta inbox link. */}
            {lead.jobberWebUri && (
              <a
                href={lead.jobberWebUri}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 ml-auto"
                data-testid={`link-jobber-request-${lead.id}`}
              >
                View request in Jobber <ExternalLink className="w-3 h-3" />
              </a>
            )}
            {lead.inboxUrl && (
              <a
                href={lead.inboxUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 ml-auto"
              >
                Open in Meta inbox <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
        </div>
      )}
      {/* Call detail opened from the "Called" row — rendered at the card
          level so it never escapes the card's DOM context. */}
      {viewCallId != null && (
        <CallDetailModal
          callId={viewCallId}
          open={viewCallId != null}
          onOpenChange={(val) => !val && setViewCallId(null)}
        />
      )}
    </div>
  );
}

export function LeadsPage() {
  const [filter, setFilter] = useState<LeadFilter>("new");
  const [sourceFilter, setSourceFilter] = useState<LeadSource>("all");
  // Card view is the default, so it has its own selection mode rather than
  // asking an owner to switch to the spreadsheet just to clear junk imports.
  const [cardSelectionMode, setCardSelectionMode] = useState(false);
  const [selectedCardLeadIds, setSelectedCardLeadIds] = useState<Set<number>>(
    new Set(),
  );
  const [cardBulkDismissConfirmOpen, setCardBulkDismissConfirmOpen] =
    useState(false);
  // The chosen view sticks across visits — a spreadsheet person shouldn't
  // have to re-pick Table every time they open the page.
  const [view, setView] = useState<"list" | "table" | "map">(() => {
    try {
      const saved = localStorage.getItem("leads-view");
      return saved === "table" || saved === "map" || saved === "list"
        ? saved
        : "list";
    } catch {
      return "list";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("leads-view", view);
    } catch {
      // Private-mode browsers can refuse storage; the toggle still works.
    }
  }, [view]);
  // The pin clicked on the map — its full card renders under the map.
  const [selectedLeadId, setSelectedLeadId] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: company } = useGetCompany();

  const params = filter === "all" ? undefined : { status: filter };
  const { data: rawLeads, isLoading } = useListLeads(params);

  // Reaching the inbox acknowledges website requests currently waiting there.
  // A later form submission will make the sidebar badge return.
  useEffect(() => {
    if (!company?.id || !rawLeads) return;
    acknowledgeWebsiteLeads(
      company.id,
      rawLeads
        .filter((lead) => lead.source === "form" && lead.status === "new")
        .map((lead) => lead.id),
    );
  }, [company?.id, rawLeads]);

  // Source filter is applied client-side — the API already returns `source`.
  const leads =
    sourceFilter === "all"
      ? rawLeads
      : rawLeads?.filter((l) => l.source === sourceFilter);

  // Count new leads that are missing a dialable phone — derived from the
  // already-fetched list, no extra request needed.
  // When filter="new" every row is new; when filter="all" we must check status.
  const missingPhoneCount =
    filter === "new"
      ? (rawLeads ?? []).filter((l) => !l.phoneE164).length
      : filter === "all"
        ? (rawLeads ?? []).filter((l) => l.status === "new" && !l.phoneE164)
            .length
        : 0;
  const { data: syncStatus } = useGetLeadSyncStatus();
  const syncIsStale =
    Boolean(syncStatus?.configured) &&
    Boolean(syncStatus?.stale) &&
    !syncStatus?.lastError;
  const eligibilityWarnings = syncStatus?.configured
    ? (syncStatus.tabStatuses?.filter((tab) => tab.eligibilityWarning) ?? [])
    : [];
  const { data: mapConfig } = useGetMapConfig();
  const syncNow = useSyncLeads();
  const syncPreview = useGetLeadSyncPreview({
    query: {
      enabled: false,
      queryKey: getGetLeadSyncPreviewQueryKey(),
    },
  });
  const bulkDismiss = useBulkDismissLeads();
  const [showSyncPreview, setShowSyncPreview] = useState(false);

  const newCardLeadIds = (leads ?? [])
    .filter((lead) => lead.status === "new")
    .map((lead) => lead.id);
  const selectedCardLeadCount = selectedCardLeadIds.size;

  // A filter/source change means the old selection no longer describes the
  // visible card list. Exit explicitly so an owner cannot dismiss unseen rows.
  useEffect(() => {
    setCardSelectionMode(false);
    setSelectedCardLeadIds(new Set());
  }, [filter, sourceFilter, view]);

  // Refetches can turn a selected lead into converted/dismissed elsewhere.
  // Drop those stale ids so the action always contains valid New leads.
  useEffect(() => {
    const validIds = new Set(newCardLeadIds);
    setSelectedCardLeadIds((previous) => {
      const next = new Set([...previous].filter((id) => validIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [newCardLeadIds.join(",")]);

  // A selection from another filter's pins would silently show nothing.
  useEffect(() => {
    setSelectedLeadId(null);
  }, [filter, sourceFilter]);

  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
    queryClient.invalidateQueries({
      queryKey: getGetLeadSyncStatusQueryKey(),
    });
    queryClient.invalidateQueries({
      queryKey: getGetDashboardSummaryQueryKey(),
    });
  };

  const handleSync = () =>
    syncNow.mutate(undefined, {
      onSuccess: (result) => {
        refreshAll();
        toast({
          title: result.error ? "Sync had trouble" : "Leads synced",
          description: result.error
            ? result.error
            : result.imported > 0
              ? `${result.imported} new ${result.imported === 1 ? "lead" : "leads"} pulled in.`
              : "No new leads in the sheet.",
          variant: result.error ? "destructive" : undefined,
        });
      },
      onError: () =>
        toast({
          title: "Sync failed",
          description: "Couldn't reach the server. Try again.",
          variant: "destructive",
        }),
    });

  const toggleCardSelection = (id: number) => {
    setSelectedCardLeadIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleCardBulkDismiss = () => {
    const ids = Array.from(selectedCardLeadIds);
    bulkDismiss.mutate(
      { data: { ids } },
      {
        onSuccess: (result) => {
          setSelectedCardLeadIds(new Set());
          setCardSelectionMode(false);
          refreshAll();
          toast({
            title: `${result.dismissed} lead${result.dismissed !== 1 ? "s" : ""} dismissed`,
            ...(result.skipped > 0
              ? {
                  description: `${result.skipped} already-converted lead${result.skipped !== 1 ? "s were" : " was"} skipped.`,
                }
              : {}),
          });
        },
        onError: () =>
          toast({
            title: "Couldn't dismiss those leads",
            description: "Some may already have been converted. Try again.",
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <AppLayout wide={view === "table"}>
      <PageHeader
        title="Leads"
        description="Facebook and Instagram lead ads from your leads sheet, plus requests from your website form and the Jobber form."
      >
        {syncStatus?.configured !== false ? (
          <>
            <Button
              variant="outline"
              onClick={handleSync}
              disabled={syncNow.isPending}
              data-testid="button-sync-leads"
            >
              <RefreshCw
                className={cn(
                  "w-4 h-4 mr-2",
                  syncNow.isPending && "animate-spin",
                )}
              />
              {syncNow.isPending ? "Syncing…" : "Sync now"}
            </Button>
            <Button
              variant="outline"
              onClick={async () => {
                setShowSyncPreview(true);
                await syncPreview.refetch();
              }}
              disabled={syncPreview.isFetching}
              data-testid="button-preview-lead-mappings"
            >
              <Eye className="w-4 h-4 mr-2" />
              {syncPreview.isFetching ? "Checking sheet…" : "Preview import"}
            </Button>
          </>
        ) : null}
      </PageHeader>

      {/* Sync health: quiet when fine, loud when the sheet is unreachable. */}
      {syncStatus && !syncStatus.configured ? (
        <div
          className="mb-6 bg-muted/40 border border-border rounded-xl p-4 flex items-start gap-3"
          data-testid="banner-sync-unconfigured"
        >
          <Info className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold text-foreground">
              Google Sheet feed not connected
            </p>
            <p className="text-muted-foreground mt-0.5">
              This company isn&apos;t connected to the shared Google Sheet lead
              feed.
            </p>
          </div>
        </div>
      ) : syncStatus?.lastError ? (
        <div
          className="mb-6 bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-start gap-3"
          data-testid="banner-sync-error"
        >
          <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
          <div className="text-sm min-w-0">
            <p className="font-semibold text-red-400">
              {syncStatus.tabStatuses?.some((tab) => tab.status === "failed")
                ? "Some leads sheet tabs couldn't be read"
                : "The leads sheet couldn't be read"}
              {syncStatus.lastSyncAt
                ? ` (last tried ${formatDistanceToNow(new Date(syncStatus.lastSyncAt), { addSuffix: true })})`
                : ""}
            </p>
            <p className="text-red-400/80 mt-0.5 break-words">
              {syncStatus.lastError}
            </p>
            {syncStatus.tabStatuses?.length ? (
              <div
                className="mt-3 grid gap-1.5 sm:grid-cols-2"
                data-testid="sync-tab-results"
              >
                {syncStatus.tabStatuses.map((tab) => (
                  <div
                    key={tab.name}
                    className="flex items-start gap-2 rounded-md bg-background/30 px-2.5 py-1.5"
                    data-testid={`sync-tab-${tab.status}-${tab.name}`}
                  >
                    {tab.status === "read" ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                    ) : (
                      <X className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                    )}
                    <span className="min-w-0">
                      <span className="block text-foreground break-words">
                        {tab.name}
                      </span>
                      <span
                        className={cn(
                          "block text-xs",
                          tab.status === "read"
                            ? "text-emerald-400"
                            : "text-red-400",
                        )}
                      >
                        {tab.status === "read"
                          ? "Read successfully"
                          : "Read failed"}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : syncIsStale ? (
        <div
          className="mb-6 bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-start gap-3"
          data-testid="banner-sync-stale"
        >
          <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold text-red-400">
              Automatic lead sync has stopped
            </p>
            <p className="text-red-400/80 mt-0.5">
              {syncStatus?.lastSyncAt
                ? `The sheet was last checked ${formatDistanceToNow(new Date(syncStatus.lastSyncAt), { addSuffix: true })}.`
                : "The sheet has not been checked yet."}
            </p>
          </div>
        </div>
      ) : (
        <p
          className="text-xs text-muted-foreground mb-6"
          data-testid="text-sync-status"
        >
          {syncStatus?.lastSuccessAt
            ? `Last synced ${formatDistanceToNow(new Date(syncStatus.lastSuccessAt), { addSuffix: true })}. New sheet rows appear within a few minutes.`
            : "Waiting for the first sync — new sheet rows appear within a few minutes."}
        </p>
      )}

      {eligibilityWarnings.length > 0 ? (
        <div
          className="mb-6 bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 flex items-start gap-3"
          data-testid="banner-sync-eligibility"
        >
          <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold text-amber-400">
              Some sheet rows were intentionally skipped
            </p>
            {eligibilityWarnings.map((tab) => (
              <p key={tab.name} className="text-amber-300/80 mt-1 break-words">
                {tab.name}: {tab.eligibilityWarning}
              </p>
            ))}
          </div>
        </div>
      ) : null}

      {/* Non-fatal: the sync works but the sheet grew a column the import
          doesn't recognize (headers rename under us), so some lead fields
          may be quietly blank until the mapping catches up. */}
      {syncStatus?.configured && syncStatus.warning ? (
        <div
          className="mb-6 bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 flex items-start gap-3"
          data-testid="banner-sync-warning"
        >
          <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold text-amber-400">
              The leads sheet has a column we don't recognize
            </p>
            <p className="text-amber-400/80 mt-0.5 break-words">
              {syncStatus.warning}
            </p>
          </div>
        </div>
      ) : null}

      {showSyncPreview && (
        <section
          className="mb-6 rounded-xl border border-border bg-card p-4"
          data-testid="panel-lead-sync-preview"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold text-foreground">
                Before-import preview
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                These are the columns currently in the sheet. Question answers
                are saved into booking details; metadata is kept separate.
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowSyncPreview(false)}
              aria-label="Close import preview"
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
          {syncPreview.isFetching ? (
            <p className="text-sm text-muted-foreground mt-4">
              Reading the current sheet headers…
            </p>
          ) : syncPreview.isError ? (
            <p className="text-sm text-red-400 mt-4">
              Couldn’t read the sheet preview. Try again before importing.
            </p>
          ) : syncPreview.data?.tabs.length ? (
            <div className="mt-4 space-y-4">
              {syncPreview.data.tabs.map((tab) => (
                <div
                  key={tab.name}
                  className="rounded-lg border border-border/70 p-3"
                  data-testid={`preview-tab-${tab.name}`}
                >
                  <div className="flex items-center gap-2">
                    {tab.status === "read" ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <X className="w-4 h-4 text-red-400" />
                    )}
                    <h3 className="font-medium text-foreground">{tab.name}</h3>
                  </div>
                  {tab.status === "failed" ? (
                    <p className="text-sm text-red-400 mt-2">{tab.error}</p>
                  ) : (
                    <div className="mt-3 grid gap-4 lg:grid-cols-3">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Booking details
                        </p>
                        {tab.questionMappings.length ? (
                          <div className="mt-2 space-y-1.5">
                            {tab.questionMappings.map((mapping) => (
                              <div
                                key={`${mapping.header}-${mapping.destination}`}
                                className="text-sm"
                                data-testid={`preview-mapping-${mapping.destination}-${tab.name}`}
                              >
                                <div className="flex flex-wrap items-baseline gap-x-1">
                                  <span className="text-foreground break-words">
                                    {mapping.header}
                                  </span>
                                  <span className="text-muted-foreground">
                                    {" → "}
                                    {mapping.destination ===
                                    "dateOfServiceRequested"
                                      ? "requested date"
                                      : mapping.destination}
                                  </span>
                                </div>
                                <p
                                  className="mt-0.5 text-xs text-muted-foreground/80 break-words"
                                  data-testid={`preview-example-${mapping.destination}-${tab.name}`}
                                >
                                  {mapping.exampleAnswer
                                    ? `Example: ${mapping.exampleAnswer}`
                                    : "Example: no answer in the first row"}
                                </p>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground mt-2">
                            No booking-question columns found.
                          </p>
                        )}
                      </div>
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Metadata and contact columns
                        </p>
                        <p className="text-sm text-muted-foreground mt-2 break-words">
                          {tab.metadataHeaders.length
                            ? tab.metadataHeaders.join(", ")
                            : "None"}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">
                          Needs review
                        </p>
                        {tab.unmappedHeaders.length ? (
                          <p className="text-sm text-amber-300 mt-2 break-words">
                            {tab.unmappedHeaders.join(", ")}
                          </p>
                        ) : (
                          <p className="text-sm text-muted-foreground mt-2">
                            No active unmapped columns.
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground mt-4">
              No sheet tabs were found.
            </p>
          )}
        </section>
      )}

      <div className="flex flex-col gap-3 mb-6">
        {/* Row 1: status filter + view toggle */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex gap-1 rounded-full border border-border bg-card p-1 w-fit">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className={cn(
                  "px-4 py-1.5 rounded-full text-sm font-medium transition-colors",
                  filter === f.id
                    ? "brand-gradient text-white font-bold"
                    : "text-muted-foreground hover:text-foreground",
                )}
                data-testid={`filter-${f.id}`}
              >
                {f.label}
              </button>
            ))}
          </div>
          {/* Cards for the full story, Table for the spreadsheet glance;
              Map only offers itself when the server has a Maps key. */}
          <div className="flex gap-1 rounded-full border border-border bg-card p-1 w-fit">
            {(
              [
                { id: "list", label: "List", icon: List },
                { id: "table", label: "Table", icon: TableIcon },
                ...(mapConfig?.configured
                  ? [{ id: "map", label: "Map", icon: MapIcon } as const]
                  : []),
              ] as {
                id: "list" | "table" | "map";
                label: string;
                icon: typeof List;
              }[]
            ).map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => setView(v.id)}
                className={cn(
                  "px-4 py-1.5 rounded-full text-sm font-medium transition-colors inline-flex items-center gap-1.5",
                  view === v.id
                    ? "brand-gradient text-white font-bold"
                    : "text-muted-foreground hover:text-foreground",
                )}
                data-testid={`view-${v.id}`}
              >
                <v.icon className="w-3.5 h-3.5" />
                {v.label}
              </button>
            ))}
          </div>
          {view === "list" && newCardLeadIds.length > 0 && (
            <Button
              type="button"
              size="sm"
              variant={cardSelectionMode ? "secondary" : "outline"}
              onClick={() => {
                setCardSelectionMode((enabled) => !enabled);
                setSelectedCardLeadIds(new Set());
              }}
              data-testid="card-select-toggle"
            >
              {cardSelectionMode ? "Done" : "Select"}
            </Button>
          )}
        </div>
        {/* Row 2: source filter. Keep the whole group inside a phone viewport:
            the pills stay intact and wrap rather than widening the document. */}
        <div
          className="flex w-full max-w-full flex-wrap gap-1 rounded-2xl border border-border bg-card p-1 sm:w-fit sm:rounded-full"
          data-testid="source-filters"
        >
          {SOURCE_FILTERS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSourceFilter(s.id)}
              className={cn(
                "shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium transition-colors sm:px-4",
                sourceFilter === s.id
                  ? "brand-gradient text-white font-bold"
                  : "text-muted-foreground hover:text-foreground",
              )}
              data-testid={`source-filter-${s.id}`}
            >
              {s.label}
            </button>
          ))}
        </div>
        {/* Amber callout: tells the owner at a glance how many new leads
            they can't quote yet because a phone number is missing. Only
            shown when at least one new lead has no dialable number.
            Disappears automatically once all new leads have a phone. */}
        {missingPhoneCount > 0 && (
          <p
            className="text-xs text-amber-400 flex items-center gap-1.5"
            data-testid="text-missing-phone-count"
          >
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            {missingPhoneCount}{" "}
            {missingPhoneCount === 1 ? "new lead is" : "new leads are"} missing
            a phone number
          </p>
        )}
      </div>

      {isLoading ? (
        <LoadingSpinner className="mt-20" />
      ) : (leads ?? []).length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-12 text-center">
          <Inbox className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-muted-foreground text-sm">
            {filter === "new"
              ? "No new leads right now. New sheet rows land here automatically."
              : `No ${filter === "all" ? "" : filter + " "}leads yet.`}
          </p>
        </div>
      ) : view === "map" && mapConfig?.configured && mapConfig.apiKey ? (
        <div className="space-y-4">
          <LeadsMap
            apiKey={mapConfig.apiKey}
            leads={leads ?? []}
            onSelectLead={setSelectedLeadId}
          />
          {(() => {
            const offMap = (leads ?? []).filter((l) => l.lat == null).length;
            return offMap > 0 ? (
              <p
                className="text-xs text-muted-foreground"
                data-testid="text-off-map-count"
              >
                {offMap} {offMap === 1 ? "lead isn't" : "leads aren't"} on the
                map — no usable address, or still being located.
              </p>
            ) : null;
          })()}
          {(() => {
            const selected = (leads ?? []).find((l) => l.id === selectedLeadId);
            // Keyed so picking a different pin opens fresh (and expanded —
            // clicking a pin means "show me everything about this lead").
            return selected ? (
              <LeadCard key={selected.id} lead={selected} defaultExpanded />
            ) : null;
          })()}
        </div>
      ) : view === "table" ? (
        <LeadsTable leads={leads ?? []} />
      ) : (
        <div className={cn("space-y-4", selectedCardLeadCount > 0 && "pb-24")}>
          {(leads ?? []).map((lead) => (
            <LeadCard
              key={lead.id}
              lead={lead}
              selectionMode={cardSelectionMode}
              selected={selectedCardLeadIds.has(lead.id)}
              onSelectionChange={() => toggleCardSelection(lead.id)}
            />
          ))}
        </div>
      )}

      {/* Kept fixed while the owner scrolls through a large sheet import. It
          only appears once a card is chosen, leaving the normal list compact. */}
      {view === "list" && selectedCardLeadCount > 0 && (
        <div
          className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4"
          data-testid="card-bulk-dismiss-bar"
        >
          <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-lg">
            <span className="text-sm text-muted-foreground">
              {selectedCardLeadCount} selected
            </span>
            <Button
              variant="destructive"
              disabled={bulkDismiss.isPending}
              onClick={() => setCardBulkDismissConfirmOpen(true)}
              data-testid="card-bulk-dismiss-btn"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Dismiss {selectedCardLeadCount} selected
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedCardLeadIds(new Set())}
              data-testid="card-bulk-dismiss-clear"
            >
              Clear
            </Button>
          </div>
        </div>
      )}

      <AlertDialog
        open={cardBulkDismissConfirmOpen}
        onOpenChange={setCardBulkDismissConfirmOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Dismiss {selectedCardLeadCount} lead
              {selectedCardLeadCount !== 1 ? "s" : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {selectedCardLeadCount === 1
                ? "This lead will move to the Dismissed filter. Nothing is deleted."
                : `These ${selectedCardLeadCount} leads will move to the Dismissed filter. Nothing is deleted.`}{" "}
              Already-converted leads are automatically skipped.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCardBulkDismiss}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="card-bulk-dismiss-confirm"
            >
              Dismiss {selectedCardLeadCount}{" "}
              {selectedCardLeadCount !== 1 ? "leads" : "lead"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
