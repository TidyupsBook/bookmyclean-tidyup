// @vitest-environment jsdom
/**
 * "Link all N suggested" turns first-time Jobber setup into one tap while
 * keeping the owner-confirmation principle: only suggestions the server's own
 * matcher produced are linked, each through the same per-seat endpoint. These
 * tests pin the count, the sequential linking, the per-row failure messages,
 * and who gets the button at all.
 */
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

function query(data?: unknown) {
  return { data, isLoading: false, error: null };
}
function mutation() {
  return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
}

// Mutable fixtures each test sets before render.
let teamFixture: Record<string, unknown>[] = [];
let jobberFixture: Record<string, unknown>[] = [];
let failedJobberConnectionsFixture: Record<string, unknown>[] = [];
let userFixture: Record<string, unknown> = {};
let connectionFixture: Record<string, unknown>[] = [];
const linkMutateAsync = vi.fn();
const inviteMutate = vi.fn();
const toastSpy = vi.fn();

function staff(
  id: number,
  name: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    name,
    email: null,
    phone: null,
    role: "cleaner",
    isLead: false,
    title: null,
    roleLabel: "Cleaner",
    active: true,
    liveCallDispatching: false,
    color: null,
    homeAddress: null,
    homeLat: null,
    homeLng: null,
    status: "active",
    hasLogin: false,
    inviteEmailSent: false,
    blockedByOtherCompany: false,
    jobberUserId: null,
    claimedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function jobberUser(
  jobberUserId: string,
  name: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    jobberUserId,
    name,
    linkedTeamMemberId: null,
    suggestedTeamMemberId: null,
    ...overrides,
  };
}

vi.mock("@workspace/api-client-react", () => ({
  useListTeamMembers: () => query(teamFixture),
  useInviteTeamMember: () => ({ mutate: inviteMutate, isPending: false }),
  useUpdateTeamMember: mutation,
  useRemoveTeamMember: mutation,
  useImportTeamMembers: mutation,
  useGetJoinCode: () => query({ joinCode: "ABC234" }),
  useRotateJoinCode: mutation,
  getGetJoinCodeQueryKey: () => ["/api/team/join-code"],
  useGetCurrentUser: () => query(userFixture),
  useApproveTeamMember: mutation,
  useDeclineTeamMember: mutation,
  useGetStaffPresence: () => query({ liveMemberIds: [] }),
  useGetCompany: () =>
    query({
      id: 1,
      name: "Sparkle Co",
      jobberConnected: true,
      jobberNeedsReauth: false,
    }),
  useListJobberTeamMembers: () =>
    query({
      members: jobberFixture,
      failedConnections: failedJobberConnectionsFixture,
    }),
  useLinkJobberUser: () => ({
    mutate: vi.fn(),
    mutateAsync: linkMutateAsync,
    isPending: false,
  }),
  useUnlinkJobberUser: mutation,
  useImportJobberUser: mutation,
  useRevokeTeamMemberAccount: mutation,
  useListJobberConnections: () => query(connectionFixture),
  useUpdateJobberConnection: mutation,
  useDeleteJobberConnection: mutation,
  useConnectJobber: mutation,
  getListTeamMembersQueryKey: () => ["/api/team"],
  getGetStaffPresenceQueryKey: () => ["/api/team/presence"],
  getListJobberTeamMembersQueryKey: () => ["/api/team/jobber"],
  getListJobberConnectionsQueryKey: () => ["/api/company/jobber-connections"],
}));

vi.mock("@/components/layout/AppLayout", () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@/components/AddressAutocomplete", () => ({
  AddressAutocomplete: () => null,
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

import { TeamPage } from "./team";

function setup({
  team,
  jobber,
  failedConnections = [],
  user = { id: 1, name: "Pat", role: "owner", teamMemberId: null },
  connections = [],
}: {
  team: Record<string, unknown>[];
  jobber: Record<string, unknown>[];
  failedConnections?: Record<string, unknown>[];
  user?: Record<string, unknown>;
  connections?: Record<string, unknown>[];
}) {
  teamFixture = team;
  jobberFixture = jobber;
  failedJobberConnectionsFixture = failedConnections;
  userFixture = user;
  connectionFixture = connections;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TeamPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  linkMutateAsync.mockReset();
  inviteMutate.mockReset();
  toastSpy.mockReset();
  failedJobberConnectionsFixture = [];
});

