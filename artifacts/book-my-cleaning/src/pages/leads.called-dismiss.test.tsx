// @vitest-environment jsdom
/**
 * The "they called" badge + quick dismiss on the leads page.
 *
 * The badge renders only when the SERVER says hasCalled — never computed
 * client-side — on the collapsed card, the expanded card, the table row,
 * and the map's selected-lead card. The expanded card adds how fresh the
 * most recent call was. Quick dismiss gives every New lead a one-tap
 * discard without expanding anything: an X in the collapsed card header
 * and one on each table row, both firing the same dismiss mutation.
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
    phoneDisplay: "(587) 555-0100",
    phoneE164: "+15875550100",
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
    hasCalled: false,
    lastCallAt: null,
    ...over,
  };
}

/** A lead the company has really been on the phone with. */
function calledLead(id: number, over: Record<string, unknown> = {}) {
  return lead(id, {
    hasCalled: true,
    lastCallAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    lat: 53.5,
    lng: -113.5,
    ...over,
  });
}

let leadsFixture: ReturnType<typeof lead>[] = [];
const navigateSpy = vi.hoisted(() => vi.fn());
const dismissMutate = vi.hoisted(() => vi.fn());
const bulkDismissMutate = vi.hoisted(() => vi.fn());
const toastSpy = vi.hoisted(() => vi.fn());
let mapConfigFixture: Record<string, unknown> = { configured: false };

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
  useGetMapConfig: () => query(mapConfigFixture),
  useSyncLeads: mutation,
  useDismissLead: () => ({ mutate: dismissMutate, isPending: false }),
  useBulkDismissLeads: () => ({
    mutate: bulkDismissMutate,
    isPending: false,
  }),
  useSyncLeadToJobber: mutation,
  useUpdateLeadContact: mutation,
  useUpdateLeadTag: mutation,
  getListLeadsQueryKey: () => ["/api/leads"],
  getGetLeadSyncStatusQueryKey: () => ["/api/leads/sync-status"],
  getGetDashboardSummaryQueryKey: () => ["/api/dashboard"],
}));

