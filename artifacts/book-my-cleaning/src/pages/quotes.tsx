import { useMemo, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader, LoadingSpinner } from "@/components/ui/shared";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  useListJobberQuotes,
  useGetCompany,
  JobberQuote,
} from "@workspace/api-client-react";
import { companyTimeZone, formatZoned } from "@/lib/time";
import {
  FileText,
  ExternalLink,
  MapPin,
  Phone,
  AlertCircle,
} from "lucide-react";

/**
 * Quotes written in Jobber, mirrored here read-only so the desk can see
 * where each one stands — who's approved, who's still thinking — without
 * opening Jobber. The "Open in Jobber" link is the way to edit one; nothing
 * on this page writes back.
 */

const STATUS_META: Record<string, { label: string; className: string }> = {
  draft: {
    label: "Draft",
    className: "bg-gray-100 text-gray-600 border-gray-200",
  },
  awaiting_response: {
    label: "Awaiting response",
    className: "bg-amber-50 text-amber-700 border-amber-200",
  },
  changes_requested: {
    label: "Changes requested",
    className: "bg-orange-50 text-orange-700 border-orange-200",
  },
  approved: {
    label: "Approved",
    className: "bg-green-50 text-green-700 border-green-200",
  },
  converted: {
    label: "Converted to job",
    className: "bg-blue-50 text-blue-700 border-blue-200",
  },
  archived: {
    label: "Archived",
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

export function QuotesPage() {
  const { data: quotes, isLoading, isError } = useListJobberQuotes();
  const { data: company } = useGetCompany();
  const timeZone = companyTimeZone(company);
  const [filter, setFilter] = useState<string>("all");

  // Only offer chips for statuses that actually exist in this company's
  // quotes, in a fixed, meaningful order.
  const chips = useMemo(() => {
    const present = new Set((quotes ?? []).map((q) => q.status));
    const known = Object.keys(STATUS_META).filter((s) => present.has(s));
    const unknown = [...present].filter((s) => !STATUS_META[s]).sort();
    return ["all", ...known, ...unknown];
  }, [quotes]);

  const visible = useMemo(
    () => (quotes ?? []).filter((q) => filter === "all" || q.status === filter),
    [quotes, filter],
  );

  return (
    <AppLayout>
      <PageHeader
        title="Quotes"
        description="Quotes from Jobber and where each one stands. They come over automatically; use Sync now in Settings to pull the latest."
      />

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
          We couldn't load your quotes. Refresh to try again.
        </div>
      ) : visible.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-gray-300 rounded-lg">
          <FileText className="h-8 w-8 text-gray-300 mx-auto mb-3" />
          {filter !== "all" ? (
            <p className="text-sm text-gray-500">No quotes with that status.</p>
          ) : (
            <>
              <p className="text-sm font-medium text-gray-700">
                No Jobber quotes yet
              </p>
              <p className="text-sm text-gray-500 mt-1">
                Quotes you write in Jobber show up here after the next sync —
                you can nudge it with Sync now in Settings.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((q: JobberQuote) => (
            <div
              key={q.id}
              className="border border-gray-200 rounded-lg bg-white p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-gray-900 leading-tight">
                    {q.clientName || q.title || "Quote"}
                    {q.quoteNumber != null && (
                      <span className="text-gray-400 font-normal">
                        {" "}
                        · #{q.quoteNumber}
                      </span>
                    )}
                  </p>
                  {q.title && q.clientName && (
                    <p className="text-sm text-gray-500 mt-0.5">{q.title}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {money(q.totalCents) && (
                    <span className="text-sm font-semibold text-gray-900">
                      {money(q.totalCents)}
                    </span>
                  )}
                  {statusBadge(q.status)}
                </div>
              </div>

              <div className="mt-2 space-y-1 text-sm text-gray-600">
                {q.propertyAddress && (
                  <p className="flex items-start gap-2">
                    <MapPin className="h-3.5 w-3.5 text-gray-400 shrink-0 mt-0.5" />
                    <span>{q.propertyAddress}</span>
                  </p>
                )}
                {q.clientPhone && (
                  <p className="flex items-center gap-2">
                    <Phone className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                    {q.clientPhone}
                  </p>
                )}
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-400">
                <span>
                  {q.jobberCreatedAt &&
                    `Created ${formatZoned(q.jobberCreatedAt, timeZone)}`}
                  {q.sentAt && ` · Sent ${formatZoned(q.sentAt, timeZone)}`}
                </span>
                {q.jobberWebUri && (
                  <a
                    href={q.jobberWebUri}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-gray-500 hover:text-gray-900 hover:underline"
                  >
                    Open in Jobber
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </AppLayout>
  );
}
