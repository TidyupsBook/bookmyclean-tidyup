// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  within,
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

function renderPanel(
  activeRouteId: number | null,
  onSelectRoute = vi.fn(),
  routeAddMode = false,
  onToggleRouteAddMode = vi.fn(),
) {
  const queryClient = createQueryClient();
  const teamMembers = [
    { id: 1, name: "Alice" },
    { id: 2, name: "Bob" },
  ];
  return render(
    <QueryClientProvider client={queryClient}>
      <SavedRoutesPanel
        activeRouteId={activeRouteId}
        onSelectRoute={onSelectRoute}
        teamMembers={teamMembers}
        mapData={undefined}
        routeAddMode={routeAddMode}
        onToggleRouteAddMode={onToggleRouteAddMode}
      />
    </QueryClientProvider>,
  );
}

describe("SavedRoutesPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (apiClient.useListSavedRoutes as any).mockReturnValue({
      data: [
        { id: 10, name: "Morning Route", stops: [{ id: 101 }, { id: 102 }] },
        { id: 11, name: "Afternoon Route", stops: [] },
      ],
    });
    (apiClient.useCreateSavedRoute as any).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    });
    (apiClient.useUpdateSavedRoute as any).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    });
    (apiClient.useDeleteSavedRoute as any).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    });
    (apiClient.useReorderSavedRouteStops as any).mockReturnValue({
      mutate: vi.fn(),
    });
    (apiClient.useDeleteSavedRouteStop as any).mockReturnValue({
      mutate: vi.fn(),
    });

    (apiClient.useGetSavedRoute as any).mockImplementation((id: number) => {
      if (id === 10)
        return {
          data: {
            id: 10,
            name: "Morning Route",
            teamMemberId: 1,
            stops: [
              {
                id: 101,
                position: 1,
                name: "Stop 1",
                lat: 10,
                lng: 10,
                linkedBookingId: null,
              },
              {
                id: 102,
                position: 2,
                name: "Stop 2",
                lat: 11,
                lng: 11,
                linkedBookingId: 999,
              },
            ],
          },
        };
      return { data: null };
    });

    // Stub confirm globally
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists routes and allows selecting one", () => {
    const onSelect = vi.fn();
    renderPanel(null, onSelect);

    expect(screen.getByText("Morning Route")).toBeTruthy();
    expect(screen.getByText("Afternoon Route")).toBeTruthy();
    expect(screen.getByText(/2 stops/)).toBeTruthy();

    fireEvent.click(screen.getByText("Morning Route"));
    expect(onSelect).toHaveBeenCalledWith(10);
  });

  it("renders active route details and schedule-link hrefs", () => {
    renderPanel(10);

    expect(screen.getByText("Stop 1")).toBeTruthy();
    expect(screen.getByText("Stop 2")).toBeTruthy();

    // Unlinked stop has CalendarPlus link
    const addScheduleLink = screen.getByTitle("Add to schedule");
    expect(addScheduleLink.getAttribute("href")).toBe(
      "/bookings/new?routeId=10&routeStopId=101&assign=1",
    );

    // Linked stop shows Booked link
    const bookedLink = screen.getByTitle("View booking");
    expect(bookedLink.getAttribute("href")).toBe("/bookings#booking-999");
  });

  it("allows renaming the active route", () => {
    const updateMutate = vi.fn();
    (apiClient.useUpdateSavedRoute as any).mockReturnValue({
      mutate: updateMutate,
      isPending: false,
    });

    const { container } = renderPanel(10);

    // Find the edit button inside the route details header
    const editBtn = screen.getByTestId("edit-route-name");
    fireEvent.click(editBtn!);

    const input = screen.getByDisplayValue("Morning Route");
    fireEvent.change(input, { target: { value: "New Morning" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    expect(updateMutate).toHaveBeenCalledWith(
      { id: 10, data: { name: "New Morning" } },
      expect.anything(),
    );
  });
});

describe("SavedRoutesPanel mutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (apiClient.useListSavedRoutes as any).mockReturnValue({ data: [] });
    (apiClient.useCreateSavedRoute as any).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    });
    (apiClient.useUpdateSavedRoute as any).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    });
    (apiClient.useDeleteSavedRoute as any).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    });
    (apiClient.useGetSavedRoute as any).mockReturnValue({ data: null });
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("can create a new route and select it", () => {
    const createMutate = vi.fn((params, options) => {
      options.onSuccess({ id: 99 });
    });
    (apiClient.useCreateSavedRoute as any).mockReturnValue({
      mutate: createMutate,
      isPending: false,
    });

    const onSelect = vi.fn();
    renderPanel(null, onSelect);

    fireEvent.click(screen.getByRole("button", { name: "" })); // The Plus button

    const nameInput = screen.getByPlaceholderText("Route name");
    fireEvent.change(nameInput, { target: { value: "New Route" } });

    const select = screen.getByRole("combobox");
    fireEvent.change(select, { target: { value: "1" } });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(createMutate).toHaveBeenCalledWith(
      { data: { name: "New Route", teamMemberId: 1 } },
      expect.anything(),
    );
    expect(onSelect).toHaveBeenCalledWith(99);
  });
});
