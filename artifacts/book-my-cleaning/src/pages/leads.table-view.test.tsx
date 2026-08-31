// @vitest-environment jsdom
/**
 * The Table view of the leads page: a spreadsheet-style row per lead with
 * just the columns needed to size up a quote or booking. These pin the
 * List/Table toggle, that the table shows the quote-critical fields, that
 * each source keeps its colored chip, that a phoneless lead warns instead
 * of offering a quote, that narrow phone screens keep their source filters
 * contained, and that the chosen view survives a revisit.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";

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
let syncStatusFixture: unknown;
const navigateSpy = vi.hoisted(() => vi.fn());
const tagMutateSpy = vi.hoisted(() => vi.fn());

vi.mock("wouter", () => ({
  useLocation: () => ["/leads", navigateSpy],
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useListLeads: () => query(leadsFixture),
  useGetLeadSyncStatus: () => query(syncStatusFixture),
  useGetMapConfig: () => query({ configured: false }),
  useSyncLeads: mutation,
  useDismissLead: mutation,
  useSyncLeadToJobber: mutation,
  useUpdateLeadContact: mutation,
  useUpdateLeadTag: () => ({ mutate: tagMutateSpy, isPending: false }),
  getListLeadsQueryKey: () => ["/api/leads"],
  getGetLeadSyncStatusQueryKey: () => ["/api/leads/sync-status"],
  getGetDashboardSummaryQueryKey: () => ["/api/dashboard"],
}));

vi.mock("@/components/layout/AppLayout", () => ({
  AppLayout: ({
    children,
    wide,
  }: {
    children: React.ReactNode;
    wide?: boolean;
  }) => (
    <div data-testid="app-layout" data-layout-width={wide ? "wide" : "default"}>
      {children}
    </div>
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
  return render(
    <TooltipProvider>
      <QueryClientProvider client={client}>
        <LeadsPage />
      </QueryClientProvider>
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  leadsFixture = [];
  syncStatusFixture = undefined;
  navigateSpy.mockReset();
  tagMutateSpy.mockReset();
  localStorage.clear();
});

describe("the leads Table view", () => {
  it("shows neutral copy and hides sheet actions when the feed is not configured", () => {
    syncStatusFixture = {
      configured: false,
      lastSyncAt: null,
      lastSuccessAt: null,
      lastError: null,
      warning: null,
      tabStatuses: [],
      stale: false,
    };

    renderPage();

    expect(screen.getByTestId("banner-sync-unconfigured")).toHaveTextContent(
      "This company isn't connected to the shared Google Sheet lead feed.",
    );
    expect(screen.queryByTestId("banner-sync-stale")).not.toBeInTheDocument();
    expect(screen.queryByTestId("banner-sync-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("button-sync-leads")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("button-preview-lead-mappings"),
    ).not.toBeInTheDocument();
  });

  it("shows the failed map-pin address on both the card and table row", () => {
    leadsFixture = [
      lead(25, {
        streetAddress: "8211 Saskatchewn Dr NW",
        city: "Edmonton",
        province: "AB",
        postCode: "T6G 2A4",
        geocodingFailed: true,
      }),
    ];
    renderPage();

    const cardWarning = screen.getByTestId("warning-address-placement-lead-25");
    fireEvent.click(cardWarning);
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "8211 Saskatchewn Dr NW, Edmonton, AB, T6G 2A4",
    );

    fireEvent.click(screen.getByTestId("view-table"));
    expect(
      screen.getByTestId("warning-address-placement-lead-25"),
    ).toBeInTheDocument();
  });

  it("wraps intact source filters inside a narrow phone screen", () => {
    leadsFixture = [lead(0)];
    renderPage();

    const sourceFilters = screen.getByTestId("source-filters");
    // The group fills (but cannot exceed) a phone content area and returns to
    // its original fit-content pill shape at the desktop breakpoint.
    expect(sourceFilters).toHaveClass(
      "w-full",
      "max-w-full",
      "flex-wrap",
      "sm:w-fit",
    );

    for (const source of ["all", "form", "jobber", "sheet"]) {
      const control = screen.getByTestId(`source-filter-${source}`);
      expect(control).toHaveClass(
        "shrink-0",
        "whitespace-nowrap",
        "px-3",
        "sm:px-4",
      );
      control.focus();
      expect(control).toHaveFocus();
      fireEvent.click(control);
    }
    expect(screen.getByTestId("source-filter-sheet")).toHaveClass(
      "brand-gradient",
    );
  });

  it("has a Table option in the view toggle even without a Maps key", () => {
    leadsFixture = [lead(1)];
    renderPage();
    expect(screen.getByTestId("view-table")).toBeInTheDocument();
    expect(screen.getByTestId("view-list")).toBeInTheDocument();
    // Map stays hidden when the server has no key.
    expect(screen.queryByTestId("view-map")).not.toBeInTheDocument();
  });

  it("switches from cards to one row per lead with quote-critical columns", () => {
    leadsFixture = [
      lead(2, {
        phoneE164: "+17805550100",
        phoneDisplay: "(780) 555-0100",
        service: "Deep Clean",
        bedrooms: "3",
        bathrooms: "2",
        streetAddress: "8211 Saskatchewan Dr NW",
        city: "Edmonton",
        province: "AB",
        postCode: "T6G 2A4",
        dateOfServiceRequested: "this weekend?",
      }),
    ];
    renderPage();

    // Cards first (the default view).
    expect(screen.getByTestId("lead-card-2")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("view-table"));
    expect(screen.queryByTestId("lead-card-2")).not.toBeInTheDocument();
    const row = screen.getByTestId("lead-row-2");
    expect(row).toHaveTextContent("Lead 2");
    expect(row).toHaveTextContent("(780) 555-0100");
    expect(row).toHaveTextContent("Deep Clean · 3 bed · 2 bath");
    // Full address — postal code tells the desk it's in the service area.
    expect(row).toHaveTextContent(
      "8211 Saskatchewan Dr NW, Edmonton, AB, T6G 2A4",
    );
    expect(row).toHaveTextContent("this weekend?");
  });

  it("keeps each source's colored chip when the Source column is shown", async () => {
    leadsFixture = [
      lead(3), // sheet
      lead(4, { source: "form", sourceTab: null }),
      lead(5, { source: "jobber", sourceTab: null }),
    ];
    renderPage();
    fireEvent.click(screen.getByTestId("view-table"));
    screen.getByTestId("columns-menu").focus();
    fireEvent.keyDown(screen.getByTestId("columns-menu"), { key: "Enter" });
    fireEvent.click(await screen.findByTestId("column-toggle-source"));

    expect(screen.getByTestId("badge-sheet-3")).toHaveClass("text-sky-400");
    expect(screen.getByTestId("badge-form-4")).toHaveClass("text-brand-purple");
    expect(screen.getByTestId("badge-jobber-5")).toHaveClass(
      "text-emerald-400",
    );
  });

  it("offers Quote and Book on a lead with a phone, navigating like the card buttons", () => {
    leadsFixture = [
      lead(6, { phoneE164: "+17805550100", phoneDisplay: "(780) 555-0100" }),
    ];
    renderPage();
    fireEvent.click(screen.getByTestId("view-table"));

    fireEvent.click(screen.getByTestId("table-create-quote-6"));
    expect(navigateSpy).toHaveBeenCalledWith(
      "/bookings/new?leadId=6&intent=quote",
    );
    fireEvent.click(screen.getByTestId("table-create-booking-6"));
    expect(navigateSpy).toHaveBeenCalledWith("/bookings/new?leadId=6");
  });

  it("warns instead of offering a quote when the lead has no phone", () => {
    leadsFixture = [lead(7, { phoneDisplay: "", phoneE164: null })];
    renderPage();
    fireEvent.click(screen.getByTestId("view-table"));

    expect(screen.getByTestId("table-no-phone-7")).toBeInTheDocument();
    expect(
      screen.queryByTestId("table-create-quote-7"),
    ).not.toBeInTheDocument();
    // Booking is still possible — the desk can fill the number in there.
    expect(screen.getByTestId("table-create-booking-7")).toBeInTheDocument();
  });

  it("a converted lead's row links to its booking instead of offering buttons", () => {
    leadsFixture = [lead(8, { status: "converted", convertedBookingId: 42 })];
    renderPage();
    fireEvent.click(screen.getByTestId("view-table"));

    expect(screen.getByText("View booking")).toBeInTheDocument();
    expect(
      screen.queryByTestId("table-create-booking-8"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("table-create-quote-8"),
    ).not.toBeInTheDocument();
  });

  it("a converted lead with no booking id still offers no Quote/Book", () => {
    // API-valid edge case: converted, but convertedBookingId is null.
    // Quoting or booking again would create a duplicate.
    leadsFixture = [
      lead(10, {
        status: "converted",
        convertedBookingId: null,
        phoneE164: "+17805550100",
        phoneDisplay: "(780) 555-0100",
      }),
    ];
    renderPage();
    fireEvent.click(screen.getByTestId("view-table"));

    expect(
      screen.queryByTestId("table-create-booking-10"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("table-create-quote-10"),
    ).not.toBeInTheDocument();
  });

  it("offers every lead tag directly in the table actions, including converted leads", () => {
    leadsFixture = [lead(16, { status: "converted", convertedBookingId: 42 })];
    renderPage();
    fireEvent.click(screen.getByTestId("view-table"));

    for (const tag of ["client", "good_lead", "bad_lead", "spam"]) {
      expect(
        screen.getByTestId(`table-button-tag-lead-16-${tag}`),
      ).toBeInTheDocument();
    }

    fireEvent.click(screen.getByTestId("table-button-tag-lead-16-spam"));
    expect(tagMutateSpy).toHaveBeenCalledWith(
      { id: 16, data: { tag: "spam" } },
      expect.any(Object),
    );
  });

  it("remembers the Table choice for the next visit", () => {
    leadsFixture = [lead(9)];
    const first = renderPage();
    fireEvent.click(screen.getByTestId("view-table"));
    expect(screen.getByTestId("leads-table")).toBeInTheDocument();
    first.unmount();

    // A fresh mount (new visit) must come back in Table view.
    renderPage();
    expect(screen.getByTestId("leads-table")).toBeInTheDocument();
    expect(screen.queryByTestId("lead-card-9")).not.toBeInTheDocument();
  });

  it("uses the wider workspace only while Table view is active", () => {
    leadsFixture = [lead(11)];
    renderPage();

    expect(screen.getByTestId("app-layout")).toHaveAttribute(
      "data-layout-width",
      "default",
    );
    fireEvent.click(screen.getByTestId("view-table"));
    expect(screen.getByTestId("app-layout")).toHaveAttribute(
      "data-layout-width",
      "wide",
    );
    fireEvent.click(screen.getByTestId("view-list"));
    expect(screen.getByTestId("app-layout")).toHaveAttribute(
      "data-layout-width",
      "default",
    );
    expect(screen.getByTestId("lead-card-11")).toBeInTheDocument();
  });

  it("keeps table headers and row cells in the same visible-column order", () => {
    leadsFixture = [lead(12, { phoneDisplay: "780-555-0100" })];
    renderPage();
    fireEvent.click(screen.getByTestId("view-table"));

    const headers = Array.from(
      screen.getByTestId("leads-table").querySelectorAll("thead [data-column]"),
    ).map((cell) => cell.getAttribute("data-column"));
    const cells = Array.from(
      screen.getByTestId("lead-row-12").querySelectorAll("[data-column]"),
    ).map((cell) => cell.getAttribute("data-column"));
    expect(cells).toEqual(headers);
  });

  it("keeps the default visible columns within the 1000px desktop budget", () => {
    leadsFixture = [lead(120, { phoneDisplay: "780-555-0100" })];
    renderPage();
    fireEvent.click(screen.getByTestId("view-table"));

    expect(screen.getByTestId("leads-table-grid")).toHaveAttribute(
      "data-minimum-width",
      "998",
    );
    expect(screen.getByRole("columnheader", { name: "Service" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Address" })).toBeVisible();
    expect(
      screen.getByRole("columnheader", { name: "Requested" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("columnheader", { name: "Source" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: "Status" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: "Received" }),
    ).not.toBeInTheDocument();
  });

  it("saves hidden columns across visits and can reset the defaults", async () => {
    leadsFixture = [
      lead(13, {
        email: "lead@example.com",
        streetAddress: "123 Long Avenue",
      }),
    ];
    const first = renderPage();
    fireEvent.click(screen.getByTestId("view-table"));
    expect(screen.getByRole("columnheader", { name: "Address" })).toBeVisible();

    screen.getByTestId("columns-menu").focus();
    fireEvent.keyDown(screen.getByTestId("columns-menu"), { key: "Enter" });
    fireEvent.click(await screen.findByTestId("column-toggle-address"));
    expect(
      screen.queryByRole("columnheader", { name: "Address" }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        JSON.parse(localStorage.getItem("leads-table-columns-v2") ?? "[]"),
      ).not.toContain("address"),
    );

    first.unmount();
    renderPage();
    expect(screen.getByTestId("leads-table")).toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: "Address" }),
    ).not.toBeInTheDocument();

    screen.getByTestId("columns-menu").focus();
    fireEvent.keyDown(screen.getByTestId("columns-menu"), { key: "Enter" });
    fireEvent.click(await screen.findByTestId("columns-reset"));
    expect(screen.getByRole("columnheader", { name: "Address" })).toBeVisible();
    // Email is intentionally not part of the sensible default.
    expect(
      screen.queryByRole("columnheader", { name: "Email" }),
    ).not.toBeInTheDocument();
  });

  it("opens every long field in a keyboard-focusable details control", () => {
    leadsFixture = [
      lead(14, {
        service: "A detailed move-out clean including the inside of cabinets",
        streetAddress: "12345 A Very Long Residential Street Northwest",
        city: "Edmonton",
        province: "AB",
        postCode: "T5T 5T5",
        dateOfServiceRequested: "Any weekday after school pickup at 4:30",
        email: "lead@example.com",
        message: "Please call before arriving because the baby may be asleep.",
        campaignName: "West Edmonton families",
        heardAbout: "Neighbour referral",
      }),
    ];
    renderPage();
    fireEvent.click(screen.getByTestId("view-table"));

    const row = screen.getByTestId("lead-row-14");
    expect(row).toHaveTextContent(
      "A detailed move-out clean including the inside of cabinets",
    );
    expect(row).toHaveTextContent(
      "12345 A Very Long Residential Street Northwest",
    );
    expect(row).toHaveTextContent("Any weekday after school pickup at 4:30");
    const trigger = screen.getByTestId("table-details-toggle-14");
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    trigger.focus();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("lead-details-14")).toHaveTextContent(
      "Please call before arriving because the baby may be asleep.",
    );
    expect(screen.getByTestId("lead-details-14")).toHaveTextContent(
      "West Edmonton families",
    );
    expect(screen.getByTestId("lead-details-14")).toHaveTextContent(
      "Neighbour referral",
    );
    expect(screen.getByTestId("lead-details-14")).toHaveTextContent(
      "lead@example.com",
    );
  });

  it("labels the focusable horizontal scroll region and shows an overflow hint", async () => {
    leadsFixture = [lead(15)];
    renderPage();
    fireEvent.click(screen.getByTestId("view-table"));

    const region = screen.getByRole("region", {
      name: "Leads table with horizontal scrolling",
    });
    Object.defineProperty(region, "scrollWidth", {
      configurable: true,
      value: 1800,
    });
    Object.defineProperty(region, "clientWidth", {
      configurable: true,
      value: 900,
    });
    fireEvent(window, new Event("resize"));

    expect(region).toHaveAttribute("tabindex", "0");
    await waitFor(() =>
      expect(screen.getByTestId("leads-table-scroll-hint")).toHaveTextContent(
        "Scroll sideways to see more columns",
      ),
    );
    expect(region).toHaveAttribute("data-has-horizontal-overflow", "true");
  });

  it("keeps the actions column sticky and all verdict controls inside the scroll contract", () => {
    leadsFixture = [
      lead(17, {
        phoneE164: "+17805550100",
        phoneDisplay: "(780) 555-0100",
        email: "lead@example.com",
        service: "Deep clean",
        streetAddress: "123 Long Avenue",
        city: "Edmonton",
        province: "AB",
        postCode: "T5T 5T5",
      }),
    ];
    localStorage.setItem(
      "leads-table-columns-v2",
      JSON.stringify([
        "email",
        "service",
        "address",
        "requested",
        "source",
        "status",
        "received",
      ]),
    );
    renderPage();
    fireEvent.click(screen.getByTestId("view-table"));

    const region = screen.getByTestId("leads-table");
    const grid = screen.getByTestId("leads-table-grid");
    const actionHeader = region.querySelector('thead [data-column="actions"]');
    const actionCell = screen
      .getByTestId("lead-row-17")
      .querySelector('[data-column="actions"]');

    expect(region).toHaveAttribute(
      "aria-label",
      "Leads table with horizontal scrolling",
    );
    expect(region).toHaveAttribute("tabindex", "0");
    expect(grid).toHaveAttribute("data-minimum-width", "1488");
    expect(actionHeader).toHaveClass("sticky", "right-0", "min-w-[240px]");
    expect(actionCell).toHaveClass("sticky", "right-0", "min-w-[240px]");
    expect(
      screen.getByTestId("table-button-tag-lead-17-client"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("table-button-tag-lead-17-good_lead"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("table-button-tag-lead-17-bad_lead"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("table-button-tag-lead-17-spam"),
    ).toBeInTheDocument();
  });

  it("keeps the scroll region and Actions controls in the keyboard tab order", () => {
    leadsFixture = [
      lead(18, {
        phoneE164: "+17805550100",
        phoneDisplay: "(780) 555-0100",
      }),
    ];
    localStorage.setItem(
      "leads-table-columns-v2",
      JSON.stringify([
        "email",
        "service",
        "address",
        "requested",
        "source",
        "status",
        "received",
      ]),
    );
    renderPage();
    fireEvent.click(screen.getByTestId("view-table"));

    const region = screen.getByRole("region", {
      name: "Leads table with horizontal scrolling",
    });
    const actionCell = screen
      .getByTestId("lead-row-18")
      .querySelector('[data-column="actions"]');
    const verdictButtons = ["client", "good_lead", "bad_lead", "spam"].map(
      (tag) => screen.getByTestId(`table-button-tag-lead-18-${tag}`),
    );

    region.focus();
    expect(region).toHaveFocus();
    expect(region).toHaveAttribute("tabindex", "0");
    expect(actionCell).not.toBeNull();
    expect(
      Array.from(actionCell?.querySelectorAll("button") ?? []).every(
        (button) => button.tabIndex >= 0,
      ),
    ).toBe(true);
    expect(verdictButtons.every((button) => button.tagName === "BUTTON")).toBe(
      true,
    );
    expect(verdictButtons.every((button) => button.tabIndex >= 0)).toBe(true);
    expect(
      verdictButtons.every(
        (button) => button.getAttribute("type") === "button",
      ),
    ).toBe(true);
  });
});
