/**
 * Quote arithmetic, shared by the API server and the dashboard.
 *
 * This lives in its own package on purpose. The dispatcher watches a running
 * total while they build a quote, and the server decides the number the
 * customer is actually texted. If those two used separate copies of the maths,
 * they would eventually disagree — and the disagreement would only ever be
 * discovered by a customer being quoted the wrong price.
 *
 * Deliberately dependency-free so the browser bundle stays small.
 */

/** One row of a quote, matching the columns customers see on an estimate. */
export type QuoteLineItem = {
  name: string;
  /** Usually hours. */
  quantity: number;
  /** Negative for a discount line. */
  unitPrice: number;
};

/** The company's rates and policy. */
export type QuoteRates = {
  /** Hourly rate for one cleaner. */
  rateSolo: number;
  /** Hourly rate for a two-cleaner crew. */
  rateTeam: number;
  fuelSurcharge: number;
  taxLabel: string;
  taxRate: number;
  feesLabel: string;
  feesRate: number;
  depositAmount: number;
  depositEmail?: string | null;
};

/** What the dispatcher chose for this particular job. */
export type QuotePricing = {
  quoteHours?: number | null;
  quoteCrewLabel?: string | null;
  quoteHourlyRate?: number | null;
  /** Null falls back to the company default; 0 waives it. */
  quoteFuelSurcharge?: number | null;
  quoteDiscountAmount?: number | null;
  quoteReferralSource?: string | null;
  /** Used only when the job was priced without the calculator. */
  quotedAmount?: number | null;
  quoteDeposit?: number | null;
};

export type QuoteTotals = {
  lineItems: QuoteLineItem[];
  subtotal: number;
  taxLabel: string;
  taxRate: number;
  taxAmount: number;
  feesLabel: string;
  feesRate: number;
  feesAmount: number;
  total: number;
  deposit: number;
  depositEmail: string | null;
};

/**
 * Round to cents the way the printed estimates do: half away from zero.
 *
 * Neither obvious approach is safe on its own. `Math.round(x * 100) / 100`
 * rounds half toward +infinity, so it mishandles negatives (discount lines).
 * `toFixed` looks decimal but still rounds the underlying binary double, so a
 * value the owner typed as 2.675 is stored as 2.67499999999999982... and rounds
 * DOWN to 2.67 — a cent adrift from the estimate the customer is holding.
 *
 * So: scale to cents, nudge by a relative epsilon to undo the representation
 * error, then round away from zero.
 */
export function roundMoney(amount: number): number {
  if (!Number.isFinite(amount)) return 0;
  const scaled = amount * 100;
  const nudged = Math.abs(scaled) * (1 + Number.EPSILON * 4);
  return (Math.sign(scaled) * Math.round(nudged)) / 100;
}

export function lineItemTotal(item: QuoteLineItem): number {
  return roundMoney(item.quantity * item.unitPrice);
}

/** True once the job has been priced with the hourly calculator. */
export function isCalculatorPriced(pricing: QuotePricing): boolean {
  return (
    pricing.quoteHours != null &&
    pricing.quoteHours > 0 &&
    pricing.quoteHourlyRate != null
  );
}

/**
 * Rebuild the estimate's line items from what the dispatcher chose. Mirrors the
 * rows on the printed estimate: the work, the fuel surcharge, then the promo.
 */
export function buildLineItems(
  rates: QuoteRates,
  pricing: QuotePricing,
  serviceName: string,
): QuoteLineItem[] {
  if (!isCalculatorPriced(pricing)) return [];

  const items: QuoteLineItem[] = [
    {
      name: pricing.quoteCrewLabel
        ? `${serviceName} (${pricing.quoteCrewLabel})`
        : serviceName,
      quantity: pricing.quoteHours!,
      unitPrice: pricing.quoteHourlyRate!,
    },
  ];

  const fuel = pricing.quoteFuelSurcharge ?? rates.fuelSurcharge;
  if (fuel > 0) {
    items.push({ name: "Fuel Surcharge", quantity: 1, unitPrice: fuel });
  }

  const discount = pricing.quoteDiscountAmount ?? 0;
  if (discount > 0) {
    const source = pricing.quoteReferralSource?.trim();
    items.push({
      name: source
        ? `Discount $${discount} ${source} Promo`
        : `Discount $${discount}`,
      quantity: 1,
      unitPrice: -discount,
    });
  }

  return items;
}

