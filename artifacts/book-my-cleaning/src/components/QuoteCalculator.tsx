import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trackEvent } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import {
  computeQuoteTotals,
  formatMoney,
  formatRate,
  lineItemTotal,
  type QuoteRates,
} from "@workspace/pricing";
import { Check, DollarSign, Loader2 } from "lucide-react";

/** The pricing choices for one job, as the dispatcher makes them. */
export type QuoteDraft = {
  hours: number | null;
  crewLabel: string | null;
  hourlyRate: number | null;
  /** Null means "use the company default"; 0 waives it. */
  fuelSurcharge: number | null;
  discountAmount: number | null;
  referralSource: string | null;
  deposit: number | null;
};

export const emptyQuoteDraft: QuoteDraft = {
  hours: null,
  crewLabel: null,
  hourlyRate: null,
  fuelSurcharge: null,
  discountAmount: null,
  referralSource: null,
  deposit: null,
};

const REFERRAL_SOURCES = [
  "Google",
  "Facebook",
  "Instagram",
  "TikTok",
  "Referral",
];
const DISCOUNTS = [10, 20];
const WHOLE_HOURS = [1, 2, 3, 4, 5];

function Chip({
  selected,
  onClick,
  children,
  className,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "px-3 py-1.5 rounded-full text-sm font-medium border transition-colors",
        selected
          ? "bg-brand-pink text-white border-brand-pink"
          : "bg-secondary/60 text-muted-foreground border-border hover:text-foreground hover:border-brand-pink/40",
        className,
      )}
    >
      {children}
    </button>
  );
}

function Row({
  label,
  value,
  muted,
  strong,
}: {
  label: string;
  value: string;
  muted?: boolean;
  strong?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex justify-between gap-4",
        muted && "text-muted-foreground",
        strong && "font-semibold text-foreground",
      )}
    >
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

