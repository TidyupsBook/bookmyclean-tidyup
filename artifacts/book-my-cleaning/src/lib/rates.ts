import type { Company } from "@workspace/api-client-react";
import type { QuoteRates } from "@workspace/pricing";

/**
 * The company's pricing policy in the shape the shared quote maths expects.
 *
 * The fallbacks only apply for the moment before the company has loaded — the
 * server always sends every field, and these match the schema defaults so a
 * flash of different numbers can't happen.
 */
export function companyQuoteRates(company?: Company): QuoteRates {
  return {
    rateSolo: company?.quoteRateSolo ?? 52.5,
    rateTeam: company?.quoteRateTeam ?? 105,
    fuelSurcharge: company?.quoteFuelSurcharge ?? 12.5,
    taxLabel: company?.quoteTaxLabel ?? "Alberta Tax",
    taxRate: company?.quoteTaxRate ?? 5,
    feesLabel: company?.quoteFeesLabel ?? "Fees & Supplies",
    feesRate: company?.quoteFeesRate ?? 7.5,
    depositAmount: company?.quoteDepositAmount ?? 0,
    depositEmail: company?.quoteDepositEmail ?? null,
  };
}
