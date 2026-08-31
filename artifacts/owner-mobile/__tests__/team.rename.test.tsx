// @vitest-environment jsdom
/**
 * The rename sheet on the Team screen: the pencil shows only on the caller's
 * own card (and only for owner/dispatcher), Save stays disabled for empty or
 * unchanged names, and a successful save PATCHes the trimmed name and
 * invalidates queries so map labels and chat lists pick it up.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// --- Mocks: strip Expo-native modules and the generated API hooks ----------

vi.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

vi.mock("expo-clipboard", () => ({
  setStringAsync: vi.fn(),
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

const updateMutate = vi.fn();

const hooks = vi.hoisted(() => ({
  me: { data: undefined as unknown, isLoading: false },
  team: {
    data: undefined as unknown,
    isLoading: false,
    isError: false,
    isRefetching: false,
    refetch: vi.fn(),
  },
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetCurrentUser: () => hooks.me,
  useListTeamMembers: () => hooks.team,
  useGetStaffPresence: () => ({ data: { liveMemberIds: [] } }),
  useApproveTeamMember: () => ({ mutate: vi.fn() }),
  useDeclineTeamMember: () => ({ mutate: vi.fn() }),
  useUpdateTeamMember: () => ({ mutate: updateMutate, isPending: false }),
  // Jobber-links wiring: not connected here, so the section never renders.
  useGetCompany: () => ({ data: undefined }),
  useGetJoinCode: () => ({
    data: { joinCode: "ABCD23" },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useRotateJoinCode: () => ({ mutate: vi.fn(), isPending: false }),
  useListJobberTeamMembers: () => ({ data: undefined }),
  useLinkJobberUser: () => ({ mutate: vi.fn() }),
  useUnlinkJobberUser: () => ({ mutate: vi.fn() }),
  useImportJobberUser: () => ({ mutate: vi.fn() }),
  getListTeamMembersQueryKey: () => ["/team"],
  getGetStaffPresenceQueryKey: () => ["/staff/presence"],
  getGetCompanyQueryKey: () => ["/company"],
  getGetJoinCodeQueryKey: () => ["/team/join-code"],
  getListJobberTeamMembersQueryKey: () => ["/team/jobber-members"],
}));

import TeamScreen from "@/app/(tabs)/team";

// --- Fixtures ---------------------------------------------------------------

const owner = {
  id: 1,
  name: "You",
  role: "owner",
  isLead: false,
  status: "active",
  phone: null,
  email: null,
};
const dispatcher = {
  id: 2,
  name: "Dana Dispatch",
  role: "dispatcher",
  isLead: false,
  status: "active",
  phone: null,
  email: null,
};
const cleaner = {
  id: 3,
  name: "Casey Cleaner",
  role: "cleaner",
  isLead: false,
  status: "active",
  phone: null,
  email: null,
};
const roster = [owner, dispatcher, cleaner];

function renderScreen(me: { role: string; teamMemberId: number | null }): {
  queryClient: QueryClient;
  view: ReturnType<typeof render>;
} {
  hooks.me = { data: me, isLoading: false };
  hooks.team = {
    data: roster,
    isLoading: false,
    isError: false,
    isRefetching: false,
    refetch: vi.fn(),
  };
  const queryClient = new QueryClient();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TeamScreen />
    </QueryClientProvider>,
  );
  return { queryClient, view };
}

beforeEach(() => {
  updateMutate.mockReset();
  vi.spyOn(window, "alert").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// --- Pencil visibility --------------------------------------------------------

describe("rename pencil visibility", () => {
  it("owner sees the pencil only on the owner card", () => {
    const { view } = renderScreen({ role: "owner", teamMemberId: null });
    expect(view.queryByTestId("button-edit-name-1")).toBeTruthy();
    expect(view.queryByTestId("button-edit-name-2")).toBeNull();
    expect(view.queryByTestId("button-edit-name-3")).toBeNull();
  });

  it("dispatcher sees the pencil only on their own card", () => {
    const { view } = renderScreen({ role: "dispatcher", teamMemberId: 2 });
    expect(view.queryByTestId("button-edit-name-2")).toBeTruthy();
    expect(view.queryByTestId("button-edit-name-1")).toBeNull();
    expect(view.queryByTestId("button-edit-name-3")).toBeNull();
  });

  it("cleaner sees the pencil only on their own card", () => {
    // Self-rename opened to cleaners: the server accepts a cleaner's PATCH
    // for their own card's name and nothing else, so the pencil follows.
    const { view } = renderScreen({ role: "cleaner", teamMemberId: 3 });
    expect(view.queryByTestId("button-edit-name-3")).toBeTruthy();
    expect(view.queryByTestId("button-edit-name-1")).toBeNull();
    expect(view.queryByTestId("button-edit-name-2")).toBeNull();
  });
});

// --- Saving ------------------------------------------------------------------

function openSheet(view: ReturnType<typeof render>, memberId: number) {
  fireEvent.click(view.getByTestId(`button-edit-name-${memberId}`));
  return view.getByTestId("input-my-name") as HTMLInputElement;
}

describe("rename sheet saving", () => {
  it("saves a trimmed name via PATCH and invalidates queries on success", () => {
    const { view, queryClient } = renderScreen({
      role: "owner",
      teamMemberId: null,
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const input = openSheet(view, owner.id);
    // Seeded with the current name.
    expect(input.value).toBe("You");

    fireEvent.change(input, { target: { value: "  Olive Owner  " } });
    fireEvent.click(view.getByTestId("button-save-name"));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    const [args, opts] = updateMutate.mock.calls[0];
    expect(args).toEqual({ id: owner.id, data: { name: "Olive Owner" } });

    // Simulate the server accepting the rename.
    act(() => opts.onSuccess());
    expect(invalidate).toHaveBeenCalled();
    // onSaved fired: the sheet closes and the confirmation names the new name.
    // (react-native-web keeps a hidden Modal mounted, so assert on the
    // notification rather than the input's absence.)
    expect(window.alert).toHaveBeenCalledWith(
      expect.stringContaining("Olive Owner"),
    );
  });

  it("keeps Save disabled for an empty (whitespace-only) name", () => {
    const { view } = renderScreen({ role: "owner", teamMemberId: null });
    const input = openSheet(view, owner.id);
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(view.getByTestId("button-save-name"));
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it("keeps Save disabled when the name is unchanged", () => {
    const { view } = renderScreen({ role: "owner", teamMemberId: null });
    const input = openSheet(view, owner.id);
    // Same name, extra whitespace — trims back to the stored value.
    fireEvent.change(input, { target: { value: " You " } });
    fireEvent.click(view.getByTestId("button-save-name"));
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it("shows the server's error message when the save fails", () => {
    const { view } = renderScreen({ role: "owner", teamMemberId: null });
    const input = openSheet(view, owner.id);
    fireEvent.change(input, { target: { value: "Olive" } });
    fireEvent.click(view.getByTestId("button-save-name"));

    const [, opts] = updateMutate.mock.calls[0];
    act(() => opts.onError({ data: { error: "Name is taken" } }));
    expect(view.getByText("Name is taken")).toBeTruthy();
    // Sheet stays open for another try.
    expect(view.queryByTestId("input-my-name")).toBeTruthy();
  });
});