vi.mock("@/components/layout/AppLayout", () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
// The map itself is Google's; what matters here is that picking a pin
// renders the full lead card underneath — badge included.
vi.mock("@/components/LeadsMap", () => ({
  LeadsMap: ({ onSelectLead }: { onSelectLead: (id: number) => void }) => (
    <button data-testid="fake-pin" onClick={() => onSelectLead(31)}>
      pin
    </button>
  ),
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

import { LeadsPage } from "./leads";

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <LeadsPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  leadsFixture = [];
  mapConfigFixture = { configured: false };
  navigateSpy.mockReset();
  dismissMutate.mockReset();
  bulkDismissMutate.mockReset();
  toastSpy.mockReset();
  localStorage.clear();
});

describe("the Called badge", () => {
  it("shows on the collapsed card only for leads the server flagged", () => {
    leadsFixture = [calledLead(1), lead(2)];
    renderPage();
    expect(screen.getByTestId("badge-called-1")).toHaveTextContent("Called");
    expect(screen.queryByTestId("badge-called-2")).not.toBeInTheDocument();
  });

  it("keeps the badge and adds recency when the card is expanded", () => {
    leadsFixture = [calledLead(3)];
    renderPage();
    fireEvent.click(screen.getByTestId("button-toggle-lead-3"));
    expect(screen.getByTestId("badge-called-3")).toBeInTheDocument();
    expect(screen.getByTestId("text-last-call-3")).toHaveTextContent(
      /Called.*2 days ago/,
    );
  });

  it("shows no recency line for an expanded lead nobody has called", () => {
    leadsFixture = [lead(4)];
    renderPage();
    fireEvent.click(screen.getByTestId("button-toggle-lead-4"));
    expect(screen.queryByTestId("text-last-call-4")).not.toBeInTheDocument();
  });

  it("shows in the table row only for flagged leads", () => {
    leadsFixture = [calledLead(11), lead(12)];
    renderPage();
    fireEvent.click(screen.getByTestId("view-table"));
    expect(screen.getByTestId("badge-called-11")).toBeInTheDocument();
    expect(screen.queryByTestId("badge-called-12")).not.toBeInTheDocument();
  });

  it("shows on the map's selected-lead card", () => {
    leadsFixture = [calledLead(31)];
    mapConfigFixture = { configured: true, apiKey: "test-key" };
    renderPage();
    fireEvent.click(screen.getByTestId("view-map"));
    fireEvent.click(screen.getByTestId("fake-pin"));
    expect(screen.getByTestId("badge-called-31")).toBeInTheDocument();
  });
});

describe("quick dismiss", () => {
  it("dismisses a New lead straight from the collapsed card without expanding", () => {
    leadsFixture = [lead(21)];
    renderPage();
    fireEvent.click(screen.getByTestId("button-quick-dismiss-21"));
    expect(dismissMutate).toHaveBeenCalledWith({ id: 21 }, expect.any(Object));
    // Clicking the X must not have toggled the card open.
    expect(screen.queryByTestId("button-dismiss-21")).not.toBeInTheDocument();
  });

  it("offers quick dismiss on converted leads, but not archived leads", () => {
    leadsFixture = [
      lead(22, { status: "converted", convertedBookingId: 7 }),
      lead(23, { status: "dismissed" }),
    ];
    renderPage();
    expect(screen.getByTestId("button-quick-dismiss-22")).toBeInTheDocument();
    expect(
      screen.queryByTestId("button-quick-dismiss-23"),
    ).not.toBeInTheDocument();
  });

  it("dismisses a New lead from its table row", () => {
    leadsFixture = [lead(24), lead(25, { status: "converted" })];
    renderPage();
    fireEvent.click(screen.getByTestId("view-table"));
    expect(screen.getByTestId("table-dismiss-25")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("table-dismiss-24"));
    expect(dismissMutate).toHaveBeenCalledWith({ id: 24 }, expect.any(Object));
  });
});

describe("card bulk dismiss", () => {
  it("selects only New cards and sends their ids through the shared bulk endpoint", () => {
    leadsFixture = [
      lead(41),
      lead(42, { status: "converted", convertedBookingId: 3 }),
      lead(43),
    ];
    renderPage();

    fireEvent.click(screen.getByTestId("card-select-toggle"));
    expect(screen.getByTestId("card-select-lead-41")).toBeInTheDocument();
    expect(screen.queryByTestId("card-select-lead-42")).not.toBeInTheDocument();
    expect(screen.getByTestId("card-select-lead-43")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("card-select-lead-41"));
    fireEvent.click(screen.getByTestId("card-select-lead-43"));
    expect(screen.getByTestId("card-bulk-dismiss-bar")).toHaveTextContent(
      "Dismiss 2 selected",
    );

    fireEvent.click(screen.getByTestId("card-bulk-dismiss-btn"));
    fireEvent.click(screen.getByTestId("card-bulk-dismiss-confirm"));
    expect(bulkDismissMutate).toHaveBeenCalledWith(
      { data: { ids: [41, 43] } },
      expect.any(Object),
    );
  });

  it("uses the destructive table-style toast when the bulk request fails", () => {
    leadsFixture = [lead(44)];
    renderPage();

    fireEvent.click(screen.getByTestId("card-select-toggle"));
    fireEvent.click(screen.getByTestId("card-select-lead-44"));
    fireEvent.click(screen.getByTestId("card-bulk-dismiss-btn"));
    fireEvent.click(screen.getByTestId("card-bulk-dismiss-confirm"));

    const options = bulkDismissMutate.mock.calls[0]?.[1] as {
      onError: () => void;
    };
    options.onError();
    expect(toastSpy).toHaveBeenCalledWith({
      title: "Couldn't dismiss those leads",
      description: "Some may already have been converted. Try again.",
      variant: "destructive",
    });
  });
});
