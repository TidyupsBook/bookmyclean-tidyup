import type { ReactNode } from "react";
import { formatDistanceToNow } from "date-fns";
import { ExternalLink } from "lucide-react";
import { Link } from "wouter";
import type { Lead } from "@workspace/api-client-react";
import { LeadSourceBadge } from "@/components/lead-badges";
import { TagChip } from "@/components/TagControls";
import { cn } from "@/lib/utils";

function DetailItem({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={cn("min-w-0", wide && "md:col-span-2 xl:col-span-3")}>
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 text-sm text-foreground break-words">{children}</dd>
    </div>
  );
}

function exactDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** All lead details that do not fit comfortably in a spreadsheet row. */
export function LeadsTableDetails({ lead }: { lead: Lead }) {
  const address = [lead.streetAddress, lead.city, lead.province, lead.postCode]
    .filter(Boolean)
    .join(", ");
  const sourceDetails = [
    lead.sourceTab,
    lead.platform,
    lead.campaignName,
    lead.adName,
    lead.formName,
  ]
    .filter(Boolean)
    .join(" · ");
  const lastCallAt = lead.lastCallAt ?? null;

  return (
    <dl className="grid gap-x-8 gap-y-5 md:grid-cols-2 xl:grid-cols-3">
      <DetailItem label="Phone">
        {lead.phoneDisplay?.trim() ? (
          lead.phoneE164 ? (
            <a className="hover:underline" href={`tel:${lead.phoneE164}`}>
              {lead.phoneDisplay.trim()}
            </a>
          ) : (
            lead.phoneDisplay.trim()
          )
        ) : (
          "No phone"
        )}
      </DetailItem>
      <DetailItem label="Email">
        {lead.email ? (
          <a className="hover:underline" href={`mailto:${lead.email}`}>
            {lead.email}
          </a>
        ) : (
          "No email"
        )}
      </DetailItem>
      <DetailItem label="Owner tag">
        <TagChip tag={lead.tag} testid={`table-detail-tag-${lead.id}`} />
        {!lead.tag ? "No tag" : null}
      </DetailItem>

      <DetailItem label="Service">{lead.service || "—"}</DetailItem>
      <DetailItem label="Bedrooms">{lead.bedrooms || "—"}</DetailItem>
      <DetailItem label="Bathrooms">{lead.bathrooms || "—"}</DetailItem>
      <DetailItem label="Requested date">
        {lead.dateOfServiceRequested || "—"}
      </DetailItem>
      <DetailItem label="Full address" wide>
        {address || "—"}
      </DetailItem>
      <DetailItem label="Their message" wide>
        {lead.message || "No message"}
      </DetailItem>
      <DetailItem label="Heard about us">{lead.heardAbout || "—"}</DetailItem>

      <DetailItem label="Source">
        <span className="inline-flex flex-wrap items-center gap-2">
          <LeadSourceBadge lead={lead} />
          {sourceDetails ? (
            <span className="text-muted-foreground">{sourceDetails}</span>
          ) : null}
        </span>
      </DetailItem>
      <DetailItem label="External reference">
        {lead.externalId || "—"}
      </DetailItem>
      <DetailItem label="Sheet lead status">
        {lead.sheetLeadStatus || "—"}
      </DetailItem>
      <DetailItem label="Received">{exactDate(lead.createdAt)}</DetailItem>
      <DetailItem label="Submitted at">
        {exactDate(lead.createdTime)}
      </DetailItem>
      <DetailItem label="Last call">
        {lastCallAt
          ? `${exactDate(lastCallAt)} (${formatDistanceToNow(new Date(lastCallAt), { addSuffix: true })})`
          : "No matched call"}
      </DetailItem>
      <DetailItem label="Conversion">
        {lead.convertedBookingId != null ? (
          <Link
            href={`/bookings#booking-${lead.convertedBookingId}`}
            className="hover:underline"
          >
            Booking #{lead.convertedBookingId}
          </Link>
        ) : lead.convertedAt ? (
          `Converted ${exactDate(lead.convertedAt)}`
        ) : (
          "Not converted"
        )}
      </DetailItem>
      <DetailItem label="Jobber">
        <span
          className={cn(
            "font-medium",
            lead.jobberPushError
              ? "text-red-400"
              : lead.jobberSynced
                ? "text-emerald-400"
                : "text-muted-foreground",
          )}
        >
          {lead.jobberPushError
            ? `Sync failed: ${lead.jobberPushError}`
            : lead.jobberSynced
              ? "Synced"
              : "Not synced"}
        </span>
      </DetailItem>
      <DetailItem label="Map location">
        {lead.lat != null && lead.lng != null
          ? `${lead.lat.toFixed(5)}, ${lead.lng.toFixed(5)}`
          : "Not located"}
      </DetailItem>

      {lead.jobberWebUri || lead.inboxUrl ? (
        <DetailItem label="Open original" wide>
          <span className="flex flex-wrap gap-4">
            {lead.jobberWebUri ? (
              <a
                href={lead.jobberWebUri}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-primary hover:underline"
                data-testid={`table-detail-jobber-${lead.id}`}
              >
                View request in Jobber
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            ) : null}
            {lead.inboxUrl ? (
              <a
                href={lead.inboxUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-primary hover:underline"
                data-testid={`table-detail-inbox-${lead.id}`}
              >
                Open in Meta inbox
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            ) : null}
          </span>
        </DetailItem>
      ) : null}
    </dl>
  );
}
