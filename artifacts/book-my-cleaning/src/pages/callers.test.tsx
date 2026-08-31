// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { CallersPage } from "./callers";

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useListCallers: () => ({
      data: [
        {
          id: 1,
          phone: "5551234",
          phoneE164: "+15551234",
          bestName: "John Smith",
          firstCallAt: "2024-01-01",
          latestCallAt: "2024-01-02",
          callCount: 2,
          knownClient: true,
        },
      ],
      isLoading: false,
      isError: false,
    }),
    useListCallerCalls: () => ({
      data: [
        {
          id: 10,
          callerName: "John Smith",
          callerPhone: "5551234",
          startedAt: "2024-01-02",
          durationSeconds: 60,
          status: "completed",
        },
      ],
      isLoading: false,
    }),
  };
});
vi.mock("@/components/layout/AppLayout", () => ({
  AppLayout: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@/pages/calls", () => ({
  CallDetailModal: () => <div data-testid="call-detail-modal" />,
}));

describe("CallersPage", () => {
  it("renders list and opens caller history", async () => {
    render(<CallersPage />);
    expect(screen.getByText("John Smith")).toBeInTheDocument();

    // Open caller detail modal
    fireEvent.click(screen.getByTestId("row-caller-1"));
    await waitFor(() => {
      expect(screen.getByText("Call History")).toBeInTheDocument();
    });

    // Open call detail modal
    fireEvent.click(screen.getByTestId("row-caller-call-10"));
    await waitFor(() => {
      expect(screen.getByTestId("call-detail-modal")).toBeInTheDocument();
    });
  });
});
