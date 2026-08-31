import { Badge } from "@/components/ui/badge";
import { Globe, Briefcase, FileSpreadsheet, Phone } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Lead } from "@workspace/api-client-react";

/**
 * Shared status + source chips for leads, used by both the card inbox and
 * the table view so the two views can never drift apart.
 *
 * Source colors (one color per place a lead comes from):
 *   purple = our own website form
 *   green  = the Jobber form (Jobber's brand is green)
 *   blue   = the leads Google Sheet (Facebook/Instagram ads — Meta blue)
 */

export function LeadStatusBadge({ status }: { status: Lead["status"] }) {
  switch (status) {
    case "converted":
      return (
        <Badge className="bg-green-500/10 text-green-400 border-green-500/20 hover:bg-green-500/10">
          Converted
        </Badge>
      );
    case "dismissed":
      return (
        <Badge className="bg-secondary text-muted-foreground border-border hover:bg-secondary">
          Dismissed
        </Badge>
      );
    default:
      // Orange = leads everywhere (sidebar count, mobile banner), so an
      // unresolved lead never reads as a text or a call.
      return (
        <Badge className="bg-brand-orange/10 text-brand-orange border-brand-orange/20 hover:bg-brand-orange/10">
          New
        </Badge>
      );
  }
}

/**
 * "This lead has actually been on the phone with us" — shown only when the
 * server matched the lead's number against the company's call history. The
 * server decides the flag (it rides in the lead payload), so web and mobile
 * can never disagree about what the badge means.
 */
export function LeadCalledBadge({ lead }: { lead: Lead }) {
  if (!lead.hasCalled) return null;
  return (
    <Badge
      className="bg-teal-500/10 text-teal-400 border-teal-500/20 hover:bg-teal-500/10 whitespace-nowrap"
      title={
        lead.lastCallAt
          ? `Last call ${formatDistanceToNow(new Date(lead.lastCallAt), { addSuffix: true })}`
          : undefined
      }
      data-testid={`badge-called-${lead.id}`}
    >
      <Phone className="w-3 h-3 mr-1" />
      Called
    </Badge>
  );
}

export function LeadSourceBadge({
  lead,
  compact = false,
}: {
  lead: Lead;
  /** Short labels for tight spots like table cells. */
  compact?: boolean;
}) {
  if (lead.source === "form") {
    return (
      <Badge
        className="bg-brand-purple/10 text-brand-purple border-brand-purple/20 hover:bg-brand-purple/10 whitespace-nowrap"
        data-testid={`badge-form-${lead.id}`}
      >
        <Globe className="w-3 h-3 mr-1" />
        {compact ? "Website" : "Website form"}
      </Badge>
    );
  }
  if (lead.source === "jobber") {
    return (
      <Badge
        className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/10 whitespace-nowrap"
        data-testid={`badge-jobber-${lead.id}`}
      >
        <Briefcase className="w-3 h-3 mr-1" />
        {compact ? "Jobber" : "From Jobber"}
      </Badge>
    );
  }
  if (lead.source === "sheet") {
    return (
      <Badge
        className="bg-sky-500/10 text-sky-400 border-sky-500/20 hover:bg-sky-500/10 whitespace-nowrap"
        data-testid={`badge-sheet-${lead.id}`}
      >
        <FileSpreadsheet className="w-3 h-3 mr-1" />
        {compact ? "Sheet" : "From Google Sheet"}
      </Badge>
    );
  }
  if (lead.source === "call") {
    return (
      <Badge
        className="bg-teal-500/10 text-teal-400 border-teal-500/20 hover:bg-teal-500/10 whitespace-nowrap"
        data-testid={`badge-call-source-${lead.id}`}
      >
        <Phone className="w-3 h-3 mr-1" />
        {compact ? "Call" : "From phone call"}
      </Badge>
    );
  }
  return null;
}
