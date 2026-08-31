// @vitest-environment jsdom
/**
 * Calls list — "Take booking" calendar button visibility.
 *
 * The button appears:
 *   - always while the call is in_progress (entitled users)
 *   - for completed/missed calls that ended within the recent window
 *     AND have not been converted to a booking (status !== "booked")
 *
 * It is hidden for:
 *   - calls that are already booked
 *   - calls that ended more than RECENT_CALL_WINDOW_MS ago
 *   - users who cannot take live calls (canTakeLiveCalls === false)
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

// --- Expo / native stubs ------------------------------------------------------

vi.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("@/components/Brand", () => ({
  BrandHeaderTitle: () => null,
}));

vi.mock("@/components/StateViews", () => ({
  LoadingView: () => null,
  ErrorView: () => null,
  EmptyView: () => null,
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

// --- Mutable hook fixtures ----------------------------------------------------

const hooks = vi.hoisted(() => ({
  me: { data: { canTakeLiveCalls: true } as unknown },
  company: { data: { recentCallWindowMinutes: 30 } as unknown },
  calls: {
    data: [] as unknown[],
    isLoading: false,
    isError: false,
    isRefetching: false,
    refetch: vi.fn(),
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useListCalls: () => hooks.calls,
  useGetCurrentUser: () => hooks.me,
  useGetCompany: () => hooks.company,
}));

import CallsScreen from "@/app/calls";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Call fixture with defaults that can be overridden. */
function makeCall(overrides: {
  id?: number;
  status: string;
  /** Seconds since the call ENDED (positive = in the past). Defaults to 5 min. */
  endedSecondsAgo?: number;
  durationSeconds?: number;
}) {
  const dur = overrides.durationSeconds ?? 120;
  const endedAgo = overrides.endedSecondsAgo ?? 5 * 60;
  // startedAt = now - durationSeconds - endedSecondsAgo
  const startedAt = new Date(
    Date.now() - dur * 1000 - endedAgo * 1000,
  ).toISOString();
  return {
    id: overrides.id ?? 1,
    status: overrides.status,
    callerName: "Test Caller",
    callerPhone: "+17805551234",
    startedAt,
    durationSeconds: dur,
    isTest: false,
  };
}

// ---------------------------------------------------------------------------

beforeEach(() => {
  hooks.me.data = { canTakeLiveCalls: true };
  hooks.company.data = { recentCallWindowMinutes: 30 };
  hooks.calls.data = [];
  hooks.calls.isLoading = false;
  hooks.calls.isError = false;
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------

describe("in_progress call", () => {
  it("shows the take-booking button for an entitled user", () => {
    hooks.calls.data = [
      makeCall({ status: "in_progress", endedSecondsAgo: 0 }),
    ];
    const { getByTestId } = render(<CallsScreen />);
    getByTestId("take-booking-1");
  });

  it("hides the button when the user cannot take live calls", () => {
    hooks.me.data = { canTakeLiveCalls: false };
    hooks.calls.data = [
      makeCall({ status: "in_progress", endedSecondsAgo: 0 }),
    ];
    const { queryByTestId } = render(<CallsScreen />);
    expect(queryByTestId("take-booking-1")).toBeNull();
  });
});

describe("recently completed call (within 30-min window)", () => {
  it("shows the button for a completed call that ended 1 min ago", () => {
    hooks.calls.data = [
      makeCall({ status: "completed", endedSecondsAgo: 1 * 60 }),
    ];
    const { getByTestId } = render(<CallsScreen />);
    getByTestId("take-booking-1");
  });

  it("shows the button for a completed call that ended 10 min ago", () => {
    hooks.calls.data = [
      makeCall({ status: "completed", endedSecondsAgo: 10 * 60 }),
    ];
    const { getByTestId } = render(<CallsScreen />);
    getByTestId("take-booking-1");
  });

  it("shows the button for a missed call that ended 5 min ago", () => {
    hooks.calls.data = [
      makeCall({ status: "missed", endedSecondsAgo: 5 * 60 }),
    ];
    const { getByTestId } = render(<CallsScreen />);
    getByTestId("take-booking-1");
  });

  it("hides the button when the user cannot take live calls", () => {
    hooks.me.data = { canTakeLiveCalls: false };
    hooks.calls.data = [
      makeCall({ status: "completed", endedSecondsAgo: 5 * 60 }),
    ];
    const { queryByTestId } = render(<CallsScreen />);
    expect(queryByTestId("take-booking-1")).toBeNull();
  });
});

describe("old completed call (outside 30-min window)", () => {
  it("hides the button for a completed call that ended 31 min ago", () => {
    hooks.calls.data = [
      makeCall({ status: "completed", endedSecondsAgo: 31 * 60 }),
    ];
    const { queryByTestId } = render(<CallsScreen />);
    expect(queryByTestId("take-booking-1")).toBeNull();
  });

  it("hides the button for a missed call that ended 2 hours ago", () => {
    hooks.calls.data = [
      makeCall({ status: "missed", endedSecondsAgo: 2 * 60 * 60 }),
    ];
    const { queryByTestId } = render(<CallsScreen />);
    expect(queryByTestId("take-booking-1")).toBeNull();
  });
});

describe("company-configured window", () => {
  it("keeps the button on a 90-min-old call when the window is 120 min", () => {
    hooks.company.data = { recentCallWindowMinutes: 120 };
    hooks.calls.data = [
      makeCall({ status: "completed", endedSecondsAgo: 90 * 60 }),
    ];
    const { getByTestId } = render(<CallsScreen />);
    getByTestId("take-booking-1");
  });

  it("hides the button on a 12-min-old call when the window is 10 min", () => {
    hooks.company.data = { recentCallWindowMinutes: 10 };
    hooks.calls.data = [
      makeCall({ status: "completed", endedSecondsAgo: 12 * 60 }),
    ];
    const { queryByTestId } = render(<CallsScreen />);
    expect(queryByTestId("take-booking-1")).toBeNull();
  });

  it("falls back to the 30-min default while the company record loads", () => {
    hooks.company.data = undefined;
    hooks.calls.data = [
      makeCall({ status: "completed", endedSecondsAgo: 10 * 60 }),
      makeCall({ id: 2, status: "completed", endedSecondsAgo: 31 * 60 }),
    ];
    const { getByTestId, queryByTestId } = render(<CallsScreen />);
    getByTestId("take-booking-1");
    expect(queryByTestId("take-booking-2")).toBeNull();
  });
});

describe("already-booked call", () => {
  it("never shows the button for a booked call, even if it ended recently", () => {
    hooks.calls.data = [
      makeCall({ status: "booked", endedSecondsAgo: 1 * 60 }),
    ];
    const { queryByTestId } = render(<CallsScreen />);
    expect(queryByTestId("take-booking-1")).toBeNull();
  });
});
