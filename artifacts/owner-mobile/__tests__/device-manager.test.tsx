// @vitest-environment jsdom
/**
 * Device housekeeping from the phone (mirrors the web Tracking page rules):
 * - the Location tab shows the device section ONLY to an owner;
 * - deleting a device asks for confirmation first, and a declined confirm
 *   deletes nothing;
 * - a confirmed delete calls DELETE /staff/devices/:id and invalidates both
 *   the device list and the map data query, so the pin leaves the map at the
 *   same moment;
 * - renaming saves the trimmed label and invalidates the same two queries.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("@/components/Brand", () => ({
  BrandHeaderTitle: () => null,
  GradientRule: () => null,
}));

vi.mock("@/lib/location-tracking", () => ({
  useLocationTracking: () => ({
    status: "off",
    enabled: false,
    permissionGranted: false,
    canAskAgain: true,
    lastSentAt: null,
    enable: vi.fn(),
    disable: vi.fn(),
  }),
}));

const deleteMutate = vi.fn();
const renameMutate = vi.fn();
const trackingMutate = vi.fn();

const hooks = vi.hoisted(() => ({
  me: { data: undefined as unknown, isLoading: false },
  devices: {
    data: undefined as unknown,
    isLoading: false,
    isError: false,
  },
}));

let deleteOptions: Record<string, (...args: unknown[]) => void> = {};
let trackingOptions: Record<string, (...args: unknown[]) => void> = {};

vi.mock("@workspace/api-client-react", () => ({
  useGetCurrentUser: () => hooks.me,
  useListStaffDevices: () => hooks.devices,
  useDeleteStaffDevice: (opts?: {
    mutation?: Record<string, (...args: unknown[]) => void>;
  }) => {
    deleteOptions = opts?.mutation ?? {};
    return { mutate: deleteMutate, isPending: false };
  },
  useRenameStaffDevice: () => ({
    mutate: renameMutate,
    isPending: false,
  }),
  useSetStaffTracking: (opts?: {
    mutation?: Record<string, (...args: unknown[]) => void>;
  }) => {
    trackingOptions = opts?.mutation ?? {};
    return { mutate: trackingMutate, isPending: false };
  },
  getListStaffDevicesQueryKey: () => ["/api/staff/devices"],
  getGetMapDataQueryKey: () => ["/api/map/data"],
}));

import LocationScreen from "@/app/(tabs)/location";

const people = [
  {
    teamMemberId: 1,
    name: "Olive Owner",
    roleLabel: "Owner",
    color: null,
    isOwner: true,
    sharingEnabled: true,
    canChangeSharing: false,
    devices: [
      {
        id: 11,
        label: "Olive's iPhone",
        platform: "ios",
        lastSeenAt: null,
        live: true,
        lat: null,
        lng: null,
        accuracy: null,
      },
      {
        id: 12,
        label: "Retired phone",
        platform: "android",
        lastSeenAt: "2026-08-01T00:00:00Z",
        live: false,
        lat: null,
        lng: null,
        accuracy: null,
      },
    ],
  },
  {
    teamMemberId: 2,
    name: "Cleo Cleaner",
    roleLabel: "Cleaner",
    color: "#22c55e",
    isOwner: false,
    sharingEnabled: true,
    canChangeSharing: true,
    devices: [],
  },
];

function renderScreen(queryClient = new QueryClient()) {
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <LocationScreen />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  hooks.me = { data: { role: "owner", email: "o@x.com" }, isLoading: false };
  hooks.devices = { data: { people }, isLoading: false, isError: false };
  deleteMutate.mockReset();
  renameMutate.mockReset();
  trackingMutate.mockReset();
  deleteOptions = {};
  trackingOptions = {};
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe.skip("device manager on the Location tab (moved to Live Map)", () => {
  it("shows the device section to an owner, with every device row", () => {
    const { getByTestId } = renderScreen();
    expect(getByTestId("device-manager")).toBeTruthy();
    expect(getByTestId("row-device-11")).toBeTruthy();
    expect(getByTestId("row-device-12")).toBeTruthy();
  });

  it("hides the section entirely from a non-owner", () => {
    hooks.me = { data: { role: "cleaner" }, isLoading: false };
    const { queryByTestId } = renderScreen();
    expect(queryByTestId("device-manager")).toBeNull();
  });

  it("shows nothing while the role is still loading", () => {
    hooks.me = { data: undefined, isLoading: true };
    const { queryByTestId } = renderScreen();
    expect(queryByTestId("device-manager")).toBeNull();
  });

  it("does not delete when the confirm is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { getByTestId } = renderScreen();
    fireEvent.click(getByTestId("button-delete-device-12"));
    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    expect(deleteMutate).not.toHaveBeenCalled();
  });

  it("deletes after confirm, then invalidates devices AND map data", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { getByTestId, queryClient } = renderScreen();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    fireEvent.click(getByTestId("button-delete-device-12"));
    await waitFor(() => expect(deleteMutate).toHaveBeenCalledWith({ id: 12 }));

    // The component wires invalidation through the mutation's onSuccess.
    deleteOptions.onSuccess?.();
    const keys = invalidate.mock.calls.map(
      (call) => (call[0] as { queryKey: unknown[] }).queryKey,
    );
    expect(keys).toContainEqual(["/api/staff/devices"]);
    expect(keys).toContainEqual(["/api/map/data"]);
  });

  it("shows the tracking switch per person, disabled for the always-on owner", () => {
    const { getByTestId } = renderScreen();
    const ownerSwitch = getByTestId("switch-tracking-1").querySelector(
      "input[type=checkbox]",
    ) as HTMLInputElement;
    const cleanerSwitch = getByTestId("switch-tracking-2").querySelector(
      "input[type=checkbox]",
    ) as HTMLInputElement;
    expect(ownerSwitch.disabled).toBe(true);
    expect(cleanerSwitch.disabled).toBe(false);
  });

  it("toggling tracking calls the mutation, then invalidates devices AND map data", async () => {
    const { getByTestId, queryClient } = renderScreen();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const cleanerSwitch = getByTestId("switch-tracking-2").querySelector(
      "input[type=checkbox]",
    ) as HTMLInputElement;
    fireEvent.click(cleanerSwitch);
    await waitFor(() =>
      expect(trackingMutate).toHaveBeenCalledWith({
        id: 2,
        data: { enabled: false },
      }),
    );

    trackingOptions.onSuccess?.();
    const keys = invalidate.mock.calls.map(
      (call) => (call[0] as { queryKey: unknown[] }).queryKey,
    );
    expect(keys).toContainEqual(["/api/staff/devices"]);
    expect(keys).toContainEqual(["/api/map/data"]);
  });

  it("renames with the trimmed label", async () => {
    const { getByTestId } = renderScreen();
    fireEvent.click(getByTestId("button-rename-device-11"));
    const input = getByTestId("input-device-name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  Van tablet  " } });
    fireEvent.click(getByTestId("button-save-device-name"));
    await waitFor(() =>
      expect(renameMutate).toHaveBeenCalledWith(
        { id: 11, data: { label: "Van tablet" } },
        expect.anything(),
      ),
    );
  });
});
