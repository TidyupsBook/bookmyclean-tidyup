// @vitest-environment jsdom
/**
 * Signing in on a phone when Clerk wants more than the password: the app
 * collects the code itself instead of sending anyone to a computer, a wrong
 * code stays on the code screen with a way forward, and the session is only
 * finalized once nothing is outstanding.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

// --- Mocks: strip Expo-native modules ---------------------------------------

vi.mock("@expo/vector-icons", () => ({ Feather: () => null }));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("expo-haptics", () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: "success" },
}));

vi.mock("expo-web-browser", () => ({
  maybeCompleteAuthSession: vi.fn(),
  warmUpAsync: vi.fn(),
  coolDownAsync: vi.fn(),
}));

vi.mock("expo-auth-session", () => ({ makeRedirectUri: () => "bmc://" }));

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

// --- The Clerk sign-in resource --------------------------------------------

type Factor = { strategy: string; safeIdentifier?: string };

type ClerkResult = { error: { code?: string; message?: string } | null };
type FinalizeOptions = {
  navigate: (args: {
    session: { currentTask: null };
    decorateUrl: (path: string) => string;
  }) => void;
};

const signIn = vi.hoisted(() => {
  // Every Clerk sign-in call answers with the same {error} envelope.
  const call = () => vi.fn(async (): Promise<ClerkResult> => ({ error: null }));
  return {
    status: "needs_identifier" as string,
    supportedFirstFactors: [] as Factor[],
    supportedSecondFactors: [] as Factor[],
    password: call(),
    reset: call(),
    finalize: vi.fn(
      async (_options?: FinalizeOptions): Promise<ClerkResult> => ({
        error: null,
      }),
    ),
    emailCode: { sendCode: call(), verifyCode: call() },
    phoneCode: { sendCode: call(), verifyCode: call() },
    mfa: {
      sendEmailCode: call(),
      verifyEmailCode: call(),
      sendPhoneCode: call(),
      verifyPhoneCode: call(),
      verifyTOTP: call(),
      verifyBackupCode: call(),
    },
  };
});

vi.mock("@clerk/expo", () => ({
  useSignIn: () => ({
    signIn,
    errors: { fields: {}, raw: null, global: null },
    fetchStatus: "idle",
  }),
  useSSO: () => ({ startSSOFlow: vi.fn() }),
}));

import SignInScreen from "@/app/(auth)/sign-in";

/** Fills in the form and presses Sign in. */
async function signInWithPassword(
  screen: ReturnType<typeof render>,
): Promise<void> {
  fireEvent.change(screen.getByTestId("email-input"), {
    target: { value: "richard@crew.com" },
  });
  fireEvent.change(screen.getByTestId("password-input"), {
    target: { value: "hunter2" },
  });
  fireEvent.click(screen.getByTestId("sign-in-button"));
}

beforeEach(() => {
  signIn.status = "needs_identifier";
  signIn.supportedFirstFactors = [];
  signIn.supportedSecondFactors = [];
  vi.clearAllMocks();
  signIn.password.mockImplementation(async () => ({ error: null }));
  signIn.reset.mockResolvedValue({ error: null });
  signIn.finalize.mockResolvedValue({ error: null });
  for (const fn of [
    signIn.emailCode.sendCode,
    signIn.emailCode.verifyCode,
    signIn.phoneCode.sendCode,
    signIn.phoneCode.verifyCode,
    signIn.mfa.sendEmailCode,
    signIn.mfa.verifyEmailCode,
    signIn.mfa.sendPhoneCode,
    signIn.mfa.verifyPhoneCode,
    signIn.mfa.verifyTOTP,
    signIn.mfa.verifyBackupCode,
  ]) {
    fn.mockResolvedValue({ error: null });
  }
});

afterEach(cleanup);

