import type { Company } from "@workspace/api-client-react";
import {
  FIXED_TAX_LABEL,
  FIXED_TAX_RATE,
  type QuoteRates,
} from "@workspace/pricing";

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
    taxLabel: FIXED_TAX_LABEL,
    taxRate: FIXED_TAX_RATE,
    feesLabel: "",
    feesRate: 0,
    depositAmount: company?.quoteDepositAmount ?? 0,
    depositEmail: company?.quoteDepositEmail ?? null,
  };
}
