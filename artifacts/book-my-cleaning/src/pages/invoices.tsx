import { useMemo, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader, LoadingSpinner } from "@/components/ui/shared";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  useListJobberInvoices,
  useGetCompany,
  JobberInvoice,
} from "@workspace/api-client-react";
import { companyTimeZone, formatZoned } from "@/lib/time";
import {
  Receipt,
  ExternalLink,
  MapPin,
  Phone,
  AlertCircle,
} from "lucide-react";
import {
  CustomerTagChip,
  CustomerTagPicker,
} from "@/components/CustomerTagControls";

/**
 * Invoices written in Jobber, mirrored here read-only so the desk can see
 * who has paid and who still owes without opening Jobber. Payments happen
 * inside Jobber — the "Open in Jobber" link is the way to collect or edit;
 * nothing on this page writes back.
 */

const STATUS_META: Record<string, { label: string; className: string }> = {
  draft: {
    label: "Draft",
    className: "bg-gray-100 text-gray-600 border-gray-200",
  },
  awaiting_payment: {
    label: "Awaiting payment",
    className: "bg-amber-50 text-amber-700 border-amber-200",
  },
  sent_not_due: {
    label: "Sent — not due yet",
    className: "bg-blue-50 text-blue-700 border-blue-200",
  },
  past_due: {
    label: "Past due",
    className: "bg-red-50 text-red-700 border-red-200",
  },
  paid: {
    label: "Paid",
    className: "bg-green-50 text-green-700 border-green-200",
  },
  bad_debt: {
    label: "Written off",
    className: "bg-gray-100 text-gray-500 border-gray-200",
  },
};

function statusBadge(status: string) {
  const meta = STATUS_META[status] ?? {
    // A status Jobber adds later shows as-is instead of breaking the page.
    label: status.replace(/_/g, " "),
    className: "bg-gray-100 text-gray-600 border-gray-200",
  };
  return (
    <Badge variant="outline" className={cn("capitalize-first", meta.className)}>
      {meta.label}
    </Badge>
  );
}

function money(cents: number | null | undefined): string | null {
  if (cents == null) return null;
  return (cents / 100).toLocaleString("en-CA", {
    style: "currency",
    currency: "CAD",
  });
}

/**
 * An invoice that still has money outstanding on it. The balance field is
 * the truth — even a "paid" invoice with a nonzero balance counts, so the
 * summary can never understate what Jobber says is owed. Only two statuses
 * are deliberately excluded: drafts (never sent, nothing collectible yet)
 * and written-off debt (the owner chose to stop chasing it).
 */
function isOwing(inv: JobberInvoice): boolean {
  return (
    inv.status !== "bad_debt" &&
    inv.status !== "draft" &&
    (inv.balanceCents ?? 0) > 0
  );
}