describe("Link all suggested Jobber matches", () => {
  it("keeps retired seats out of the working roster until explicitly shown", () => {
    setup({
      team: [staff(1, "Ana"), staff(2, "Former Cleaner", { active: false })],
      jobber: [],
    });

    expect(screen.getByTestId("card-staff-1")).toBeInTheDocument();
    expect(screen.queryByTestId("card-staff-2")).toBeNull();
    expect(screen.getByTestId("button-toggle-off-roster")).toHaveTextContent(
      "Show 1 off-roster record",
    );

    fireEvent.click(screen.getByTestId("button-toggle-off-roster"));

    expect(screen.getByTestId("card-staff-2")).toBeInTheDocument();
  });

  it("links every suggested match through the per-seat endpoint and reports the count", async () => {
    linkMutateAsync.mockResolvedValue({});
    setup({
      team: [staff(1, "Ana"), staff(2, "Ben")],
      jobber: [
        jobberUser("j-1", "Ana R", { suggestedTeamMemberId: 1 }),
        jobberUser("j-2", "Ben K", { suggestedTeamMemberId: 2 }),
        jobberUser("j-3", "Nobody Matches"),
      ],
    });

    const button = screen.getByTestId("button-jobber-link-all-suggested");
    expect(button).toHaveTextContent("Link all 2 suggested");

    fireEvent.click(button);

    await waitFor(() => expect(linkMutateAsync).toHaveBeenCalledTimes(2));
    expect(linkMutateAsync).toHaveBeenCalledWith({
      id: 1,
      data: { jobberUserId: "j-1" },
    });
    expect(linkMutateAsync).toHaveBeenCalledWith({
      id: 2,
      data: { jobberUserId: "j-2" },
    });
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Linked 2 of 2" }),
    );
  });

  it("leaves a refused link unlinked with a message on its row and keeps going", async () => {
    linkMutateAsync
      .mockRejectedValueOnce({
        data: { error: "That Jobber user is already linked" },
      })
      .mockResolvedValueOnce({});
    setup({
      team: [staff(1, "Ana"), staff(2, "Ben")],
      jobber: [
        jobberUser("j-1", "Ana R", { suggestedTeamMemberId: 1 }),
        jobberUser("j-2", "Ben K", { suggestedTeamMemberId: 2 }),
      ],
    });

    fireEvent.click(screen.getByTestId("button-jobber-link-all-suggested"));

    await waitFor(() => expect(linkMutateAsync).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByTestId("text-jobber-link-error-j-1"),
    ).toHaveTextContent("That Jobber user is already linked");
    expect(screen.queryByTestId("text-jobber-link-error-j-2")).toBeNull();
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Linked 1, 1 didn't stick" }),
    );
  });

  it("offers a seat suggested twice to only the first Jobber user", () => {
    setup({
      team: [staff(1, "Ana")],
      jobber: [
        jobberUser("j-1", "Ana R", { suggestedTeamMemberId: 1 }),
        jobberUser("j-2", "Ana Reyes", { suggestedTeamMemberId: 1 }),
      ],
    });

    expect(
      screen.getByTestId("button-jobber-link-all-suggested"),
    ).toHaveTextContent("Link all 1 suggested");
  });

  it("counts no suggestion pointing at a seat already linked elsewhere", () => {
    setup({
      team: [staff(1, "Ana", { jobberUserId: "j-9" })],
      jobber: [
        jobberUser("j-9", "Ana R", { linkedTeamMemberId: 1 }),
        jobberUser("j-2", "Ana Reyes", { suggestedTeamMemberId: 1 }),
      ],
    });

    expect(screen.queryByTestId("button-jobber-link-all-suggested")).toBeNull();
  });

  it("offers an owner seat as a manual link target — the boss's own Jobber accounts link to their seat instead of importing new members", () => {
    setup({
      team: [
        staff(1, "Richard", { role: "owner", roleLabel: "Owner" }),
        staff(2, "Ana"),
      ],
      jobber: [jobberUser("j-boss", "Boss Mobile")],
    });

    // jsdom lacks the pointer-capture API Radix's select consults on open.
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.releasePointerCapture ??= () => {};
    Element.prototype.scrollIntoView ??= () => {};
    const trigger = screen.getByTestId("select-jobber-match-j-boss");
    fireEvent.pointerDown(
      trigger,
      new MouseEvent("pointerdown", { bubbles: true }),
    );
    fireEvent.click(trigger);
    const options = screen.getAllByRole("option", { hidden: true });
    expect(options.map((o) => o.textContent)).toEqual(
      expect.arrayContaining(["Richard", "Ana"]),
    );
  });

  it("hides the button from a dispatcher — linking stays an owner action", () => {
    setup({
      team: [staff(1, "Ana")],
      jobber: [jobberUser("j-1", "Ana R", { suggestedTeamMemberId: 1 })],
      user: { id: 2, name: "Dee", role: "dispatcher", teamMemberId: 5 },
    });

    expect(screen.queryByTestId("button-jobber-link-all-suggested")).toBeNull();
  });

  it("names unavailable accounts and pauses every link change until the roster is complete", () => {
    setup({
      team: [staff(1, "Ana")],
      jobber: [
        jobberUser("j-1", "Ana R", { suggestedTeamMemberId: 1 }),
        jobberUser("j-2", "New Jobber Cleaner"),
      ],
      failedConnections: [{ id: 12, name: "Night crew" }],
    });

    expect(screen.getByTestId("text-jobber-team-incomplete")).toHaveTextContent(
      "Night crew is unavailable",
    );
    expect(screen.getByTestId("text-jobber-team-incomplete")).toHaveTextContent(
      "linking, adding, and unlinking staff is paused",
    );
    expect(screen.queryByTestId("button-jobber-link-all-suggested")).toBeNull();
    expect(
      screen.getByTestId("badge-jobber-link-paused-j-1"),
    ).toHaveTextContent("Linking paused");
    expect(screen.queryByTestId("select-jobber-match-j-2")).toBeNull();
    expect(screen.queryByTestId("button-jobber-import-j-2")).toBeNull();
  });
});

