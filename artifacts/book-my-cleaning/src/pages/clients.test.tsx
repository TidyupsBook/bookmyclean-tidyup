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
import { ClientsPage } from "./clients";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const queryClient = new QueryClient();

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useListClients: () => ({
      data: [
        {
          id: 1,
          name: "Alice",
          phone: "5551111",
          email: "alice@test.com",
          source: "lead",
          createdAt: "2024-01-01",
        },
      ],
      isLoading: false,
    }),
    useCreateClient: () => ({ mutate: vi.fn(), isPending: false }),
    useUpdateClient: () => ({ mutate: vi.fn(), isPending: false }),
  };
});
vi.mock("@/components/layout/AppLayout", () => ({
  AppLayout: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@/components/CustomerTagControls", () => ({
  CustomerTagChip: () => null,
  CustomerTagPicker: () => null,
}));

describe("ClientsPage", () => {
  it("opens create and edit modals", async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <ClientsPage />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId("button-new-client"));
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "New Client" }),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Cancel"));

    fireEvent.click(screen.getByTestId("button-edit-client-1"));
    await waitFor(() => {
      expect(screen.getByDisplayValue("Alice")).toBeInTheDocument();
    });
  });
});
