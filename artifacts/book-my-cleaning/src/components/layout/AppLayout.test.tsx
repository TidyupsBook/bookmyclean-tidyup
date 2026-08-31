// @vitest-environment jsdom
/**
 * When the company load fails, AppLayout shows an error screen. A paused
 * production database makes *every* query fail — so without the health
 * probe the owner would only ever see the generic "connection dropped"
 * copy. These tests pin the copy switch: paused → name the database and
 * the fix; anything else → the generic message. And once the database is
 * healthy again the paused copy must disappear.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

type HealthData = { status: string; database: string } | undefined;
let healthData: HealthData;

type CompanyState = {
  data?: unknown;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
};
let companyState: CompanyState;

vi.mock("@workspace/api-client-react", () => ({
  useHealthCheck: () => ({ data: healthData }),
  getHealthCheckQueryKey: () => ["/api/healthz"],
  useGetCompany: () => companyState,
  // The live-call banner asks who's signed in — it only shows for the owner.
  useGetCurrentUser: () => ({
    data: { role: "owner", canTakeLiveCalls: true },
  }),
  // The Live booking launcher reads the call list the app-wide watcher polls.
  useListCalls: () => ({ data: [] }),
  getListCallsQueryKey: () => ["/api/calls"],
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/"] as const,
  Redirect: ({ to }: { to: string }) => <div data-testid={`redirect-${to}`} />,
}));

vi.mock("./sidebar", () => ({
  Sidebar: () => <div data-testid="sidebar" />,
}));

vi.mock("@/components/LiveCallAlert", () => ({
  LiveCallAlert: () => null,
}));

// Ambient watchers, both tested on their own; here they'd only drag their
// polling queries into a test about which error copy shows.
vi.mock("@/components/NewMessageChime", () => ({
  NewMessageChime: () => null,
}));
vi.mock("@/components/DeviceLocationReporter", () => ({
  DeviceLocationReporter: () => null,
}));
vi.mock("@/components/LocationPermissionAsk", () => ({
  LocationPermissionAsk: () => null,
}));
vi.mock("@/components/CallAlertsAsk", () => ({
  CallAlertsAsk: () => null,
}));

import { AppLayout } from "./AppLayout";

const serverError = { status: 500 };

function renderLayout() {
  return render(
    <AppLayout>
      <div data-testid="page-content" />
    </AppLayout>,
  );
}

afterEach(() => {
  cleanup();
  healthData = undefined;
});

describe("AppLayout error branch copy", () => {
  it("names the paused database when health reports paused", () => {
    companyState = {
      isLoading: false,
      error: serverError,
      refetch: vi.fn(),
    };
    healthData = { status: "ok", database: "paused" };

    renderLayout();
    expect(
      screen.getByText("Your production database is paused"),
    ).toBeInTheDocument();
    expect(screen.getByText(/unpause \(enable\) the database/i)).toBeVisible();
    expect(
      screen.queryByText("We couldn't load your workspace"),
    ).not.toBeInTheDocument();
    // Retry stays available either way.
    expect(screen.getByTestId("button-retry-load")).toBeInTheDocument();
  });

  it("shows the generic copy for a plain server failure", () => {
    companyState = {
      isLoading: false,
      error: serverError,
      refetch: vi.fn(),
    };
    healthData = { status: "ok", database: "error" };

    renderLayout();
    expect(
      screen.getByText("We couldn't load your workspace"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Your production database is paused"),
    ).not.toBeInTheDocument();
  });

  it("drops the paused copy once health reports ok again", () => {
    companyState = {
      isLoading: false,
      error: serverError,
      refetch: vi.fn(),
    };
    healthData = { status: "ok", database: "paused" };

    const { rerender } = renderLayout();
    expect(
      screen.getByText("Your production database is paused"),
    ).toBeInTheDocument();

    healthData = { status: "ok", database: "ok" };
    rerender(
      <AppLayout>
        <div data-testid="page-content" />
      </AppLayout>,
    );
    expect(
      screen.queryByText("Your production database is paused"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("We couldn't load your workspace"),
    ).toBeInTheDocument();
  });

  it("renders the app once the company loads", () => {
    companyState = {
      data: { setupStatus: { accountCreated: true } },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    };
    healthData = { status: "ok", database: "ok" };

    renderLayout();
    expect(screen.getByTestId("page-content")).toBeInTheDocument();
    expect(
      screen.queryByText("Your production database is paused"),
    ).not.toBeInTheDocument();
  });
});
