// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const resendMutate = vi.fn();
const toast = vi.fn();

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useGetRecentActivity: () => ({
    data: [
      {
        id: 81,
        type: "text_given_up",
        message:
          'Gave up on a "join request approved" text to +15551112222 after 3 days.',
        occurredAt: "2026-08-30T18:00:00.000Z",
        canResendText: true,
        resendPhone: "+15551112222",
        resendSourceLabel: "team member",
      },
    ],
    isLoading: false,
  }),
  getGetRecentActivityQueryKey: () => ["/api/dashboard/activity"],
  useResendGivenUpText: () => ({
    mutate: resendMutate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast }),
}));

import { DroppedTextsCard } from "./dashboard";

function renderCard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DroppedTextsCard />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  resendMutate.mockReset();
  toast.mockReset();
  cleanup();
});

describe("dropped-text resend", () => {
  it("shows the original target, validates it, and submits a corrected E.164 number", () => {
    renderCard();

    fireEvent.click(
      screen.getByRole("button", { name: "Check number & resend" }),
    );
    const input = screen.getByLabelText("Send this text to");
    expect(input).toHaveValue("+15551112222");
    expect(
      screen.getByText(
        "Save this corrected number to the team member so future texts use it",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", {
        name: "Save this number to the team member",
      }),
    ).toBeChecked();

    fireEvent.change(input, { target: { value: "(555) 333-4444" } });
    fireEvent.click(screen.getByRole("button", { name: "Resend text" }));
    expect(
      screen.getByText("Enter a valid E.164 number, such as +15551234567."),
    ).toBeInTheDocument();
    expect(resendMutate).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "+15553334444" } });
    fireEvent.click(screen.getByRole("button", { name: "Resend text" }));

    expect(resendMutate).toHaveBeenCalledWith(
      {
        id: 81,
        data: { toPhone: "+15553334444", saveToSource: true },
      },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it("distinguishes a saved number from a deleted original record", async () => {
    renderCard();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Check number & resend" }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Check number & resend" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Resend text" }));

    const options = resendMutate.mock.calls[0]?.[1];
    options.onSuccess({ queued: true, sourceUpdated: true });
    expect(toast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: "Text queued and number saved",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Check number & resend" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Resend text" }));
    resendMutate.mock.calls[1]?.[1].onSuccess({
      queued: true,
      sourceUpdated: false,
    });
    expect(toast).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: "Text queued, original record no longer exists",
      }),
    );
  });
});
