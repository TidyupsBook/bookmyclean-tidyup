// @vitest-environment jsdom
/**
 * The lead card's two doors into the booking form: "Create booking" (the
 * calendar-first trip) and "Create quote" (the price-first trip that ends in
 * the text-a-quote step). These pin that every non-converted lead offers
 * both, that the quote door carries &intent=quote, and that a converted
 * lead's card offers neither — only the link to its booking.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

function query(data?: unknown) {
  return { data, isLoading: false };
}
function mutation() {
  return { mutate: vi.fn(), isPending: false };
}

function lead(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    name: `Lead ${id}`,
    status: "new",
    source: "sheet",
    sourceTab: "Facebook",
    createdAt: "2026-08-10T14:00:00.000Z",
    createdTime: null,
    phoneDisplay: "",
    phoneE164: null,
    email: null,
    service: null,
    bedrooms: null,
    bathrooms: null,
    dateOfServiceRequested: null,
    heardAbout: null,
    message: null,
    streetAddress: null,
    city: null,
    province: null,
    postCode: null,
    platform: null,
    campaignName: null,
    inboxUrl: null,
    jobberSynced: false,
    jobberPushError: null,
    jobberWebUri: null,
    convertedBookingId: null,
    lat: null,
    lng: null,
    tag: null,
    ...over,
  };
}

let leadsFixture: ReturnType<typeof lead>[] = [];
const navigateSpy = vi.hoisted(() => vi.fn());
const tagMutateSpy = vi.hoisted(() => vi.fn());
const contactMutateSpy = vi.hoisted(() => vi.fn());

vi.mock("wouter", () => ({
  useLocation: () => ["/leads", navigateSpy],
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useListLeads: () => query(leadsFixture),
  useGetLeadSyncStatus: () => query(undefined),
  useGetMapConfig: () => query({ configured: false }),
  useSyncLeads: mutation,
  useDismissLead: mutation,
  useSyncLeadToJobber: mutation,
  useUpdateLeadContact: () => ({
    mutate: contactMutateSpy,
    isPending: false,
  }),
  useUpdateLeadTag: () => ({ mutate: tagMutateSpy, isPending: false }),
  getListLeadsQueryKey: () => ["/api/leads"],
  getGetLeadSyncStatusQueryKey: () => ["/api/leads/sync-status"],
  getGetDashboardSummaryQueryKey: () => ["/api/dashboard"],
}));

vi.mock("@/components/layout/AppLayout", () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@/components/LeadsMap", () => ({ LeadsMap: () => null }));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { LeadsPage } from "./leads";

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <LeadsPage />
    </QueryClientProvider>,
  );
  return client;
}

afterEach(() => {
  cleanup();
  leadsFixture = [];
  navigateSpy.mockReset();
  tagMutateSpy.mockReset();
  contactMutateSpy.mockReset();
});

describe("lead source badges", () => {
  it("shows a 'From Google Sheet' badge for sheet-sourced leads", () => {
    leadsFixture = [lead(10)]; // fixture defaults: source:"sheet"
    renderPage();
    expect(screen.getByTestId("badge-sheet-10")).toBeInTheDocument();
  });

  it("shows a 'Website form' badge for form leads and no sheet badge", () => {
    leadsFixture = [lead(11, { source: "form", sourceTab: null })];
    renderPage();
    // form badge exists by testid; no sheet badge
    expect(screen.getByTestId("badge-form-11")).toBeInTheDocument();
    expect(screen.queryByTestId("badge-sheet-11")).not.toBeInTheDocument();
  });

  it("shows a 'From Jobber' badge for jobber leads and no sheet badge", () => {
    leadsFixture = [lead(12, { source: "jobber", sourceTab: null })];
    renderPage();
    expect(screen.getByTestId("badge-jobber-12")).toBeInTheDocument();
    expect(screen.queryByTestId("badge-sheet-12")).not.toBeInTheDocument();
  });

  it("still shows the tab name alongside the sheet badge", () => {
    leadsFixture = [lead(13, { sourceTab: "Facebook" })];
    renderPage();
    expect(screen.getByTestId("badge-sheet-13")).toBeInTheDocument();
    expect(screen.getByText("Facebook")).toBeInTheDocument();
  });
});

describe("the lead card's Create quote button", () => {
  it("sits beside Create booking and opens the form in quote mode", () => {
    // phoneE164 must be present — clicking Create quote without a dialable
    // phone shows an inline nudge instead of navigating.
    leadsFixture = [
      lead(5, { phoneE164: "+17805550100", phoneDisplay: "(780) 555-0100" }),
    ];
    renderPage();

    // Cards render compact; the actions live behind a click.
    fireEvent.click(screen.getByTestId("button-toggle-lead-5"));
    expect(screen.getByTestId("button-create-booking-5")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("button-create-quote-5"));
    expect(navigateSpy).toHaveBeenCalledWith(
      "/bookings/new?leadId=5&intent=quote",
    );
  });

  it("is offered on dismissed leads too — dismissal isn't a dead end", () => {
    leadsFixture = [lead(6, { status: "dismissed" })];
    renderPage();

    fireEvent.click(screen.getByTestId("button-toggle-lead-6"));
    expect(screen.getByTestId("button-create-quote-6")).toBeInTheDocument();
  });

  it("disappears once the lead is converted", () => {
    leadsFixture = [lead(7, { status: "converted", convertedBookingId: 42 })];
    renderPage();

    fireEvent.click(screen.getByTestId("button-toggle-lead-7"));
    expect(
      screen.queryByTestId("button-create-quote-7"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("button-create-booking-7"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("View booking")).toBeInTheDocument();
  });
});

describe("missing-contact badges on the lead card", () => {
  it("shows badge-no-phone when phoneE164 is null (card expanded)", () => {
    leadsFixture = [lead(20, { phoneDisplay: "", phoneE164: null })];
    renderPage();
    fireEvent.click(screen.getByTestId("button-toggle-lead-20"));
    expect(screen.getByTestId("badge-no-phone-20")).toBeInTheDocument();
  });

  it("shows badge-no-email when email is null (card expanded)", () => {
    leadsFixture = [lead(21, { email: null })];
    renderPage();
    fireEvent.click(screen.getByTestId("button-toggle-lead-21"));
    expect(screen.getByTestId("badge-no-email-21")).toBeInTheDocument();
  });

  it("shows neither badge when both phone and email are present", () => {
    leadsFixture = [
      lead(22, {
        phoneE164: "+17805550100",
        phoneDisplay: "(780) 555-0100",
        email: "test@example.com",
      }),
    ];
    renderPage();
    fireEvent.click(screen.getByTestId("button-toggle-lead-22"));
    expect(screen.queryByTestId("badge-no-phone-22")).not.toBeInTheDocument();
    expect(screen.queryByTestId("badge-no-email-22")).not.toBeInTheDocument();
  });

  it("does NOT navigate when Create quote is clicked on a phoneless lead — shows nudge instead", () => {
    leadsFixture = [lead(23, { phoneDisplay: "", phoneE164: null })];
    renderPage();
    fireEvent.click(screen.getByTestId("button-toggle-lead-23"));
    fireEvent.click(screen.getByTestId("button-create-quote-23"));
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId("nudge-quote-phone-23")).toBeInTheDocument();
  });

  it("keeps repaired contact details when starting a quote", () => {
    const original = lead(24, { phoneDisplay: "", phoneE164: null });
    const repaired = {
      ...original,
      phoneDisplay: "(780) 555-0124",
      phoneE164: "+17805550124",
      email: "repaired@example.com",
    };
    leadsFixture = [original];
    contactMutateSpy.mockImplementation(
      (
        _variables: unknown,
        options: { onSuccess: (updated: typeof repaired) => void },
      ) => options.onSuccess(repaired),
    );
    const client = renderPage();

    fireEvent.click(screen.getByTestId("button-toggle-lead-24"));
    fireEvent.click(screen.getByTestId("badge-no-phone-24"));
    fireEvent.change(screen.getByTestId("edit-phone-input-24"), {
      target: { value: repaired.phoneDisplay },
    });
    fireEvent.click(screen.getByTestId("edit-phone-save-24"));

    // This is the query consumed by NewBookingPage after navigation. It must
    // contain the server's repaired row, not the pre-repair list snapshot.
    expect(client.getQueryData(["lead-prefill", 24])).toEqual(repaired);

    fireEvent.click(screen.getByTestId("button-create-quote-24"));
    expect(navigateSpy).toHaveBeenCalledWith(
      "/bookings/new?leadId=24&intent=quote",
    );
    expect(
      screen.queryByTestId("nudge-quote-phone-24"),
    ).not.toBeInTheDocument();
  });
});

describe("compact lead cards", () => {
  it("starts collapsed with a one-line summary, and opens on click", () => {
    leadsFixture = [
      lead(8, { phoneDisplay: "780-555-0100", streetAddress: "1 First St" }),
    ];
    renderPage();

    // Collapsed: summary visible, details and actions hidden.
    expect(screen.getByTestId("text-lead-summary-8")).toBeInTheDocument();
    expect(
      screen.queryByTestId("button-create-booking-8"),
    ).not.toBeInTheDocument();

    // Open: full details and actions appear, summary line goes away.
    fireEvent.click(screen.getByTestId("button-toggle-lead-8"));
    expect(screen.getByTestId("button-create-booking-8")).toBeInTheDocument();
    expect(screen.queryByTestId("text-lead-summary-8")).not.toBeInTheDocument();

    // Click again: back to compact.
    fireEvent.click(screen.getByTestId("button-toggle-lead-8"));
    expect(
      screen.queryByTestId("button-create-booking-8"),
    ).not.toBeInTheDocument();
  });

  it("shows hint-no-phone while collapsed when phoneE164 is null", () => {
    leadsFixture = [lead(30, { phoneDisplay: "", phoneE164: null })];
    renderPage();

    // Card is collapsed by default — hint must be visible without expanding.
    expect(screen.getByTestId("hint-no-phone-30")).toBeInTheDocument();
  });

  it("does NOT show hint-no-phone while collapsed when phoneE164 is present", () => {
    leadsFixture = [
      lead(31, { phoneE164: "+17805550100", phoneDisplay: "(780) 555-0100" }),
    ];
    renderPage();

    expect(screen.queryByTestId("hint-no-phone-31")).not.toBeInTheDocument();
  });

  it("still warns about a failed Jobber push while collapsed", () => {
    // The push failure is actionable; it must be visible on the compact
    // row, with the full reason and retry behind the click.
    leadsFixture = [
      lead(9, {
        source: "form",
        sourceTab: null,
        jobberSynced: false,
        jobberPushError: "Jobber rejected the client email",
      }),
    ];
    renderPage();

    expect(screen.getByTestId("hint-jobber-error-9")).toBeInTheDocument();
    expect(screen.queryByTestId("lead-jobber-error-9")).not.toBeInTheDocument();

    // Expanded: the hint yields to the full banner and the retry button.
    fireEvent.click(screen.getByTestId("button-toggle-lead-9"));
    expect(screen.queryByTestId("hint-jobber-error-9")).not.toBeInTheDocument();
    expect(screen.getByTestId("lead-jobber-error-9")).toBeInTheDocument();
    expect(screen.getByTestId("button-retry-jobber-9")).toBeInTheDocument();
  });

  it("does NOT show hint-jobber-error when jobberSynced is true, even if jobberPushError is set", () => {
    // Once the push succeeds (jobberSynced=true) the error hint must disappear
    // even if a stale jobberPushError value is still present on the row.
    leadsFixture = [
      lead(40, {
        source: "form",
        sourceTab: null,
        jobberSynced: true,
        jobberPushError: "Jobber rejected the client email",
      }),
    ];
    renderPage();

    expect(
      screen.queryByTestId("hint-jobber-error-40"),
    ).not.toBeInTheDocument();
  });

  it("does NOT show hint-jobber-error for a sheet-sourced lead with a push error", () => {
    // Only form leads are pushed to Jobber; sheet leads must never show the
    // Jobber error hint regardless of what jobberPushError contains.
    leadsFixture = [
      lead(41, {
        source: "sheet",
        jobberSynced: false,
        jobberPushError: "Jobber rejected the client email",
      }),
    ];
    renderPage();

    expect(
      screen.queryByTestId("hint-jobber-error-41"),
    ).not.toBeInTheDocument();
  });
});

describe("quick verdict tags", () => {
  it("shows the tag chip on the collapsed card", () => {
    leadsFixture = [lead(20, { tag: "spam" })];
    renderPage();
    // Not expanded — the chip must be scannable from the list.
    expect(screen.getByTestId("chip-tag-lead-20")).toHaveTextContent("Spam");
  });

  it("no chip when the lead is untagged", () => {
    leadsFixture = [lead(21)];
    renderPage();
    expect(screen.queryByTestId("chip-tag-lead-21")).not.toBeInTheDocument();
  });

  it("tapping a tag in the expanded card saves it", () => {
    leadsFixture = [lead(22)];
    renderPage();
    fireEvent.click(screen.getByTestId("button-toggle-lead-22"));
    fireEvent.click(screen.getByTestId("button-tag-lead-22-spam"));
    expect(tagMutateSpy).toHaveBeenCalledWith(
      { id: 22, data: { tag: "spam" } },
      expect.anything(),
    );
  });

  it("tapping the active tag clears it", () => {
    leadsFixture = [lead(23, { tag: "client" })];
    renderPage();
    fireEvent.click(screen.getByTestId("button-toggle-lead-23"));
    const active = screen.getByTestId("button-tag-lead-23-client");
    expect(active).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(active);
    expect(tagMutateSpy).toHaveBeenCalledWith(
      { id: 23, data: { tag: null } },
      expect.anything(),
    );
  });
});
