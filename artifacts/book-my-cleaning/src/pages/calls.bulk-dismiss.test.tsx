// @vitest-environment jsdom
/**
 * The Calls page bulk clear is only a local attention action. It must clear
 * the same shared New markers as the launcher without deleting or mutating
 * any call rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const initialCallsFixture = [
  {
    id: 41,
    callerName: "Caller 41",
    callerPhone: "+15550000041",
    status: "completed",
    startedAt: "2026-08-14T12:00:00Z",
    durationSeconds: 60,
    isTest: false,
    direction: "inbound",
  },
  {
    id: 42,
    callerName: "Caller 42",
    callerPhone: "+15550000042",
    status: "in_progress",
    startedAt: "2026-08-14T12:01:00Z",
    durationSeconds: 90,
    isTest: false,
    direction: "inbound",
  },
];

let callsFixture = initialCallsFixture;

const meFixture = {
  email: "owner@example.com",
  companyName: "Sparkle",
};

const toastMock = vi.hoisted(() => vi.fn());

vi.mock("@workspace/api-client-react", () => ({
  useListCalls: () => ({ data: callsFixture, isLoading: false }),
  useSimulateTestCall: () => ({ mutate: vi.fn(), isPending: false }),
  useGetCurrentUser: () => ({ data: meFixture }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

vi.mock("@/components/layout/AppLayout", () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/PhoneActions", () => ({
  PhoneActions: () => null,
}));

vi.mock("@/components/TagControls", () => ({
  TagChip: () => null,
  TagPicker: () => null,
}));

vi.mock("@/components/CustomerTagControls", () => ({
  CustomerTagPicker: () => null,
}));

import { CallsPage } from "./calls";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("bmc.callAttention.v1.owner@example.com@Sparkle", "[]");
  callsFixture = initialCallsFixture;
  toastMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("Calls page bulk clear", () => {
  it("updates from a refreshed call list before clearing every waiting call", () => {
    const view = render(<CallsPage />);

    // One call is already waiting; the second is still active and therefore
    // must not be included until the list refresh reports that it finished.
    expect(screen.getByTestId("badge-call-new-41")).toBeInTheDocument();
    expect(screen.queryByTestId("badge-call-new-42")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("button-calls-clear-all"),
    ).not.toBeInTheDocument();

    // Simulate the same query observer receiving a fresh response. This is a
    // status update, not a navigation or page reload.
    callsFixture = [
      ...initialCallsFixture.slice(0, 1),
      { ...initialCallsFixture[1], status: "completed" },
    ];
    view.rerender(<CallsPage />);

    expect(screen.getByTestId("button-calls-clear-all")).toHaveTextContent(
      "Clear waiting calls (2)",
    );
    expect(screen.getByTestId("badge-call-new-41")).toBeInTheDocument();
    expect(screen.getByTestId("badge-call-new-42")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("button-calls-clear-all"));

    expect(
      screen.queryByTestId("button-calls-clear-all"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("badge-call-new-41")).not.toBeInTheDocument();
    expect(screen.queryByTestId("badge-call-new-42")).not.toBeInTheDocument();
    expect(screen.getByText("Caller 41")).toBeInTheDocument();
    expect(screen.getByText("Caller 42")).toBeInTheDocument();
    expect(callsFixture).toHaveLength(2);
    expect(callsFixture.map((call) => call.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(toastMock).toHaveBeenCalledWith({
      title: "Waiting calls cleared",
      description: "2 calls cleared. Your call records are unchanged.",
    });
  });
});
