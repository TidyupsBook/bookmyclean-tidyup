// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { SavedRoutesPanel } from "./SavedRoutesPanel";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as apiClient from "@workspace/api-client-react";

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useListSavedRoutes: vi.fn(),
    useCreateSavedRoute: vi.fn(),
    useUpdateSavedRoute: vi.fn(),
    useDeleteSavedRoute: vi.fn(),
    useGetSavedRoute: vi.fn(),
    useAddSavedRouteStop: vi.fn(),
    useReorderSavedRouteStops: vi.fn(),
    useDeleteSavedRouteStop: vi.fn(),
  };
});

function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("SavedRoutesPanel Reassignment", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = createQueryClient();
    (apiClient.useListSavedRoutes as any).mockReturnValue({
      data: [{ id: 10, name: "Morning Route", teamMemberId: 1, stops: [] }],
    });
    (apiClient.useGetSavedRoute as any).mockImplementation((id: number) => {
      if (id === 10)
        return {
          data: { id: 10, name: "Morning Route", teamMemberId: 1, stops: [] },
        };
      return { data: null };
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("calls updateRoute when reassigning a route", async () => {
    const updateMutate = vi.fn((params, options) => {
      options.onSuccess();
    });
    (apiClient.useUpdateSavedRoute as any).mockReturnValue({
      mutate: updateMutate,
      isPending: false,
    });

    render(
      <QueryClientProvider client={queryClient}>
        <SavedRoutesPanel
          activeRouteId={10}
          onSelectRoute={vi.fn()}
          teamMembers={[
            { id: 1, name: "Alice" },
            { id: 2, name: "Bob" },
          ]}
          mapData={undefined}
          routeAddMode={false}
          onToggleRouteAddMode={vi.fn()}
        />
      </QueryClientProvider>,
    );

    const select = screen.getByRole("combobox", {
      name: /Reassign route/i,
    }) as HTMLSelectElement;
    expect(select.value).toBe("1"); // Alice

    fireEvent.change(select, { target: { value: "2" } }); // Change to Bob

    expect(updateMutate).toHaveBeenCalledWith(
      { id: 10, data: { teamMemberId: 2 } },
      expect.anything(),
    );
  });
});