describe("New staff Jobber assignment", () => {
  it("persists the only selected Jobber account for a roster-only temporary staff member", () => {
    Element.prototype.scrollIntoView ??= () => {};
    setup({
      team: [staff(1, "Richard", { role: "owner", roleLabel: "Owner" })],
      jobber: [],
      connections: [
        {
          id: 91,
          companyId: 1,
          displayName: "Richard's iPhone crew",
          accountId: "jobber-richard",
          accountName: "Richard Main",
          needsReauth: false,
          createdAt: "2026-08-22T00:00:00.000Z",
        },
      ],
    });

    fireEvent.click(screen.getByTestId("button-add-staff"));
    fireEvent.change(screen.getByTestId("input-staff-name"), {
      target: { value: "Temporary cleaner" },
    });
    fireEvent.click(screen.getByTestId("button-save-staff"));

    expect(inviteMutate).toHaveBeenCalledWith(
      {
        data: expect.objectContaining({
          name: "Temporary cleaner",
          email: null,
          jobberConnectionId: 91,
        }),
      },
      expect.any(Object),
    );
  });

  it("shows the twenty-account capacity and disables another connect", () => {
    const connections = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      companyId: 1,
      displayName: `Crew ${index + 1}`,
      accountId: `jobber-${index + 1}`,
      accountName: `Crew ${index + 1}`,
      needsReauth: false,
      createdAt: "2026-08-22T00:00:00.000Z",
    }));
    setup({
      team: [staff(1, "Richard", { role: "owner", roleLabel: "Owner" })],
      jobber: [],
      connections,
    });

    expect(
      screen.getByTestId("text-jobber-connection-capacity"),
    ).toHaveTextContent("20 of 20 accounts connected");
    expect(screen.getByTestId("button-connect-another-jobber")).toBeDisabled();
  });
});