export function QuoteCalculator({
  value,
  onChange,
  rates,
  serviceName,
  flatAmount,
  catalogPrice,
  onSaveQuote,
  canSaveQuote,
  saveQuoteBusy,
  saveQuoteHint,
}: {
  value: QuoteDraft;
  onChange: (next: QuoteDraft) => void;
  rates: QuoteRates;
  serviceName: string;
  /** A price set without the calculator, e.g. by the receptionist on the call. */
  flatAmount?: number | null;
  /** One exact per-unit price from Settings for the selected service. */
  catalogPrice?: number | null;
  /**
   * Save right here, the moment the quote is priced — without finishing the
   * rest of the form. Offered only once there are quote numbers to keep, and
   * it must be the host page's ordinary save so the partial-save rules, lead
   * conversion and Jobber push all still apply. Nothing is sent to the
   * customer.
   */
  onSaveQuote?: () => void;
  /** Whether the host page has enough to save at all (a name, at minimum). */
  canSaveQuote?: boolean;
  saveQuoteBusy?: boolean;
  /**
   * What pressing Save leads to, when the host page's save doesn't end on
   * the Bookings page (quote mode goes straight to the text-a-quote step).
   */
  saveQuoteHint?: string;
}) {
  const set = (patch: Partial<QuoteDraft>) => onChange({ ...value, ...patch });

  const hours = value.hours ?? 0;
  const wholeHours = Math.floor(hours);
  const hasHalfHour = hours % 1 === 0.5;

  const pickHours = (whole: number) =>
    set({ hours: whole + (hasHalfHour ? 0.5 : 0) });
  const toggleHalfHour = () =>
    set({ hours: Math.max(wholeHours, 1) + (hasHalfHour ? 0 : 0.5) });

  // Picking a crew size sets the rate to match, which is the whole point of the
  // preset. "Custom" keeps whatever is in the box so the number isn't lost.
  const pickCrew = (label: string, rate: number) =>
    set({ crewLabel: label, hourlyRate: rate });

  const totals = computeQuoteTotals(
    rates,
    {
      quoteHours: value.hours,
      quoteCrewLabel: value.crewLabel,
      quoteHourlyRate: value.hourlyRate,
      quoteFuelSurcharge: value.fuelSurcharge,
      quoteDiscountAmount: value.discountAmount,
      quoteReferralSource: value.referralSource,
      quoteDeposit: value.deposit,
    },
    serviceName || "Cleaning",
  );

  const priced = totals.lineItems.length > 0;
  const fuel = value.fuelSurcharge ?? rates.fuelSurcharge;
  const catalogPriceApplied =
    catalogPrice != null &&
    value.hours === 1 &&
    value.crewLabel === "flat rate" &&
    value.hourlyRate === catalogPrice;
  const applyCatalogPrice = () => {
    if (catalogPrice == null) return;
    onChange({
      ...value,
      hours: 1,
      crewLabel: "flat rate",
      hourlyRate: catalogPrice,
    });
    trackEvent("catalog_price_applied", {
      price: catalogPrice,
    });
  };

  return (
    <div className="rounded-xl border border-brand-pink/25 bg-brand-pink/[0.04] p-4 space-y-4">
      <div className="flex items-baseline justify-between">
        <h4 className="font-semibold text-foreground">Quoted price</h4>
        {priced && (
          <span className="text-sm font-bold text-brand-pink tabular-nums">
            {formatMoney(totals.total)}
          </span>
        )}
      </div>

      {catalogPrice != null && (
        <button
          type="button"
          onClick={applyCatalogPrice}
          aria-pressed={catalogPriceApplied}
          className={cn(
            "w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors",
            catalogPriceApplied
              ? "border-brand-pink bg-brand-pink/10 text-foreground"
              : "border-brand-pink/30 bg-background hover:border-brand-pink/60",
          )}
        >
          <span className="font-medium">
            {catalogPriceApplied ? "Using" : "Use"} service-table price
          </span>
          <span className="float-right font-bold text-brand-pink tabular-nums">
            {formatMoney(catalogPrice)}
          </span>
          <span className="block text-xs text-muted-foreground mt-0.5">
            Adds one unit of {serviceName || "this service"} to the quote.
          </span>
        </button>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm text-muted-foreground mr-1">Hours:</span>
        {WHOLE_HOURS.map((h) => (
          <Chip
            key={h}
            selected={wholeHours === h}
            onClick={() => pickHours(h)}
          >
            {h}
          </Chip>
        ))}
        {wholeHours > 5 && (
          <Chip selected onClick={() => pickHours(wholeHours)}>
            {wholeHours}
          </Chip>
        )}
        <Chip
          selected={false}
          onClick={() => pickHours(Math.max(wholeHours, 1) + 1)}
          className="px-2.5"
        >
          +1
        </Chip>
        <Chip selected={hasHalfHour} onClick={toggleHalfHour}>
          +&frac12;
        </Chip>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <Chip
          selected={value.crewLabel === "1 cleaner"}
          onClick={() => pickCrew("1 cleaner", rates.rateSolo)}
        >
          1 cleaner {formatMoney(rates.rateSolo)}/hr
        </Chip>
        <Chip
          selected={value.crewLabel === "2 cleaners"}
          onClick={() => pickCrew("2 cleaners", rates.rateTeam)}
        >
          2 cleaners {formatMoney(rates.rateTeam)}/hr
        </Chip>
        <Chip
          selected={value.crewLabel === null && value.hourlyRate != null}
          onClick={() => set({ crewLabel: null })}
        >
          Custom $/hr
        </Chip>
        {value.crewLabel === "flat rate" && (
          <Chip selected onClick={applyCatalogPrice}>
            Flat service price
          </Chip>
        )}
      </div>

      <div className="relative">
        <DollarSign className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-brand-pink" />
        <Input
          aria-label={
            value.crewLabel === "flat rate" ? "Unit price" : "Hourly rate"
          }
          inputMode="decimal"
          className="pl-10 text-lg font-semibold h-12"
          value={value.hourlyRate ?? ""}
          onChange={(e) => {
            const raw = e.target.value.trim();
            const parsed = raw === "" ? null : Number(raw);
            set({
              hourlyRate:
                parsed != null && Number.isNaN(parsed)
                  ? value.hourlyRate
                  : parsed,
              // Typing over a preset makes it a custom rate.
              crewLabel:
                parsed === rates.rateSolo
                  ? "1 cleaner"
                  : parsed === rates.rateTeam
                    ? "2 cleaners"
                    : null,
            });
          }}
          placeholder="0.00"
        />
      </div>

      <div>
        <p className="text-sm text-muted-foreground mb-2">
          How did they hear about us?
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          {REFERRAL_SOURCES.map((source) => (
            <Chip
              key={source}
              selected={value.referralSource === source}
              onClick={() =>
                set({
                  referralSource:
                    value.referralSource === source ? null : source,
                })
              }
            >
              {source}
            </Chip>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {DISCOUNTS.map((amount) => (
          <Chip
            key={amount}
            selected={value.discountAmount === amount}
            onClick={() =>
              set({
                discountAmount: value.discountAmount === amount ? null : amount,
              })
            }
          >
            &minus;${amount} off
          </Chip>
        ))}
      </div>

      {/* Each label stays glued to its own input, so a wrap can't strand a
          label above the wrong box. */}
      <div className="flex items-center gap-x-6 gap-y-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Label
            htmlFor="q-fuel"
            className="text-sm text-muted-foreground font-normal"
          >
            Fuel surcharge $
          </Label>
          <Input
            id="q-fuel"
            inputMode="decimal"
            className="w-24 h-9"
            value={value.fuelSurcharge ?? ""}
            placeholder={rates.fuelSurcharge.toFixed(2)}
            onChange={(e) => {
              const raw = e.target.value.trim();
              const parsed = raw === "" ? null : Number(raw);
              set({
                fuelSurcharge:
                  parsed != null && Number.isNaN(parsed)
                    ? value.fuelSurcharge
                    : parsed,
              });
            }}
          />
        </div>
        <div className="flex items-center gap-2">
          <Label
            htmlFor="q-deposit"
            className="text-sm text-muted-foreground font-normal"
          >
            Deposit $
          </Label>
          <Input
            id="q-deposit"
            inputMode="decimal"
            className="w-24 h-9"
            value={value.deposit ?? ""}
            placeholder={rates.depositAmount.toFixed(2)}
            onChange={(e) => {
              const raw = e.target.value.trim();
              const parsed = raw === "" ? null : Number(raw);
              set({
                deposit:
                  parsed != null && Number.isNaN(parsed)
                    ? value.deposit
                    : parsed,
              });
            }}
          />
        </div>
      </div>

      {priced ? (
        <div className="border-t border-border pt-3 space-y-1 text-sm">
          {totals.lineItems.map((item, i) => (
            <Row
              key={i}
              muted
              label={
                item.quantity === 1
                  ? item.name
                  : `${item.name} · ${item.quantity} x ${formatMoney(item.unitPrice)}`
              }
              value={formatMoney(lineItemTotal(item))}
            />
          ))}
          <div className="border-t border-border/60 pt-1 mt-1 space-y-1">
            <Row label="Subtotal" value={formatMoney(totals.subtotal)} />
            {totals.taxRate > 0 && (
              <Row
                muted
                label={`${totals.taxLabel} (${formatRate(totals.taxRate)})`}
                value={formatMoney(totals.taxAmount)}
              />
            )}
            <Row strong label="Total" value={formatMoney(totals.total)} />
            {totals.deposit > 0 && (
              <Row
                muted
                label="Deposit up front"
                value={formatMoney(totals.deposit)}
              />
            )}
          </div>
          {onSaveQuote && (
            <div className="pt-2 space-y-1.5">
              <Button
                className="w-full"
                size="sm"
                variant="secondary"
                disabled={!canSaveQuote || saveQuoteBusy}
                onClick={onSaveQuote}
                data-testid="button-save-quote"
              >
                {saveQuoteBusy ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Check className="w-4 h-4 mr-2" />
                )}
                Save quote
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                {canSaveQuote
                  ? (saveQuoteHint ??
                    "Saves the customer and this price now — finish the rest from the Bookings page. Nothing is sent to the customer.")
                  : "Needs the customer's name first."}
              </p>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground border-t border-border pt-3">
          {flatAmount != null
            ? `Currently priced at ${formatMoney(flatAmount)} before tax. Pick the hours and the crew to itemise it.`
            : `Pick the hours and the crew to price this job. Fuel${
                fuel > 0 ? ` (${formatMoney(fuel)})` : ""
              }, and 12.5% tax are added automatically.`}
        </p>
      )}
    </div>
  );
}
