// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

type FakeLead = {
  id: number;
  source: string;
  status: string;
};

let leads: FakeLead[] = [];
let currentLocation = "/dashboard";

vi.mock("@workspace/api-client-react", () => ({
  useGetCurrentUser: () => ({ data: { role: "owner" } }),
  useGetUnreadMessageCount: () => ({ data: { unread: 0 } }),
  getGetUnreadMessageCountQueryKey: () => ["/api/messages/unread"],
  useListStaffConversations: () => ({ data: [] }),
  getListStaffConversationsQueryKey: () => ["/api/staff-conversations"],
  useGetDashboardSummary: () => ({ data: { newLeads: 0 } }),
  getGetDashboardSummaryQueryKey: () => ["/api/dashboard-summary"],
  useListLeads: () => ({ data: leads }),
}));

vi.mock("@clerk/react", () => ({
  useClerk: () => ({ signOut: vi.fn() }),
}));

vi.mock("wouter", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
  useLocation: () => [currentLocation, vi.fn()] as const,
}));

vi.mock("@/components/GlobalSearch", () => ({ GlobalSearch: () => null }));

import { Sidebar } from "./sidebar";

const company = (id: number) =>
  ({
    id,
    name: `Company ${id}`,
    isLive: true,
    setupStatus: { completedSteps: 1, totalSteps: 1 },
  }) as never;

function renderSidebar(companyId = 12) {
  return render(<Sidebar company={company(companyId)} />);
}

function websiteBadge() {
  return screen.queryByTestId("badge-new-website-leads");
}

beforeEach(() => {
  window.localStorage.clear();
  leads = [];
  currentLocation = "/dashboard";
});

afterEach(() => {
  cleanup();
});

describe("website lead sidebar alerts", () => {
  it("groups Calls beneath Leads and keeps client billing pages together", () => {
    renderSidebar();

    expect(screen.getByText("Leads").closest("a")).toHaveAttribute(
      "href",
      "/leads",
    );
    expect(screen.getByText("Calls").closest("a")).toHaveAttribute(
      "href",
      "/calls",
    );
    expect(screen.getByText("Calls").closest(".ml-4")).toBeInTheDocument();

    expect(screen.getByText("Callers").closest("a")).toHaveAttribute(
      "href",
      "/callers",
    );
    expect(screen.getByText("Callers").closest(".ml-4")).toBeInTheDocument();

    expect(screen.getByText("Clients & Billing")).toBeInTheDocument();
    expect(screen.getByText("Clients").closest("a")).toHaveAttribute(
      "href",
      "/clients",
    );
    expect(screen.getByText("Quotes").closest("a")).toHaveAttribute(
      "href",
      "/quotes",
    );
    expect(screen.getByText("Invoices").closest("a")).toHaveAttribute(
      "href",
      "/invoices",
    );
  });

  it("does not badge website leads already present on the first load", () => {
    leads = [
      { id: 101, source: "form", status: "new" },
      { id: 102, source: "form", status: "new" },
    ];

    renderSidebar();

    expect(websiteBadge()).not.toBeInTheDocument();
  });

  it("badges a website lead returned after the initial list", () => {
    leads = [{ id: 101, source: "form", status: "new" }];
    const view = renderSidebar();
    expect(websiteBadge()).not.toBeInTheDocument();

    leads = [
      { id: 101, source: "form", status: "new" },
      { id: 102, source: "form", status: "new" },
    ];
    view.rerender(<Sidebar company={company(12)} />);

    expect(websiteBadge()).toHaveTextContent("1");
  });

  it("keeps acknowledgements after remounting and isolates account changes", () => {
    leads = [{ id: 101, source: "form", status: "new" }];
    const first = renderSidebar(12);
    first.unmount();

    // This is a fresh mount after a browser refresh: the old lead stays quiet.
    renderSidebar(12);
    expect(websiteBadge()).not.toBeInTheDocument();

    // A different account gets its own baseline, even when ids overlap.
    const other = renderSidebar(34);
    expect(websiteBadge()).not.toBeInTheDocument();
    leads = [
      { id: 101, source: "form", status: "new" },
      { id: 202, source: "form", status: "new" },
    ];
    other.rerender(<Sidebar company={company(34)} />);

    expect(websiteBadge()).toHaveTextContent("1");
  });

  it("refreshes when another tab acknowledges this company's website leads", () => {
    leads = [{ id: 101, source: "form", status: "new" }];
    const view = renderSidebar(12);

    leads = [
      { id: 101, source: "form", status: "new" },
      { id: 102, source: "form", status: "new" },
    ];
    view.rerender(<Sidebar company={company(12)} />);
    expect(websiteBadge()).toHaveTextContent("1");

    act(() => {
      window.localStorage.setItem(
        "website-lead-alert-ack:12",
        JSON.stringify([101, 102]),
      );
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "website-lead-alert-ack:12",
          newValue: JSON.stringify([101, 102]),
        }),
      );
    });

    expect(websiteBadge()).not.toBeInTheDocument();
  });

  it("ignores acknowledgement storage events for another company", () => {
    leads = [{ id: 101, source: "form", status: "new" }];
    const view = renderSidebar(12);

    leads = [
      { id: 101, source: "form", status: "new" },
      { id: 102, source: "form", status: "new" },
    ];
    view.rerender(<Sidebar company={company(12)} />);
    expect(websiteBadge()).toHaveTextContent("1");

    act(() => {
      window.localStorage.setItem(
        "website-lead-alert-ack:34",
        JSON.stringify([101, 102]),
      );
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "website-lead-alert-ack:34",
          newValue: JSON.stringify([101, 102]),
        }),
      );
    });

    expect(websiteBadge()).toHaveTextContent("1");
  });
});