describe("sign-in that needs a verification code", () => {
  it("asks for the code on the phone instead of naming the web dashboard", async () => {
    signIn.password.mockImplementation(async () => {
      signIn.status = "needs_client_trust";
      signIn.supportedSecondFactors = [
        { strategy: "email_code", safeIdentifier: "r***@crew.com" },
      ];
      return { error: null };
    });

    const screen = render(<SignInScreen />);
    await signInWithPassword(screen);

    await waitFor(() => screen.getByTestId("code-input"));
    expect(signIn.mfa.sendEmailCode).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/web dashboard/i)).toBeNull();
    expect(screen.getByText(/r\*\*\*@crew\.com/)).toBeTruthy();
    // Nothing is finalized until the outstanding step clears.
    expect(signIn.finalize).not.toHaveBeenCalled();
  });

  it("lands the user in the app once the code is accepted", async () => {
    signIn.password.mockImplementation(async () => {
      signIn.status = "needs_client_trust";
      signIn.supportedSecondFactors = [{ strategy: "email_code" }];
      return { error: null };
    });
    signIn.mfa.verifyEmailCode.mockImplementation(async () => {
      signIn.status = "complete";
      return { error: null };
    });
    signIn.finalize.mockImplementation(async (options) => {
      options?.navigate({
        session: { currentTask: null },
        decorateUrl: () =>
          "https://shared-preview.example/?__clerk_synced=true",
      });
      return { error: null };
    });

    const screen = render(<SignInScreen />);
    await signInWithPassword(screen);
    await waitFor(() => screen.getByTestId("code-input"));

    fireEvent.change(screen.getByTestId("code-input"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByTestId("verify-button"));

    await waitFor(() => expect(signIn.finalize).toHaveBeenCalledTimes(1));
    expect(signIn.mfa.verifyEmailCode).toHaveBeenCalledWith({ code: "123456" });
    expect(routerPush).toHaveBeenCalledWith("/?__clerk_synced=true");
  });

  it("keeps the code screen up with a clear retry when the code is wrong", async () => {
    signIn.password.mockImplementation(async () => {
      signIn.status = "needs_client_trust";
      signIn.supportedSecondFactors = [{ strategy: "email_code" }];
      return { error: null };
    });
    signIn.mfa.verifyEmailCode.mockResolvedValue({
      error: { code: "form_code_incorrect", message: "is incorrect" },
    });

    const screen = render(<SignInScreen />);
    await signInWithPassword(screen);
    await waitFor(() => screen.getByTestId("code-input"));

    fireEvent.change(screen.getByTestId("code-input"), {
      target: { value: "000000" },
    });
    fireEvent.click(screen.getByTestId("verify-button"));

    await waitFor(() => screen.getByText(/didn't match/i));
    // Still on the code step, with a way to get a fresh code.
    expect(screen.getByTestId("code-input")).toBeTruthy();
    expect(screen.getByTestId("resend-code-button")).toBeTruthy();
    expect(signIn.finalize).not.toHaveBeenCalled();
  });

  it("sends a fresh code on request", async () => {
    signIn.password.mockImplementation(async () => {
      signIn.status = "needs_client_trust";
      signIn.supportedSecondFactors = [{ strategy: "email_code" }];
      return { error: null };
    });

    const screen = render(<SignInScreen />);
    await signInWithPassword(screen);
    await waitFor(() => screen.getByTestId("code-input"));

    fireEvent.click(screen.getByTestId("resend-code-button"));
    await waitFor(() =>
      expect(signIn.mfa.sendEmailCode).toHaveBeenCalledTimes(2),
    );
    expect(screen.getByText(/new code sent/i)).toBeTruthy();
  });

  it("walks through a first-factor code and then MFA without stopping", async () => {
    signIn.password.mockImplementation(async () => {
      signIn.status = "needs_first_factor";
      signIn.supportedFirstFactors = [
        { strategy: "email_code", safeIdentifier: "r***@crew.com" },
      ];
      return { error: null };
    });
    signIn.emailCode.verifyCode.mockImplementation(async () => {
      signIn.status = "needs_second_factor";
      signIn.supportedSecondFactors = [{ strategy: "totp" }];
      return { error: null };
    });
    signIn.mfa.verifyTOTP.mockImplementation(async () => {
      signIn.status = "complete";
      return { error: null };
    });

    const screen = render(<SignInScreen />);
    await signInWithPassword(screen);
    await waitFor(() => expect(signIn.emailCode.sendCode).toHaveBeenCalled());

    fireEvent.change(screen.getByTestId("code-input"), {
      target: { value: "111111" },
    });
    fireEvent.click(screen.getByTestId("verify-button"));

    // The authenticator step takes over on the same screen — no dead end.
    await waitFor(() => screen.getByText("Open your authenticator app"));
    expect(screen.queryByTestId("resend-code-button")).toBeNull();

    fireEvent.change(screen.getByTestId("code-input"), {
      target: { value: "222222" },
    });
    fireEvent.click(screen.getByTestId("verify-button"));

    await waitFor(() => expect(signIn.finalize).toHaveBeenCalledTimes(1));
  });

  it("explains what to do when the step genuinely can't be finished here", async () => {
    signIn.password.mockImplementation(async () => {
      signIn.status = "needs_new_password";
      return { error: null };
    });

    const screen = render(<SignInScreen />);
    await signInWithPassword(screen);

    await waitFor(() => screen.getByText(/password has expired/i));
    expect(screen.queryByText(/web dashboard/i)).toBeNull();
    expect(screen.queryByTestId("code-input")).toBeNull();
  });

  it("lets the user back out to a different account", async () => {
    signIn.password.mockImplementation(async () => {
      signIn.status = "needs_client_trust";
      signIn.supportedSecondFactors = [{ strategy: "email_code" }];
      return { error: null };
    });

    const screen = render(<SignInScreen />);
    await signInWithPassword(screen);
    await waitFor(() => screen.getByTestId("code-input"));

    fireEvent.click(screen.getByTestId("start-over-button"));

    await waitFor(() => screen.getByTestId("password-input"));
    expect(signIn.reset).toHaveBeenCalledTimes(1);
  });

  it("survives the network dropping mid sign-in", async () => {
    signIn.password.mockRejectedValue(new Error("Network request failed"));

    const screen = render(<SignInScreen />);
    await signInWithPassword(screen);

    await waitFor(() => screen.getByText(/check your connection/i));
    expect(screen.getByTestId("password-input")).toBeTruthy();
  });
});
