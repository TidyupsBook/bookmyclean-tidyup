// @vitest-environment jsdom
/**
 * The gap between "signed in" and "tabs visible": while /api/me is in
 * flight the layout shows the brand loading screen (never a blank screen),
 * a persistent failure shows an explanation with a retry, and tabs are never
 * laid out before the role is known (no Activity-tab flash for a cleaner).
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";

// --- Mocks: strip Expo-native modules and the generated API hooks ----------

vi.mock("@clerk/expo", () => ({
  useAuth: () => ({
    isSignedIn: true,
    isLoaded: true,
    getToken: vi.fn(async () => "token"),
  }),
}));

vi.mock("@expo/vector-icons", () => ({ Feather: () => null }));
vi.mock("expo-blur", () => ({ BlurView: () => null }));
vi.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
vi.mock("expo-glass-effect", () => ({ isLiquidGlassAvailable: () => false }));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("expo-router", () => ({
  Redirect: () => null,
  Tabs: Object.assign(
    ({ children }: { children?: React.ReactNode }) => (
      <div data-testid="tabs-root">{children}</div>
    ),
    { Screen: () => null },
  ),
}));
vi.mock("expo-router/unstable-native-tabs", () => ({
  NativeTabs: Object.assign(() => null, { Trigger: () => null }),
  Icon: () => null,
  Label: () => null,
  Badge: () => null,
}));

// SparkleLogo pulls in react-native-svg, which doesn't parse under vitest.
vi.mock("@/components/Brand", () => ({
  SparkleLogo: () => null,
  BrandHeaderTitle: () => null,
}));

vi.mock("@/components/WorkspaceGate", () => ({
  WorkspaceGate: () => <div data-testid="workspace-gate" />,
}));
// Only the token getter needs neutering; the retry policy is plain logic and
// the layout reads it directly, so keep the real one.
vi.mock("@/lib/auth-token", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-token")>()),
  createResilientTokenGetter: (fn: unknown) => fn,
}));
vi.mock("@/lib/clerk-status", () => ({
  useClerkStatus: () => "ok",
  isConnectionTrouble: () => false,
}));
vi.mock("@/lib/location-tracking", () => ({
  LocationTrackingProvider: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
}));
// The one-time location ask is tested on its own; here it would only drag
// AsyncStorage into a test about which gate screen shows.
vi.mock("@/components/LocationPermissionAsk", () => ({
  LocationPermissionAsk: () => null,
}));

const hooks = vi.hoisted(() => ({
  me: {
    data: undefined as unknown,
    isLoading: true,
    isError: false,
    isFetching: true,
    refetch: vi.fn(),
  },
}));

vi.mock("@workspace/api-client-react", () => ({
  setAuthTokenGetter: vi.fn(),
  useGetCurrentUser: () => hooks.me,
  getGetCurrentUserQueryKey: () => ["/me"],
  useGetUnreadMessageCount: () => ({ data: undefined }),
  useListStaffConversations: () => ({ data: [] }),
  getGetUnreadMessageCountQueryKey: () => ["/messages/unread"],
  getListStaffConversationsQueryKey: () => ["/staff/conversations"],
}));

import TabLayout from "@/app/(tabs)/_layout";

afterEach(() => {
  cleanup();
});

function setMe(me: Partial<typeof hooks.me>) {
  hooks.me = {
    data: undefined,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
    ...me,
  };
}

describe("profile gate after sign-in", () => {
  it("shows the brand loading screen (not a blank screen) while /api/me is in flight", () => {
    setMe({ isLoading: true, isFetching: true });
    const view = render(<TabLayout />);
    expect(view.queryByTestId("profile-loading-spinner")).toBeTruthy();
    expect(view.queryByTestId("tabs-root")).toBeNull();
  });

  it("shows the explanation and a retry when the profile call keeps failing", () => {
    setMe({ isError: true });
    const view = render(<TabLayout />);
    expect(view.queryByTestId("profile-error-message")).toBeTruthy();
    fireEvent.click(view.getByTestId("profile-error-retry"));
    expect(hooks.me.refetch).toHaveBeenCalledTimes(1);
  });

  it("returns to the loading state while the retry is in flight", () => {
    setMe({ isError: true, isFetching: true });
    const view = render(<TabLayout />);
    expect(view.queryByTestId("profile-loading-spinner")).toBeTruthy();
    expect(view.queryByTestId("profile-error-message")).toBeNull();
  });

  it("never lays out tabs before the role is known", () => {
    setMe({ isLoading: true, isFetching: true });
    const view = render(<TabLayout />);
    expect(view.queryByTestId("tabs-root")).toBeNull();
  });

  it("lays out tabs once the profile (with a workspace) arrives", () => {
    setMe({ data: { role: "cleaner", companyName: "Sparkle Co" } });
    const view = render(<TabLayout />);
    expect(view.queryByTestId("tabs-root")).toBeTruthy();
    expect(view.queryByTestId("profile-loading-spinner")).toBeNull();
  });
});
