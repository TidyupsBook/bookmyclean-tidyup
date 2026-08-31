// @vitest-environment jsdom
/**
 * Jobber links on the mobile Team screen: the section shows only for an owner
 * whose company has Jobber connected, rows carry linked/suggested/unmatched
 * status, and confirm-to-link, unlink, and import-as-new-staff hit the right
 * endpoints and refresh both the Jobber list and the roster.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  fireEvent,
  cleanup,
  act,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// --- Mocks: strip Expo-native modules and the generated API hooks ----------

vi.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

const clipboardSetStringAsync = vi.hoisted(() => vi.fn());

vi.mock("expo-clipboard", () => ({
  setStringAsync: clipboardSetStringAsync,
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

const connectMutate = vi.fn();
const linkMutate = vi.fn();
const linkMutateAsync = vi.fn();
const unlinkMutate = vi.fn();
const importMutate = vi.fn();
const renameConnectionMutate = vi.fn();
const deleteConnectionMutate = vi.fn();
const rotateJoinCodeMutate = vi.fn();

const hooks = vi.hoisted(() => ({
  me: { data: undefined as unknown, isLoading: false },
  team: {
    data: undefined as unknown,
    isLoading: false,
    isError: false,
    isRefetching: false,
    refetch: vi.fn(),
  },
  company: { data: undefined as unknown },
  jobber: {
    data: undefined as unknown,
    isLoading: false,
    isError: false,
    error: undefined as unknown,
  },
  jobberEnabled: true,
  connections: {
    data: [] as unknown,
    isLoading: false,
  },
  joinCodeEnabled: true,
  joinCode: {
    data: { joinCode: "ABCD23" } as unknown,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetCurrentUser: () => hooks.me,
  useListTeamMembers: () => hooks.team,
  useGetStaffPresence: () => ({ data: { liveMemberIds: [] } }),
  useApproveTeamMember: () => ({ mutate: vi.fn() }),
  useDeclineTeamMember: () => ({ mutate: vi.fn() }),
  useUpdateTeamMember: () => ({ mutate: vi.fn(), isPending: false }),
  useGetCompany: () => hooks.company,
  useGetJoinCode: (options?: { query?: { enabled?: boolean } }) => {
    hooks.joinCodeEnabled = options?.query?.enabled !== false;
    return hooks.joinCode;
  },
  useRotateJoinCode: () => ({
    mutate: rotateJoinCodeMutate,
    isPending: false,
  }),
  useListJobberTeamMembers: (options?: { query?: { enabled?: boolean } }) => {
    hooks.jobberEnabled = options?.query?.enabled !== false;
    return hooks.jobber;
  },
  useConnectJobber: () => ({ mutate: connectMutate, isPending: false }),
  useLinkJobberUser: () => ({
    mutate: linkMutate,
    mutateAsync: linkMutateAsync,
  }),
  useUnlinkJobberUser: () => ({ mutate: unlinkMutate }),
  useImportJobberUser: () => ({ mutate: importMutate }),
  useListJobberConnections: () => hooks.connections,
  useUpdateJobberConnection: () => ({
    mutate: renameConnectionMutate,
    isPending: false,
  }),
  useDeleteJobberConnection: () => ({
    mutate: deleteConnectionMutate,
    isPending: false,
  }),
  getListTeamMembersQueryKey: () => ["/team"],
  getGetStaffPresenceQueryKey: () => ["/staff/presence"],
  getGetCompanyQueryKey: () => ["/company"],
  getGetJoinCodeQueryKey: () => ["/team/join-code"],
  getListJobberTeamMembersQueryKey: () => ["/team/jobber-members"],
  getListJobberConnectionsQueryKey: () => ["/company/jobber-connections"],
}));

import TeamScreen from "@/app/(tabs)/team";

// --- Fixtures ---------------------------------------------------------------

const owner = {
  id: 1,
  name: "Olive Owner",
  role: "owner",
  isLead: false,
  status: "active",
  phone: null,
  email: null,
  jobberUserId: null,
};
const linkedCleaner = {
  id: 2,
  name: "Casey Cleaner",
  role: "cleaner",
  isLead: false,
  status: "active",
  phone: null,
  email: null,
  jobberUserId: "J1",
};
const freeCleaner = {
  id: 3,
  name: "Frankie Free",
  role: "cleaner",
  isLead: false,
  status: "active",
  phone: null,
  email: null,
  jobberUserId: null,
};
const roster = [owner, linkedCleaner, freeCleaner];

const jobberUsers = [
  // Linked to Casey.
  {
    jobberUserId: "J1",
    name: "Casey C",
    linkedTeamMemberId: 2,
    suggestedTeamMemberId: null,
  },
  // Name-match suggestion pointing at Frankie.
  {
    jobberUserId: "J2",
    name: "Frankie Free",
    linkedTeamMemberId: null,
    suggestedTeamMemberId: 3,
  },
  // Nobody matches.
  {
    jobberUserId: "J3",
    name: "Newcomer Nel",
    linkedTeamMemberId: null,
    suggestedTeamMemberId: null,
  },
].map((u) => ({ ...u, gone: false }));

// A roster member linked to a Jobber user Jobber no longer lists — the
// server reports the stale link as a gone row named for the roster member.
const goneRow = {
  jobberUserId: "J_GONE",
  name: "Casey Cleaner",
  linkedTeamMemberId: 2,
  suggestedTeamMemberId: null,
  gone: true,
};

function renderScreen({
  me = { role: "owner", teamMemberId: null },
  company = { jobberConnected: true, jobberNeedsReauth: false } as unknown,
  joinCode = {
    data: { joinCode: "ABCD23" },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  } as unknown,
  jobber = {
    members: jobberUsers,
    failedConnections: [],
  } as unknown,
  connections = [] as unknown,
  rosterData = roster,
}: {
  me?: { role: string; teamMemberId: number | null };
  company?: unknown;
  joinCode?: unknown;
  jobber?: unknown;
  connections?: unknown;
  rosterData?: unknown;
} = {}) {
  hooks.me = { data: me, isLoading: false };
  hooks.team = {
    data: rosterData,
    isLoading: false,
    isError: false,
    isRefetching: false,
    refetch: vi.fn(),
  };
  hooks.company = { data: company };
  hooks.joinCode = joinCode as typeof hooks.joinCode;
  hooks.jobber = {
    data: jobber,
    isLoading: false,
    isError: false,
    error: undefined,
  };
  hooks.connections = { data: connections, isLoading: false };
  const queryClient = new QueryClient();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TeamScreen />
    </QueryClientProvider>,
  );
  return { queryClient, view };
}

beforeEach(() => {
  connectMutate.mockReset();
  linkMutate.mockReset();
  linkMutateAsync.mockReset();
  unlinkMutate.mockReset();
  importMutate.mockReset();
  renameConnectionMutate.mockReset();
  deleteConnectionMutate.mockReset();
  rotateJoinCodeMutate.mockReset();
  clipboardSetStringAsync.mockReset();
  clipboardSetStringAsync.mockResolvedValue(undefined);
  hooks.jobberEnabled = true;
  vi.spyOn(window, "alert").mockImplementation(() => {});
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Staff join code", () => {
  it("shows the code and copies it for an owner", async () => {
    const { view } = renderScreen();

    expect(view.getByTestId("text-join-code").textContent).toBe("ABCD23");
    expect(view.getByTestId("button-change-join-code")).toBeTruthy();

    fireEvent.click(view.getByTestId("button-copy-join-code"));
    await act(async () => {});

    expect(clipboardSetStringAsync).toHaveBeenCalledWith("ABCD23");
    expect(window.alert).toHaveBeenCalledWith(
      expect.stringContaining("Send it to your new staff member."),
    );
  });

  it("lets a dispatcher copy but not change the code", async () => {
    const { view } = renderScreen({
      me: { role: "dispatcher", teamMemberId: 2 },
    });

    expect(view.getByTestId("button-copy-join-code")).toBeTruthy();
    expect(view.queryByTestId("button-change-join-code")).toBeNull();
    expect(hooks.joinCodeEnabled).toBe(true);

    fireEvent.click(view.getByTestId("button-copy-join-code"));
    await act(async () => {});
    expect(clipboardSetStringAsync).toHaveBeenCalledWith("ABCD23");
  });

  it("does not request the code for a cleaner", () => {
    const { view } = renderScreen({
      me: { role: "cleaner", teamMemberId: 3 },
    });

    expect(hooks.joinCodeEnabled).toBe(false);
    expect(view.queryByTestId("section-join-code")).toBeNull();
  });

  it("confirms rotation, posts it, and shows the new code", async () => {
    const { view, queryClient } = renderScreen();

    fireEvent.click(view.getByTestId("button-change-join-code"));
    await act(async () => {});

    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining("The old code stops working immediately"),
    );
    expect(rotateJoinCodeMutate).toHaveBeenCalledWith(
      undefined,
      expect.any(Object),
    );

    const options = rotateJoinCodeMutate.mock.calls[0]![1] as {
      onSuccess: (result: { joinCode: string }) => void;
    };
    act(() => options.onSuccess({ joinCode: "FRESH7" }));

    expect(queryClient.getQueryData(["/team/join-code"])).toEqual({
      joinCode: "FRESH7",
    });
    expect(window.alert).toHaveBeenCalledWith(
      expect.stringContaining("Your new code is FRESH7"),
    );
  });

  it("does not rotate when the owner cancels", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { view } = renderScreen();

    fireEvent.click(view.getByTestId("button-change-join-code"));
    await act(async () => {});

    expect(rotateJoinCodeMutate).not.toHaveBeenCalled();
  });
});

// --- Visibility ---------------------------------------------------------------

describe("Jobber section visibility", () => {
  it("shows for an owner with Jobber connected", () => {
    const { view } = renderScreen();
    expect(view.queryByTestId("section-jobber-links")).toBeTruthy();
  });

  it("keeps the connection manager available when the roster is empty", () => {
    const { view } = renderScreen({
      rosterData: [],
      connections: [
        {
          id: 1,
          accountId: "jobber-owner",
          accountName: "Owner account",
          displayName: "Richard's iPhone",
        },
      ],
    });
    expect(view.queryByTestId("section-jobber-links")).toBeTruthy();
    expect(view.queryByTestId("section-jobber-connections")).toBeTruthy();
  });

  it("offers the first connect when Jobber isn't connected", () => {
    const { view } = renderScreen({
      company: { jobberConnected: false, jobberNeedsReauth: false },
    });
    expect(view.queryByTestId("section-jobber-links")).toBeNull();
    expect(view.queryByTestId("section-jobber-connect")).toBeTruthy();
    fireEvent.click(view.getByTestId("button-jobber-connect"));
    expect(connectMutate).toHaveBeenCalledTimes(1);
  });

  it("hides the connect offer from a cleaner and a dispatcher", () => {
    for (const me of [
      { role: "cleaner", teamMemberId: 3 },
      { role: "dispatcher", teamMemberId: 2 },
    ]) {
      const { view } = renderScreen({
        me,
        company: { jobberConnected: false, jobberNeedsReauth: false },
      });
      expect(view.queryByTestId("section-jobber-connect")).toBeNull();
      cleanup();
    }
  });

  it("hides from a cleaner even if company data leaked into the cache", () => {
    const { view } = renderScreen({
      me: { role: "cleaner", teamMemberId: 3 },
    });
    expect(view.queryByTestId("section-jobber-links")).toBeNull();
  });

  it("hides from a dispatcher (link management is owner-only)", () => {
    const { view } = renderScreen({
      me: { role: "dispatcher", teamMemberId: 2 },
    });
    expect(view.queryByTestId("section-jobber-links")).toBeNull();
  });

  it("shows a reauth notice instead of the list when the grant lapsed", () => {
    const { view } = renderScreen({
      company: { jobberConnected: true, jobberNeedsReauth: true },
    });
    expect(view.queryByTestId("text-jobber-reauth")).toBeTruthy();
    // The list query must not fire — the server would 409.
    expect(hooks.jobberEnabled).toBe(false);
    expect(view.queryByTestId("card-jobber-J1")).toBeNull();
  });

  it("offers a Reconnect Jobber action that starts the connect flow", () => {
    const opened: string[] = [];
    vi.spyOn(window, "open").mockImplementation((url) => {
      opened.push(String(url));
      return null;
    });
    const { view } = renderScreen({
      company: { jobberConnected: true, jobberNeedsReauth: true },
    });
    const button = view.getByTestId("button-jobber-reconnect");
    fireEvent.click(button);
    expect(connectMutate).toHaveBeenCalledTimes(1);
    // The connect mutation succeeds with an authorize URL → opened in browser.
    const options = connectMutate.mock.calls[0]![1] as {
      onSuccess: (data: { authorizeUrl: string }) => void;
    };
    act(() => {
      options.onSuccess({ authorizeUrl: "https://jobber.example/authorize" });
    });
    expect(opened).toEqual(["https://jobber.example/authorize"]);
  });

  it("surfaces the server's error when the connect flow can't start", () => {
    const alerts: string[] = [];
    vi.spyOn(window, "alert").mockImplementation((msg) => {
      alerts.push(String(msg));
    });
    const { view } = renderScreen({
      company: { jobberConnected: true, jobberNeedsReauth: true },
    });
    fireEvent.click(view.getByTestId("button-jobber-reconnect"));
    const options = connectMutate.mock.calls[0]![1] as {
      onError: (error: unknown) => void;
    };
    act(() => {
      options.onError({ data: { error: "Only the owner can do that." } });
    });
    expect(alerts.join("\n")).toContain("Only the owner can do that.");
  });
});

describe("Jobber account manager", () => {
  const connection = {
    id: 41,
    companyId: 1,
    displayName: "Richard's iPhone crew",
    accountId: "jobber-richard",
    accountName: "Richard Main",
    needsReauth: false,
    createdAt: "2026-08-22T00:00:00.000Z",
  };

  it("shows owner-managed names and the available connection capacity", () => {
    const { view } = renderScreen({ connections: [connection] });
    expect(
      view.getByTestId(`card-jobber-connection-${connection.id}`).textContent,
    ).toContain("Richard's iPhone crew");
    expect(
      view.getByTestId("text-jobber-connection-capacity").textContent,
    ).toContain("1 of 20 accounts connected");
  });

  it("prevents a twenty-first connect attempt on a phone", () => {
    const connections = Array.from({ length: 20 }, (_, index) => ({
      ...connection,
      id: index + 1,
      displayName: `Crew ${index + 1}`,
    }));
    const { view } = renderScreen({ connections });
    expect(
      view.getByTestId("text-jobber-connection-capacity").textContent,
    ).toContain("all connection slots are filled");
    expect(
      view.getByTestId("button-connect-another-jobber").textContent,
    ).toContain("All 20 accounts connected");
    fireEvent.click(view.getByTestId("button-connect-another-jobber"));
    expect(connectMutate).not.toHaveBeenCalled();
  });

  it("renames an account through the generated owner-only mutation", () => {
    const { view } = renderScreen({ connections: [connection] });
    fireEvent.click(
      view.getByTestId(`button-rename-jobber-connection-${connection.id}`),
    );
    fireEvent.change(view.getByTestId("input-jobber-connection-name"), {
      target: { value: "Richard's Android crew" },
    });
    fireEvent.click(view.getByTestId("button-rename-connection-save"));
    expect(renameConnectionMutate).toHaveBeenCalledWith(
      {
        id: connection.id,
        data: { displayName: "Richard's Android crew" },
      },
      expect.any(Object),
    );
  });
});

// --- Row status ----------------------------------------------------------------

describe("Jobber row status", () => {
  it("labels linked, suggested, and unmatched rows", () => {
    const { view } = renderScreen();
    expect(view.getByTestId("text-jobber-status-J1").textContent).toContain(
      "Linked to Casey Cleaner",
    );
    expect(view.getByTestId("text-jobber-status-J2").textContent).toContain(
      "Looks like Frankie Free",
    );
    expect(view.getByTestId("text-jobber-status-J3").textContent).toContain(
      "Nobody on your staff list matches",
    );
  });

  it("offers unlink on linked rows, confirm/import on the rest", () => {
    const { view } = renderScreen();
    expect(view.queryByTestId("button-unlink-J1")).toBeTruthy();
    expect(view.queryByTestId("button-confirm-link-J2")).toBeTruthy();
    expect(view.queryByTestId("button-choose-staff-J3")).toBeTruthy();
    expect(view.queryByTestId("button-import-J2")).toBeTruthy();
    expect(view.queryByTestId("button-import-J3")).toBeTruthy();
  });

  it("names unavailable Jobber accounts and pauses every link action", () => {
    const { view } = renderScreen({
      jobber: {
        members: jobberUsers,
        failedConnections: [{ id: 12, name: "Night crew" }],
      },
    });

    expect(
      view.getByTestId("text-jobber-team-incomplete").textContent,
    ).toContain("Night crew is unavailable");
    expect(view.queryByTestId("button-unlink-J1")).toBeNull();
    expect(view.queryByTestId("button-confirm-link-J2")).toBeNull();
    expect(view.queryByTestId("button-choose-staff-J3")).toBeNull();
    expect(view.queryByTestId("button-import-J2")).toBeNull();
    expect(
      view.getByTestId("text-jobber-link-paused-J1").textContent,
    ).toContain("Linking paused");
  });

  it("warns about a vanished Jobber account and offers only Unlink", async () => {
    const { view } = renderScreen({
      jobber: { members: [...jobberUsers, goneRow], failedConnections: [] },
    });
    const card = view.getByTestId("card-jobber-gone-J_GONE");
    expect(card.textContent).toContain("Casey Cleaner");
    expect(view.getByTestId("text-jobber-gone-J_GONE").textContent).toContain(
      "gone or deactivated",
    );
    // Never presented as a healthy link, and the dead id can't be linked
    // or imported — the only action is the recovery one.
    expect(card.textContent).not.toContain("Linked to");
    expect(view.queryByTestId("button-confirm-link-J_GONE")).toBeNull();
    expect(view.queryByTestId("button-choose-staff-J_GONE")).toBeNull();
    expect(view.queryByTestId("button-import-J_GONE")).toBeNull();

    fireEvent.click(view.getByTestId("button-unlink-J_GONE"));
    await act(async () => {});
    expect(unlinkMutate).toHaveBeenCalledTimes(1);
    expect(unlinkMutate.mock.calls[0][0]).toEqual({ id: 2 });
  });
});

// --- Actions ---------------------------------------------------------------------

describe("Jobber link actions", () => {
  it("offers one-tap linking for each free seat, not duplicate or linked seats", async () => {
    linkMutateAsync.mockResolvedValue({});
    const { view } = renderScreen({
      jobber: {
        members: [
          ...jobberUsers,
          {
            jobberUserId: "J4",
            name: "Another Frankie",
            linkedTeamMemberId: null,
            suggestedTeamMemberId: 3,
            gone: false,
          },
          {
            jobberUserId: "J5",
            name: "Another Casey",
            linkedTeamMemberId: null,
            suggestedTeamMemberId: 2,
            gone: false,
          },
        ],
        failedConnections: [],
      },
    });

    expect(
      view.getByTestId("button-jobber-link-all-suggested").textContent,
    ).toContain("Link all 1 suggested");

    fireEvent.click(view.getByTestId("button-jobber-link-all-suggested"));
    await waitFor(() => expect(linkMutateAsync).toHaveBeenCalledTimes(1));

    expect(linkMutateAsync).toHaveBeenCalledWith({
      id: 3,
      data: { jobberUserId: "J2" },
    });
    expect(linkMutateAsync).not.toHaveBeenCalledWith({
      id: 3,
      data: { jobberUserId: "J4" },
    });
    expect(linkMutateAsync).not.toHaveBeenCalledWith({
      id: 2,
      data: { jobberUserId: "J5" },
    });
    expect(window.alert).toHaveBeenCalledWith(
      expect.stringContaining("Linked 1 of 1"),
    );
    await waitFor(() =>
      expect(
        view.getByTestId("button-jobber-link-all-suggested").textContent,
      ).toContain("Link all 1 suggested"),
    );

    // Skipped suggestions stay visible for the recovery path: J4 duplicates
    // the safe Frankie pairing, while J5 points at Casey's already-linked
    // seat. Both still expose their individual link controls.
    expect(view.getByTestId("card-jobber-J4")).toBeTruthy();
    expect(view.getByTestId("card-jobber-J5")).toBeTruthy();
    expect(view.getByTestId("button-confirm-link-J4")).toBeTruthy();
    expect(view.getByTestId("button-confirm-link-J5")).toBeTruthy();

    fireEvent.click(view.getByTestId("button-confirm-link-J4"));
    fireEvent.click(view.getByTestId("button-confirm-link-J5"));
    expect(linkMutate.mock.calls[0]![0]).toEqual({
      id: 3,
      data: { jobberUserId: "J4" },
    });
    expect(linkMutate.mock.calls[1]![0]).toEqual({
      id: 2,
      data: { jobberUserId: "J5" },
    });
  });

  it("keeps linking after a refusal and shows the refusal on its row", async () => {
    linkMutateAsync
      .mockRejectedValueOnce({
        data: { error: "Already linked elsewhere" },
      })
      .mockResolvedValueOnce({});
    const { view } = renderScreen({
      jobber: {
        members: [
          ...jobberUsers,
          {
            jobberUserId: "J4",
            name: "Another Frankie",
            linkedTeamMemberId: null,
            suggestedTeamMemberId: 1,
            gone: false,
          },
        ],
        failedConnections: [],
      },
    });

    fireEvent.click(view.getByTestId("button-jobber-link-all-suggested"));
    await waitFor(() => expect(linkMutateAsync).toHaveBeenCalledTimes(2));

    expect(view.getByTestId("text-jobber-link-error-J2").textContent).toContain(
      "Already linked elsewhere",
    );
    expect(view.queryByTestId("text-jobber-link-error-J4")).toBeNull();
    expect(window.alert).toHaveBeenCalledWith(
      expect.stringContaining("Linked 1, 1 didn't stick"),
    );
  });

  it("confirm-to-link posts the suggested pairing and refreshes both lists", () => {
    const { view, queryClient } = renderScreen();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    fireEvent.click(view.getByTestId("button-confirm-link-J2"));
    expect(linkMutate).toHaveBeenCalledTimes(1);
    const [args, opts] = linkMutate.mock.calls[0];
    expect(args).toEqual({ id: 3, data: { jobberUserId: "J2" } });
    act(() => opts.onSuccess());
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["/team/jobber-members"],
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/team"] });
  });

  it("manual link goes through the staff picker, offering only unlinked staff", () => {
    const { view } = renderScreen();
    fireEvent.click(view.getByTestId("button-choose-staff-J3"));
    // Casey is already linked to J1, so only the owner and Frankie are offered.
    expect(view.queryByTestId("button-pick-staff-2")).toBeNull();
    fireEvent.click(view.getByTestId("button-pick-staff-3"));
    expect(linkMutate).toHaveBeenCalledTimes(1);
    expect(linkMutate.mock.calls[0][0]).toEqual({
      id: 3,
      data: { jobberUserId: "J3" },
    });
  });

  it("unlink confirms, then deletes the link", async () => {
    const { view } = renderScreen();
    fireEvent.click(view.getByTestId("button-unlink-J1"));
    await act(async () => {});
    expect(unlinkMutate).toHaveBeenCalledTimes(1);
    expect(unlinkMutate.mock.calls[0][0]).toEqual({ id: 2 });
  });

  it("unlink does nothing when the confirm is declined", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { view } = renderScreen();
    fireEvent.click(view.getByTestId("button-unlink-J1"));
    await act(async () => {});
    expect(unlinkMutate).not.toHaveBeenCalled();
  });

  it("import confirms, then creates the new staff seat", async () => {
    const { view } = renderScreen();
    fireEvent.click(view.getByTestId("button-import-J3"));
    await act(async () => {});
    expect(importMutate).toHaveBeenCalledTimes(1);
    expect(importMutate.mock.calls[0][0]).toEqual({
      data: { jobberUserId: "J3" },
    });
  });

  it("surfaces the server's error message when a link fails", () => {
    const { view } = renderScreen();
    fireEvent.click(view.getByTestId("button-confirm-link-J2"));
    const [, opts] = linkMutate.mock.calls[0];
    act(() => opts.onError({ data: { error: "Already linked elsewhere" } }));
    expect(window.alert).toHaveBeenCalledWith(
      expect.stringContaining("Already linked elsewhere"),
    );
  });
});
