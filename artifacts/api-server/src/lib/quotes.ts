import type { Booking, Company } from "@workspace/db";
import {
  computeQuoteTotals as computeTotals,
  formatMoney,
  formatRate,
  lineItemTotal,
  type QuoteLineItem,
  type QuotePricing,
  type QuoteRates,
  type QuoteTotals,
} from "@workspace/pricing";

/**
 * Customer-facing quote text.
 *
 * The message is only ever a starting point — the dispatcher sees it and can
 * edit it before it sends, and whatever they actually send is stored on the
 * booking. Keep it short: this goes out as an SMS.
 *
 * The arithmetic itself lives in @workspace/pricing so the dashboard's live
 * preview and this text cannot drift apart.
 */

export { formatMoney, type QuoteTotals };

/** The company's rates and policy, in the shape pricing expects. */
export function companyQuoteRates(company: Company): QuoteRates {
  return {
    rateSolo: company.quoteRateSolo,
    rateTeam: company.quoteRateTeam,
    fuelSurcharge: company.quoteFuelSurcharge,
    taxLabel: company.quoteTaxLabel,
    taxRate: company.quoteTaxRate,
    feesLabel: company.quoteFeesLabel,
    feesRate: company.quoteFeesRate,
    depositAmount: company.quoteDepositAmount,
    depositEmail: company.quoteDepositEmail,
  };
}

/**
 * Derived, never stored: a company that changes its tax rate must not end up
 * with old quotes whose parts no longer add up to their own total.
 */
export function computeQuoteTotals(
  company: Company,
  booking: QuotePricing & Pick<Booking, "service">,
): QuoteTotals {
  return computeTotals(companyQuoteRates(company), booking, booking.service);
}

function customerGreetingName(fullName: string): string {
  const name = fullName.trim();
  // Calls often land with a placeholder name; "Hey there" beats "Hey Unknown".
  if (!name || /^(unknown|caller|customer)$/i.test(name)) return "there";
  return name;
}

export function formatAppointment(when: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
      timeZone,
    }).format(when);
  } catch {
    // An invalid stored zone must not stop a quote going out.
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
      timeZone: "UTC",
    }).format(when);
  }
}

/**
 * The text the customer receives.
 *
 * Deliberately short. The full estimate — line items, tax, fees, the service
 * description, the appointment — lives on the linked page, which is a far
 * better place to read a breakdown than a wall of SMS. The text's only jobs are
 * to say who it's from, say what's owed up front, and get them to tap.
 */
export function buildQuoteMessage(
  company: Company,
  booking: Booking,
  quoteUrl: string,
): string {
  const totals = computeQuoteTotals(company, booking);
  const lines: string[] = [];

  lines.push(`Hey ${customerGreetingName(booking.customerName)}!`);
  lines.push(`\u2728Quote From: ${company.name}\u2728`);
  lines.push("");

  if (totals.deposit > 0) {
    const where = totals.depositEmail
      ? ` You can send to: ${totals.depositEmail}`
      : "";
    lines.push(`Your deposit amount: ${formatMoney(totals.deposit)}.${where}`);
    lines.push("");
  } else if (totals.total > 0) {
    // No deposit on this job — lead with the total instead, so the text still
    // tells them something about money rather than being a bare link.
    lines.push(`Your quote total: ${formatMoney(totals.total)}`);
    lines.push("");
  }

  lines.push("CLICK LINK TO VIEW QUOTE:");
  lines.push("\u{1F447}".repeat(9));
  lines.push("");
  lines.push("View your estimate here:");
  lines.push(quoteUrl);

  return lines.join("\n");
}