export function computeQuoteTotals(
  rates: QuoteRates,
  pricing: QuotePricing,
  serviceName: string,
): QuoteTotals {
  const lineItems = buildLineItems(rates, pricing, serviceName);

  // The calculator wins when it has been used; otherwise the dispatcher typed a
  // flat subtotal. Either way tax and fees go on top, matching the estimates.
  const subtotal = lineItems.length
    ? roundMoney(lineItems.reduce((sum, item) => sum + lineItemTotal(item), 0))
    : roundMoney(pricing.quotedAmount ?? 0);

  const taxAmount = roundMoney((subtotal * rates.taxRate) / 100);
  const feesAmount = roundMoney((subtotal * rates.feesRate) / 100);

  return {
    lineItems,
    subtotal,
    taxLabel: rates.taxLabel,
    taxRate: rates.taxRate,
    taxAmount,
    feesLabel: rates.feesLabel,
    feesRate: rates.feesRate,
    feesAmount,
    total: roundMoney(subtotal + taxAmount + feesAmount),
    deposit: roundMoney(pricing.quoteDeposit ?? rates.depositAmount),
    depositEmail: rates.depositEmail ?? null,
  };
}

/** Quotes always show cents — that is how the printed estimates read. */
export function formatMoney(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  return `${sign}$${Math.abs(amount).toFixed(2)}`;
}

/** "5%" rather than "5.00%", but "7.5%" keeps its half. */
export function formatRate(rate: number): string {
  return `${Number(rate.toFixed(2))}%`;
}

/**
 * The dollar figure a quote text promises the customer.
 *
 * The generated draft leads with the deposit when there is one, and the total
 * otherwise — so that is the number a hand-edit can put the booking at odds
 * with. Null when nothing has been priced yet, in which case the dispatcher is
 * expected to type an amount by hand and there is nothing to contradict.
 */
export function quotedPriceAnchor(
  totals: Pick<QuoteTotals, "total" | "deposit">,
): number | null {
  if (totals.deposit > 0) return totals.deposit;
  if (totals.total > 0) return totals.total;
  return null;
}

/**
 * Does the message still quote the calculated price?
 *
 * Shared by the dialog (to warn before sending) and the server (to refuse an
 * unconfirmed mismatch) so the two can never disagree about what counts as
 * "the price is in the text". Lenient about formatting — "$150.00", "$150" for
 * whole dollars, and "$1,500.00" all count — but the amount itself must match
 * to the cent.
 */
export function messageContainsQuotePrice(
  message: string,
  totals: Pick<QuoteTotals, "total" | "deposit">,
): boolean {
  const anchor = quotedPriceAnchor(totals);
  if (anchor == null) return true;

  const cents = Math.round(Math.abs(anchor) * 100);
  const dollars = Math.floor(cents / 100);
  const centPart = String(cents % 100).padStart(2, "0");
  const withCommas = dollars.toLocaleString("en-US");

  const candidates = new Set<string>([
    `$${dollars}.${centPart}`,
    `$${withCommas}.${centPart}`,
  ]);
  if (cents % 100 === 0) {
    candidates.add(`$${dollars}`);
    candidates.add(`$${withCommas}`);
  }

  for (const candidate of candidates) {
    let idx = message.indexOf(candidate);
    while (idx !== -1) {
      // "$150" must not be satisfied by "$150.75" or "$1500".
      const next = message[idx + candidate.length];
      if (
        next === undefined ||
        !/[\d.]/.test(next) ||
        (next === "." && !/\d/.test(message[idx + candidate.length + 1] ?? ""))
      ) {
        return true;
      }
      idx = message.indexOf(candidate, idx + 1);
    }
  }
  return false;
}
