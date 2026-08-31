// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("expo-haptics", () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: "success" },
}));

const routerPush = vi.hoisted(() => vi.fn());

vi.mock("expo-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useRouter: () => ({ push: routerPush }),
}));

vi.mock("@/components/Brand", () => ({
  GradientFill: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  GradientRule: () => null,
  SparkleLogo: () => null,
}));

vi.mock("@/components/KeyboardAwareScrollViewCompat", () => ({
  KeyboardAwareScrollViewCompat: ({
    children,
  }: {
    children: React.ReactNode;
  }) => <div>{children}</div>,
}));

type ClerkResult = { error: { code?: string; message?: string } | null };
type FinalizeOptions = {
  navigate: (args: {
    session: { currentTask: null };
    decorateUrl: (path: string) => string;
  }) => void;
};

const signUp = vi.hoisted(() => {
  const call = () => vi.fn(async (): Promise<ClerkResult> => ({ error: null }));
  return {
    status: "missing_requirements" as string,
    unverifiedFields: ["email_address"] as string[],
    missingFields: [] as string[],
    password: call(),
    finalize: vi.fn(
      async (_options?: FinalizeOptions): Promise<ClerkResult> => ({
        error: null,
      }),
    ),
    verifications: {
      sendEmailCode: call(),
      verifyEmailCode: call(),
    },
  };
});

vi.mock("@clerk/expo", () => ({
  useAuth: () => ({ isSignedIn: false }),
  useSignUp: () => ({
    signUp,
    errors: { fields: {}, raw: null, global: null },
    fetchStatus: "idle",
  }),
}));

import SignUpScreen from "@/app/(auth)/sign-up";

beforeEach(() => {
  vi.clearAllMocks();
  signUp.status = "missing_requirements";
  signUp.unverifiedFields = ["email_address"];
  signUp.missingFields = [];
  signUp.verifications.verifyEmailCode.mockImplementation(async () => {
    signUp.status = "complete";
    return { error: null };
  });
  signUp.finalize.mockImplementation(async (options) => {
    options?.navigate({
      session: { currentTask: null },
      decorateUrl: () => "https://shared-preview.example/?__clerk_synced=true",
    });
    return { error: null };
  });
});

afterEach(cleanup);

describe("sign-up completion navigation", () => {
  it("keeps Clerk's decorated destination on the Expo preview origin", async () => {
    const screen = render(<SignUpScreen />);

    fireEvent.change(screen.getByTestId("code-input"), {
      target: { value: "424242" },
    });
    fireEvent.click(screen.getByTestId("verify-button"));

    await waitFor(() => expect(signUp.finalize).toHaveBeenCalledTimes(1));
    expect(routerPush).toHaveBeenCalledWith("/?__clerk_synced=true");
  });
});
