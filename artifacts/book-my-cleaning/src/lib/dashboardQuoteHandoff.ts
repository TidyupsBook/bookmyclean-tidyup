import type { QuoteDraft } from "@/components/QuoteCalculator";

export const DASHBOARD_QUOTE_HANDOFF_KEY = "dashboardQuoteHandoff";

export type DashboardQuoteHandoff = {
  customerName: string;
  serviceName: string;
  quote: QuoteDraft;
};

export function saveDashboardQuoteHandoff(value: DashboardQuoteHandoff): void {
  window.sessionStorage.setItem(
    DASHBOARD_QUOTE_HANDOFF_KEY,
    JSON.stringify(value),
  );
}

export function takeDashboardQuoteHandoff(): DashboardQuoteHandoff | null {
  const raw = window.sessionStorage.getItem(DASHBOARD_QUOTE_HANDOFF_KEY);
  if (!raw) return null;
  window.sessionStorage.removeItem(DASHBOARD_QUOTE_HANDOFF_KEY);

  try {
    const parsed = JSON.parse(raw) as Partial<DashboardQuoteHandoff>;
    if (!parsed.quote || typeof parsed.customerName !== "string") return null;
    return {
      customerName: parsed.customerName,
      serviceName:
        typeof parsed.serviceName === "string" ? parsed.serviceName : "",
      quote: parsed.quote,
    };
  } catch {
    return null;
  }
}
