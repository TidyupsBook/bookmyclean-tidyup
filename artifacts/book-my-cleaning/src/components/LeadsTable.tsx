import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  DollarSign,
  PhoneIncoming,
  X,
  Trash2,
  Columns3,
  RotateCcw,
  MoveHorizontal,
  ChevronRight,
  Mail,
} from "lucide-react";
import {
  Lead,
  useDismissLead,
  useBulkDismissLeads,
  useUpdateLeadTag,
  getListLeadsQueryKey,
  getGetDashboardSummaryQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
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
import {
  LeadCalledBadge,
  LeadSourceBadge,
  LeadStatusBadge,
} from "@/components/lead-badges";
import { LeadsTableDetails } from "@/components/LeadsTableDetails";
import { TagPicker, type QuickTag } from "@/components/TagControls";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { AddressPlacementWarning } from "@/components/AddressPlacementWarning";

type OptionalColumnId =
  | "email"
  | "service"
  | "address"
  | "requested"
  | "source"
  | "status"
  | "received";

const COLUMN_STORAGE_KEY = "leads-table-columns-v2";

const OPTIONAL_COLUMNS: {
  id: OptionalColumnId;
  label: string;
  minWidth: number;
}[] = [
  { id: "email", label: "Email", minWidth: 190 },
  { id: "service", label: "Service", minWidth: 150 },
  { id: "address", label: "Address", minWidth: 170 },
  { id: "requested", label: "Requested date", minWidth: 110 },
  { id: "source", label: "Source", minWidth: 100 },
  { id: "status", label: "Status", minWidth: 90 },
  { id: "received", label: "Received", minWidth: 110 },
];

const DEFAULT_VISIBLE_COLUMNS: OptionalColumnId[] = [
  "service",
  "address",
  "requested",
];

function defaultVisibleColumns(): Set<OptionalColumnId> {
  return new Set(DEFAULT_VISIBLE_COLUMNS);
}

function readVisibleColumns(): Set<OptionalColumnId> {
  if (typeof window === "undefined") return defaultVisibleColumns();
  try {
    const saved = window.localStorage.getItem(COLUMN_STORAGE_KEY);
    if (!saved) return defaultVisibleColumns();
    const parsed: unknown = JSON.parse(saved);
    if (!Array.isArray(parsed)) return defaultVisibleColumns();
    const allowed = new Set(OPTIONAL_COLUMNS.map((column) => column.id));
    return new Set(
      parsed.filter(
        (value): value is OptionalColumnId =>
          typeof value === "string" && allowed.has(value as OptionalColumnId),
      ),
    );
  } catch {
    return defaultVisibleColumns();
  }
}

/**
 * The spreadsheet view of the leads inbox: one row per lead, only the
 * columns needed to size up a quote or booking — who, how to reach them,
 * what they want cleaned, where, and when. Anything deeper (tags, ad
 * campaign, raw message, inline phone editing) lives in the card view.
 *
 * "New" leads get a checkbox so the owner can sweep away several junk
 * rows at once after a sheet import or ad campaign. Converted/dismissed
 * leads don't participate — they're already handled.
 */
export function LeadsTable({ leads }: { leads: Lead[] }) {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const dismiss = useDismissLead();
  const bulkDismiss = useBulkDismissLeads();
  const updateTag = useUpdateLeadTag();
  // Keep a successful tag click visible immediately, even while the filtered
  // list query is being invalidated and refetched.
  const [tagOverrides, setTagOverrides] = useState<Record<number, Lead["tag"]>>(
    {},
  );

  // Ids of "new" leads the owner has ticked for bulk dismissal.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  // Controls the confirmation dialog before the bulk action fires.
  const [confirmOpen, setConfirmOpen] = useState(false);
  // One detail sub-row at a time keeps a dense table easy to scan.
  const [expandedLeadId, setExpandedLeadId] = useState<number | null>(null);
  // Secondary columns are a browser preference: useful per workstation, not
  // company data that should follow every user and device.
  const [visibleColumns, setVisibleColumns] =
    useState<Set<OptionalColumnId>>(readVisibleColumns);
  const scrollRegionRef = useRef<HTMLDivElement>(null);
  const [hasHorizontalOverflow, setHasHorizontalOverflow] = useState(false);
  const [scrollViewportWidth, setScrollViewportWidth] = useState(0);

  // Bulk dismissal remains limited to new leads; individual dismissal is
  // available for every non-archived lead.
  const newLeadIds = leads.filter((l) => l.status === "new").map((l) => l.id);

  const allNewSelected =
    newLeadIds.length > 0 && newLeadIds.every((id) => selectedIds.has(id));
  const someNewSelected = selectedIds.size > 0;

  const toggleAll = () => {
    if (allNewSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(newLeadIds));
    }
  };

  const toggleOne = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
    queryClient.invalidateQueries({
      queryKey: getGetDashboardSummaryQueryKey(),
    });
  };

  const handleTag = (lead: Lead, tag: QuickTag | null) => {
    updateTag.mutate(
      { id: lead.id, data: { tag } },
      {
        onSuccess: (updated) => {
          setTagOverrides((previous) => ({
            ...previous,
            [lead.id]: updated.tag,
          }));
          queryClient.setQueriesData<Lead[]>(
            { queryKey: getListLeadsQueryKey() },
            (current) =>
              current?.map((candidate) =>
                candidate.id === updated.id ? updated : candidate,
              ),
          );
          invalidate();
        },
        onError: () =>
          toast({
            title: "Couldn't save that tag",
            description: "Try again in a moment.",
            variant: "destructive",
          }),
      },
    );
  };

  // Same behavior as the card's dismiss: move to the Dismissed filter,
  // refresh the list, and complain in a toast when the server refuses.
  const handleDismiss = (id: number) =>
    dismiss.mutate(
      { id },
      {
        onSuccess: () => {
          setSelectedIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          invalidate();
        },
        onError: () =>
          toast({
            title: "Couldn't dismiss that lead",
            description: "It may already be archived.",
            variant: "destructive",
          }),
      },
    );

  const handleBulkDismiss = () => {
    const ids = Array.from(selectedIds);
    bulkDismiss.mutate(
      { data: { ids } },
      {
        onSuccess: (result) => {
          setSelectedIds(new Set());
          invalidate();
          if (result.skipped > 0) {
            toast({
              title: `${result.dismissed} lead${result.dismissed !== 1 ? "s" : ""} dismissed`,
              description: `${result.skipped} already-converted lead${result.skipped !== 1 ? "s were" : " was"} skipped.`,
            });
          } else {
            toast({
              title: `${result.dismissed} lead${result.dismissed !== 1 ? "s" : ""} dismissed`,
            });
          }
        },
        onError: () => {
          toast({
            title: "Couldn't dismiss those leads",
            description: "Some may already have been converted. Try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const showCheckboxes = newLeadIds.length > 0;
  const visibleColumnKey = OPTIONAL_COLUMNS.filter((column) =>
    visibleColumns.has(column.id),
  )
    .map((column) => column.id)
    .join(",");

  useEffect(() => {
    try {
      window.localStorage.setItem(
        COLUMN_STORAGE_KEY,
        JSON.stringify(
          OPTIONAL_COLUMNS.filter((column) =>
            visibleColumns.has(column.id),
          ).map((column) => column.id),
        ),
      );
    } catch {
      // Storage can be unavailable in private or locked-down browsers.
    }
  }, [visibleColumnKey]);

  const checkHorizontalOverflow = useCallback(() => {
    const region = scrollRegionRef.current;
    setScrollViewportWidth(region?.clientWidth ?? 0);
    setHasHorizontalOverflow(
      Boolean(region && region.scrollWidth > region.clientWidth + 1),
    );
  }, []);

  useEffect(() => {
    checkHorizontalOverflow();
    window.addEventListener("resize", checkHorizontalOverflow);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(checkHorizontalOverflow);
    if (scrollRegionRef.current) observer?.observe(scrollRegionRef.current);
    return () => {
      window.removeEventListener("resize", checkHorizontalOverflow);
      observer?.disconnect();
    };
  }, [checkHorizontalOverflow, visibleColumnKey, leads.length]);

  const toggleColumn = (id: OptionalColumnId) => {
    setVisibleColumns((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const resetColumns = () => setVisibleColumns(defaultVisibleColumns());
  const columnsAreDefault =
    visibleColumns.size === DEFAULT_VISIBLE_COLUMNS.length &&
    DEFAULT_VISIBLE_COLUMNS.every((id) => visibleColumns.has(id));
  // The real scrollable element owns this minimum width. The shared Table
  // primitive wraps itself in another scroller, so this component uses the
  // semantic table parts directly to keep one discoverable scroll region.
  const minimumTableWidth =
    (showCheckboxes ? 48 : 0) +
    145 + // Name and details trigger
    135 + // Phone
    240 + // Quote, Book, and dismiss actions
    OPTIONAL_COLUMNS.filter((column) => visibleColumns.has(column.id)).reduce(
      (total, column) => total + column.minWidth,
      0,
    );
  const detailColSpan = (showCheckboxes ? 1 : 0) + 3 + visibleColumns.size;
  const stickyNameLeft = showCheckboxes ? "left-12" : "left-0";

  return (
    <>
      <div
        className="mb-3 flex min-h-9 flex-wrap items-center justify-between gap-3 px-1"
        data-testid="leads-table-toolbar"
      >
        <div className="flex flex-wrap items-center gap-3">
          {someNewSelected ? (
            <>
              <span className="text-sm text-muted-foreground">
                {selectedIds.size} selected
              </span>
              <Button
                size="sm"
                variant="destructive"
                disabled={bulkDismiss.isPending}
                onClick={() => setConfirmOpen(true)}
                data-testid="bulk-dismiss-btn"
              >
                <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                Dismiss selected ({selectedIds.size})
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelectedIds(new Set())}
                data-testid="bulk-dismiss-clear"
              >
                Clear
              </Button>
            </>
          ) : (
            <span
              className="text-xs text-muted-foreground"
              data-testid="text-table-lead-count"
            >
              {leads.length} {leads.length === 1 ? "lead" : "leads"}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {hasHorizontalOverflow ? (
            <p
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
              data-testid="leads-table-scroll-hint"
            >
              <MoveHorizontal className="h-3.5 w-3.5 text-brand-orange" />
              Scroll sideways to see more columns
            </p>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="gap-2"
                data-testid="columns-menu"
              >
                <Columns3 className="h-3.5 w-3.5" />
                Columns
                <span className="text-[11px] text-muted-foreground">
                  {visibleColumns.size}/{OPTIONAL_COLUMNS.length}
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel>Show in table</DropdownMenuLabel>
              <p className="px-2 pb-1.5 text-xs text-muted-foreground">
                Name, phone, and actions always stay visible.
              </p>
              <DropdownMenuSeparator />
              {OPTIONAL_COLUMNS.map((column) => (
                <DropdownMenuCheckboxItem
                  key={column.id}
                  checked={visibleColumns.has(column.id)}
                  onCheckedChange={() => toggleColumn(column.id)}
                  onSelect={(event) => event.preventDefault()}
                  data-testid={`column-toggle-${column.id}`}
                >
                  {column.label}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={columnsAreDefault}
                onSelect={resetColumns}
                data-testid="columns-reset"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reset to defaults
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div
        ref={scrollRegionRef}
        role="region"
        aria-label="Leads table with horizontal scrolling"
        tabIndex={0}
        className="overflow-x-auto rounded-xl border border-border bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        data-has-horizontal-overflow={hasHorizontalOverflow}
        data-testid="leads-table"
      >
        <table
          className="w-full caption-bottom text-sm"
          style={{ minWidth: minimumTableWidth }}
          data-testid="leads-table-grid"
          data-minimum-width={minimumTableWidth}
        >
          <TableHeader className="bg-card">
            <TableRow className="hover:bg-transparent">
              {/* Select-all checkbox — only shown when there are dismissable rows */}
              {showCheckboxes && (
                <TableHead
                  className="sticky left-0 z-20 w-12 min-w-12 bg-card pl-4"
                  data-column="selection"
                >
                  <Checkbox
                    checked={allNewSelected}
                    onCheckedChange={toggleAll}
                    aria-label="Select all new leads"
                    data-testid="select-all-leads"
                  />
                </TableHead>
              )}
              <TableHead
                className={cn(
                  "sticky z-20 min-w-[145px] bg-card shadow-[6px_0_8px_-8px_rgba(0,0,0,0.7)]",
                  stickyNameLeft,
                )}
                data-column="name"
              >
                Name
              </TableHead>
              <TableHead className="min-w-[135px]" data-column="phone">
                Phone
              </TableHead>
              {visibleColumns.has("email") ? (
                <TableHead className="min-w-[190px]" data-column="email">
                  Email
                </TableHead>
              ) : null}
              {visibleColumns.has("service") ? (
                <TableHead className="min-w-[150px]" data-column="service">
                  Service
                </TableHead>
              ) : null}
              {visibleColumns.has("address") ? (
                <TableHead className="min-w-[170px]" data-column="address">
                  Address
                </TableHead>
              ) : null}
              {visibleColumns.has("requested") ? (
                <TableHead className="min-w-[110px]" data-column="requested">
                  Requested
                </TableHead>
              ) : null}
              {visibleColumns.has("source") ? (
                <TableHead className="min-w-[100px]" data-column="source">
                  Source
                </TableHead>
              ) : null}
              {visibleColumns.has("status") ? (
                <TableHead className="min-w-[90px]" data-column="status">
                  Status
                </TableHead>
              ) : null}
              {visibleColumns.has("received") ? (
                <TableHead className="min-w-[110px]" data-column="received">
                  Received
                </TableHead>
              ) : null}
              <TableHead
                className="sticky right-0 z-20 min-w-[240px] bg-card text-right shadow-[-6px_0_8px_-8px_rgba(0,0,0,0.7)]"
                data-column="actions"
              >
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leads.map((lead) => {
              // What the customer actually typed, joined — never a guess.
              const service = [
                lead.service,
                lead.bedrooms && `${lead.bedrooms} bed`,
                lead.bathrooms && `${lead.bathrooms} bath`,
              ]
                .filter(Boolean)
                .join(" · ");
              // Full address, same pieces the card shows — the postal code
              // and province tell the desk whether the job is even in the
              // service area before they start a quote.
              const address = [
                lead.streetAddress,
                lead.city,
                lead.province,
                lead.postCode,
              ]
                .filter(Boolean)
                .join(", ");
              const phone = lead.phoneDisplay?.trim();
              const missingPhone = !lead.phoneE164;
              const isNew = lead.status === "new";
              const isChecked = selectedIds.has(lead.id);
              const isExpanded = expandedLeadId === lead.id;
              const tag = Object.prototype.hasOwnProperty.call(
                tagOverrides,
                lead.id,
              )
                ? tagOverrides[lead.id]
                : lead.tag;
              const stickyCellBackground = isChecked
                ? "bg-muted"
                : "bg-card group-hover:bg-muted/50";

              return (
                <Fragment key={lead.id}>
                  <TableRow
                    data-testid={`lead-row-${lead.id}`}
                    className={cn(
                      "group",
                      isChecked && "bg-muted/30",
                      isExpanded && "border-b-0 bg-muted/20",
                    )}
                  >
                    {/* Per-row checkbox — only "new" leads are selectable */}
                    {showCheckboxes ? (
                      <TableCell
                        className={cn(
                          "sticky left-0 z-10 w-12 min-w-12 pl-4",
                          stickyCellBackground,
                        )}
                        data-column="selection"
                      >
                        {isNew ? (
                          <Checkbox
                            checked={isChecked}
                            onCheckedChange={() => toggleOne(lead.id)}
                            aria-label={`Select lead ${lead.name || lead.id}`}
                            data-testid={`select-lead-${lead.id}`}
                          />
                        ) : null}
                      </TableCell>
                    ) : null}
                    <TableCell
                      className={cn(
                        "sticky z-10 min-w-[145px] font-medium shadow-[6px_0_8px_-8px_rgba(0,0,0,0.7)]",
                        stickyNameLeft,
                        stickyCellBackground,
                      )}
                      data-column="name"
                    >
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-md py-1 text-left outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
                        aria-expanded={isExpanded}
                        aria-controls={`lead-details-row-${lead.id}`}
                        aria-label={`${isExpanded ? "Hide" : "View"} details for ${lead.name || `lead ${lead.id}`}`}
                        onClick={() =>
                          setExpandedLeadId(isExpanded ? null : lead.id)
                        }
                        data-testid={`table-details-toggle-${lead.id}`}
                      >
                        <ChevronRight
                          className={cn(
                            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                            isExpanded && "rotate-90",
                          )}
                        />
                        <span className="break-words">
                          {lead.name || (
                            <span className="text-muted-foreground">
                              No name
                            </span>
                          )}
                        </span>
                      </button>
                    </TableCell>
                    <TableCell
                      className="min-w-[135px] whitespace-nowrap"
                      data-column="phone"
                    >
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        {phone ||
                          (missingPhone ? (
                            <span
                              className="text-amber-400 inline-flex items-center gap-1 text-xs"
                              data-testid={`table-no-phone-${lead.id}`}
                            >
                              <AlertCircle className="w-3 h-3 shrink-0" />
                              No phone
                            </span>
                          ) : (
                            "—"
                          ))}
                        <LeadCalledBadge lead={lead} />
                      </span>
                    </TableCell>
                    {visibleColumns.has("email") ? (
                      <TableCell
                        className="min-w-[190px] break-all"
                        data-column="email"
                      >
                        {lead.email ? (
                          <a
                            href={`mailto:${lead.email}`}
                            className="inline-flex items-center gap-1.5 hover:underline"
                          >
                            <Mail className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            {lead.email}
                          </a>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    ) : null}
                    {visibleColumns.has("service") ? (
                      <TableCell
                        className="min-w-[150px] max-w-[240px] whitespace-normal break-words leading-5"
                        data-column="service"
                      >
                        {service || "—"}
                      </TableCell>
                    ) : null}
                    {visibleColumns.has("address") ? (
                      <TableCell
                        className="min-w-[170px] max-w-[260px] whitespace-normal break-words leading-5"
                        data-column="address"
                      >
                        <span className="inline-flex items-center gap-1.5">
                          {address || "—"}
                          {lead.geocodingFailed && address && (
                            <AddressPlacementWarning
                              address={address}
                              testId={`warning-address-placement-lead-${lead.id}`}
                            />
                          )}
                        </span>
                      </TableCell>
                    ) : null}
                    {visibleColumns.has("requested") ? (
                      <TableCell
                        className="min-w-[110px] max-w-[200px] whitespace-normal break-words leading-5"
                        data-column="requested"
                      >
                        {lead.dateOfServiceRequested || "—"}
                      </TableCell>
                    ) : null}
                    {visibleColumns.has("source") ? (
                      <TableCell className="min-w-[100px]" data-column="source">
                        <LeadSourceBadge lead={lead} compact />
                      </TableCell>
                    ) : null}
                    {visibleColumns.has("status") ? (
                      <TableCell className="min-w-[90px]" data-column="status">
                        <LeadStatusBadge status={lead.status} />
                      </TableCell>
                    ) : null}
                    {visibleColumns.has("received") ? (
                      <TableCell
                        className="min-w-[110px] whitespace-nowrap text-xs text-muted-foreground"
                        data-column="received"
                      >
                        {formatDistanceToNow(new Date(lead.createdAt), {
                          addSuffix: true,
                        })}
                      </TableCell>
                    ) : null}
                    <TableCell
                      className={cn(
                        "sticky right-0 z-10 min-w-[240px] text-right shadow-[-6px_0_8px_-8px_rgba(0,0,0,0.7)]",
                        stickyCellBackground,
                      )}
                      data-column="actions"
                    >
                      <div className="flex flex-col items-end gap-2">
                        <TagPicker
                          value={tag}
                          disabled={updateTag.isPending}
                          testidPrefix={`table-button-tag-lead-${lead.id}`}
                          onSelect={(nextTag) => handleTag(lead, nextTag)}
                        />
                        <div className="inline-flex items-center gap-1.5">
                          {/* Converted leads never offer Quote/Book — even if the
                            booking id is missing, converting again would make a
                            duplicate. */}
                          {lead.status === "converted" ? (
                            lead.convertedBookingId != null ? (
                              <Link
                                href={`/bookings#booking-${lead.convertedBookingId}`}
                              >
                                <Button size="sm" variant="outline">
                                  <CheckCircle2 className="w-3.5 h-3.5 mr-1.5 text-green-400" />
                                  View booking
                                </Button>
                              </Link>
                            ) : (
                              <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                                <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
                                Converted
                              </span>
                            )
                          ) : (
                            <>
                              {/* No quote button without a dialable phone — the
                                phone cell already warns; add the number from
                                the card view first. */}
                              {!missingPhone ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() =>
                                    navigate(
                                      `/bookings/new?leadId=${lead.id}&intent=quote`,
                                    )
                                  }
                                  data-testid={`table-create-quote-${lead.id}`}
                                >
                                  <DollarSign className="w-3.5 h-3.5 mr-1" />
                                  Quote
                                </Button>
                              ) : null}
                              <Button
                                size="sm"
                                onClick={() =>
                                  navigate(`/bookings/new?leadId=${lead.id}`)
                                }
                                data-testid={`table-create-booking-${lead.id}`}
                              >
                                <PhoneIncoming className="w-3.5 h-3.5 mr-1" />
                                Book
                              </Button>
                            </>
                          )}
                          {/* One-tap dismiss straight from the row — available
                              for converted leads too, without touching their
                              linked booking. */}
                          {lead.status !== "dismissed" ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              title="Dismiss lead"
                              aria-label="Dismiss lead"
                              disabled={dismiss.isPending}
                              onClick={() => handleDismiss(lead.id)}
                              data-testid={`table-dismiss-${lead.id}`}
                            >
                              <X className="w-3.5 h-3.5" />
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                  {isExpanded ? (
                    <TableRow
                      id={`lead-details-row-${lead.id}`}
                      className="bg-muted/20 hover:bg-muted/20"
                      data-testid={`lead-details-${lead.id}`}
                    >
                      <TableCell colSpan={detailColSpan} className="p-0">
                        <div
                          className="sticky left-0 box-border border-b border-t border-border/70 px-6 py-5"
                          style={
                            scrollViewportWidth > 0
                              ? { width: scrollViewportWidth }
                              : undefined
                          }
                          data-testid={`lead-details-viewport-${lead.id}`}
                        >
                          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-semibold">Full lead details</p>
                              <LeadStatusBadge status={lead.status} />
                              <LeadCalledBadge lead={lead} />
                            </div>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setExpandedLeadId(null)}
                              data-testid={`table-details-close-${lead.id}`}
                            >
                              Close details
                            </Button>
                          </div>
                          <LeadsTableDetails lead={lead} />
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              );
            })}
          </TableBody>
        </table>
      </div>

      {/* Confirmation dialog before the bulk dismiss fires */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Dismiss {selectedIds.size} lead{selectedIds.size !== 1 ? "s" : ""}
              ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {selectedIds.size === 1
                ? "This lead will move to the Dismissed filter. Nothing is deleted."
                : `These ${selectedIds.size} leads will move to the Dismissed filter. Nothing is deleted.`}{" "}
              Already-converted leads are automatically skipped.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkDismiss}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="bulk-dismiss-confirm"
            >
              Dismiss {selectedIds.size}{" "}
              {selectedIds.size !== 1 ? "leads" : "lead"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
