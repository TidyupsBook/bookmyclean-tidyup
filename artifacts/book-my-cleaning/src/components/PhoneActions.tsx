/**
 * A customer's number, readable and one tap from reaching them.
 *
 * The number itself dials; the small text bubble opens the app's own Messages
 * thread with that customer, so a reply comes back to the business line rather
 * than into somebody's personal phone where nobody else can see it.
 */
import { Link } from "wouter";
import { Phone, MessageSquare } from "lucide-react";
import { formatPhone, telHref } from "@/lib/phone";

export function PhoneActions({
  phone,
  name,
  className = "",
  compact = false,
}: {
  phone?: string | null;
  name?: string | null;
  className?: string;
  compact?: boolean;
}) {
  const pretty = formatPhone(phone);
  const dial = telHref(phone);
  if (!pretty) {
    return (
      <span className={`text-muted-foreground opacity-60 ${className}`}>
        No phone number
      </span>
    );
  }

  const thread = `/messages?to=${encodeURIComponent(phone!.trim())}${
    name ? `&name=${encodeURIComponent(name)}` : ""
  }`;
  const iconSize = compact ? "w-3 h-3" : "w-3.5 h-3.5";

  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      {dial ? (
        <a
          href={dial}
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1.5 hover:text-brand-pink transition-colors tabular-nums"
          data-testid="link-call-phone"
        >
          <Phone className={`${iconSize} shrink-0`} />
          {pretty}
        </a>
      ) : (
        <span className="tabular-nums">{pretty}</span>
      )}
      <Link
        href={thread}
        onClick={(e) => e.stopPropagation()}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-brand-pink transition-colors"
        title="Text from your business line"
        data-testid="link-text-phone"
      >
        <MessageSquare className={iconSize} />
        {compact ? "" : "Text"}
      </Link>
    </span>
  );
}