export function InvoicesPage() {
  const { data: invoices, isLoading, isError } = useListJobberInvoices();
  const { data: company } = useGetCompany();
  const timeZone = companyTimeZone(company);
  const [filter, setFilter] = useState<string>("all");

  // Only offer chips for statuses that actually exist in this company's
  // invoices, in a fixed, meaningful order.
  const chips = useMemo(() => {
    const present = new Set((invoices ?? []).map((inv) => inv.status));
    const known = Object.keys(STATUS_META).filter((s) => present.has(s));
    const unknown = [...present].filter((s) => !STATUS_META[s]).sort();
    return ["all", ...known, ...unknown];
  }, [invoices]);

  const visible = useMemo(
    () =>
      (invoices ?? []).filter(
        (inv) => filter === "all" || inv.status === filter,
      ),
    [invoices, filter],
  );

  // The number the owner actually wants: how much is still out there.
  const outstandingCents = useMemo(
    () =>
      (invoices ?? [])
        .filter(isOwing)
        .reduce((sum, inv) => sum + (inv.balanceCents ?? 0), 0),
    [invoices],
  );

  return (
    <AppLayout>
      <PageHeader
        title="Invoices"
        description="Invoices from Jobber and whether each one is paid or still owing. They come over automatically; use Sync now in Settings to pull the latest."
      />

      {outstandingCents > 0 && (
        <div className="mb-4 flex items-center gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5">
          <Receipt className="h-4 w-4 shrink-0" />
          <span>
            <span className="font-semibold">{money(outstandingCents)}</span>{" "}
            still owing across{" "}
            {(invoices ?? []).filter(isOwing).length === 1
              ? "1 invoice"
              : `${(invoices ?? []).filter(isOwing).length} invoices`}
            .
          </span>
        </div>
      )}

      {chips.length > 1 && (
        <div className="flex flex-wrap gap-2 mb-6">
          {chips.map((chip) => (
            <button
              key={chip}
              onClick={() => setFilter(chip)}
              className={cn(
                "px-3 py-1.5 rounded-full text-sm border transition-colors",
                filter === chip
                  ? "bg-gray-900 text-white border-gray-900"
                  : "bg-white text-gray-600 border-gray-300 hover:border-gray-400",
              )}
            >
              {chip === "all"
                ? "All"
                : (STATUS_META[chip]?.label ?? chip.replace(/_/g, " "))}
            </button>
          ))}
        </div>
      )}

      {isLoading ? (
        <LoadingSpinner />
      ) : isError ? (
        <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-4">
          <AlertCircle className="h-4 w-4 shrink-0" />
          We couldn't load your invoices. Refresh to try again.
        </div>
      ) : visible.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-gray-300 rounded-lg">
          <Receipt className="h-8 w-8 text-gray-300 mx-auto mb-3" />
          {filter !== "all" ? (
            <p className="text-sm text-gray-500">
              No invoices with that status.
            </p>
          ) : (
            <>
              <p className="text-sm font-medium text-gray-700">
                No Jobber invoices yet
              </p>
              <p className="text-sm text-gray-500 mt-1">
                Invoices you write in Jobber show up here after the next sync —
                you can nudge it with Sync now in Settings.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((inv: JobberInvoice) => (
            <div
              key={inv.id}
              className="border border-gray-200 rounded-lg bg-white p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-gray-900 leading-tight">
                    {inv.clientName || inv.subject || "Invoice"}
                    {inv.invoiceNumber && (
                      <span className="text-gray-400 font-normal">
                        {" "}
                        · #{inv.invoiceNumber}
                      </span>
                    )}
                  </p>
                  {inv.subject && inv.clientName && (
                    <p className="text-sm text-gray-500 mt-0.5">
                      {inv.subject}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {money(inv.totalCents) && (
                    <span className="text-sm font-semibold text-gray-900">
                      {money(inv.totalCents)}
                    </span>
                  )}
                  {statusBadge(inv.status)}
                </div>
              </div>
              <CustomerTagChip
                tag={inv.tag}
                testid={`chip-tag-invoice-${inv.id}`}
              />

              {isOwing(inv) && inv.balanceCents !== inv.totalCents && (
                <p className="mt-1 text-sm text-amber-700">
                  {money(inv.balanceCents)} still owing
                </p>
              )}

              <div className="mt-2 space-y-1 text-sm text-gray-600">
                {inv.propertyAddress && (
                  <p className="flex items-start gap-2">
                    <MapPin className="h-3.5 w-3.5 text-gray-400 shrink-0 mt-0.5" />
                    <span>{inv.propertyAddress}</span>
                  </p>
                )}
                {inv.clientPhone && (
                  <p className="flex items-center gap-2">
                    <Phone className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                    {inv.clientPhone}
                  </p>
                )}
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-400">
                <span>
                  {inv.issuedAt &&
                    `Issued ${formatZoned(inv.issuedAt, timeZone)}`}
                  {inv.dueAt && ` · Due ${formatZoned(inv.dueAt, timeZone)}`}
                </span>
                {inv.jobberWebUri && (
                  <a
                    href={inv.jobberWebUri}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-gray-500 hover:text-gray-900 hover:underline"
                  >
                    Open in Jobber
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
              <div className="mt-3">
                <CustomerTagPicker
                  kind="invoice"
                  id={inv.id}
                  value={inv.tag}
                  testidPrefix={`button-tag-invoice-${inv.id}`}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </AppLayout>
  );
}
