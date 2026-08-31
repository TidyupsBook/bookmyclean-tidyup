/**
 * Minimal mock for @clerk/react used by the badge e2e test.
 *
 * The test Vite config (vite.config.test.ts) aliases @clerk/react to this
 * file, so the real Clerk SDK never loads.  Every component and hook just
 * pretends the user is always signed in — there's nothing to stub at the
 * browser level.
 */

import { type ReactNode } from "react";

// ---------------------------------------------------------------------------
// Context/Provider
// ---------------------------------------------------------------------------

export function ClerkProvider({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

// ---------------------------------------------------------------------------
// Conditional render helpers
// ---------------------------------------------------------------------------

/** Always renders children — auth is "loaded" from the start. */
export function ClerkLoaded({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

/** Never renders — auth loads instantly with no delay. */
export function ClerkLoading() {
  return null;
}

/** Never renders — no auth failure. */
export function ClerkFailed() {
  return null;
}

/** Never renders. */
export function ClerkDegraded() {
  return null;
}

/**
 * Always renders the signed-in branch.
 * Fallback is ignored because `when="signed-in"` is always satisfied.
 */
export function Show({
  when,
  children,
  fallback,
}: {
  when: string;
  children?: ReactNode;
  fallback?: ReactNode;
}) {
  if (when === "signed-in") return <>{children}</>;
  if (when === "signed-out") return <>{fallback ?? null}</>;
  return <>{children}</>;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useAuth() {
  return {
    isLoaded: true,
    isSignedIn: true as const,
    userId: "user_e2e_badge",
    sessionId: "sess_e2e_badge",
    orgId: undefined as string | undefined,
    orgRole: undefined as string | undefined,
    orgSlug: undefined as string | undefined,
    has: () => false,
    getToken: () => Promise.resolve("e2e_badge_token"),
  };
}

export function useClerk() {
  return {
    session: {
      id: "sess_e2e_badge",
      getToken: () => Promise.resolve("e2e_badge_token"),
    },
    user: { id: "user_e2e_badge", firstName: "E2E", lastName: "Badge" },
    signOut: () => Promise.resolve(),
    addListener: () => () => {},
    removeListener: () => {},
    buildAfterSignOutUrl: () => "/",
    redirectToSignIn: () => {},
  };
}

export function useUser() {
  return {
    isLoaded: true,
    isSignedIn: true as const,
    user: {
      id: "user_e2e_badge",
      firstName: "E2E",
      lastName: "Badge",
      fullName: "E2E Badge",
      imageUrl: "",
      emailAddresses: [],
      primaryEmailAddressId: null,
    },
  };
}

export function useSession() {
  return {
    isLoaded: true,
    isSignedIn: true as const,
    session: {
      id: "sess_e2e_badge",
      getToken: () => Promise.resolve("e2e_badge_token"),
    },
  };
}

export function useSignIn() {
  return { isLoaded: true, signIn: null, setActive: () => Promise.resolve() };
}

export function useSignUp() {
  return { isLoaded: true, signUp: null, setActive: () => Promise.resolve() };
}

export function useOrganization() {
  return { isLoaded: true, organization: null };
}

export function useOrganizationList() {
  return {
    isLoaded: true,
    organizationList: [],
    setActive: () => Promise.resolve(),
  };
}

// ---------------------------------------------------------------------------
// Components that are never reached with a signed-in user
// ---------------------------------------------------------------------------

export const SignIn = () => null;
export const SignUp = () => null;
export const UserButton = () => null;
export const UserProfile = () => null;
export const GoogleOneTap = () => null;
export const OrganizationSwitcher = () => null;
export const OrganizationList = () => null;
export const OrganizationProfile = () => null;
export const CreateOrganization = () => null;
export const Waitlist = () => null;
export const OAuthConsent = () => null;
export const RedirectToSignIn = () => null;
export const RedirectToSignUp = () => null;
export const RedirectToUserProfile = () => null;
export const RedirectToCreateOrganization = () => null;
export const RedirectToOrganizationProfile = () => null;
export const RedirectToTasks = () => null;
export const AuthenticateWithRedirectCallback = () => null;
export const UserAvatar = () => null;
export const PricingTable = () => null;
export const APIKeys = () => null;
export const PaymentElement = () => null;
export const TaskChooseOrganization = () => null;
export const TaskResetPassword = () => null;
export const TaskSetupMFA = () => null;
export const PaymentElementProvider = ({
  children,
}: {
  children?: ReactNode;
}) => <>{children}</>;
export const UNSAFE_PortalProvider = ({
  children,
}: {
  children?: ReactNode;
}) => <>{children}</>;
export const MultisessionAppSupport = ({
  children,
}: {
  children?: ReactNode;
}) => <>{children}</>;
export const __experimental_CheckoutProvider = ({
  children,
}: {
  children?: ReactNode;
}) => <>{children}</>;

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

export class ClerkRuntimeError extends Error {
  code: string;
  constructor(message: string, options?: { code?: string }) {
    super(message);
    this.name = "ClerkRuntimeError";
    this.code = options?.code ?? "unknown";
  }
}

export const setClerkJSLoadingErrorPackageName = () => {};
export const setClerkJsLoadingErrorPackageName = () => {};
export const setErrorThrowerOptions = () => {};
export const inBrowser = () => typeof window !== "undefined";
export const deprecated = () => {};
export const normalizeWithDefaultValue = (v: unknown, d: unknown) => v ?? d;
export function safeExecute<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
export const assertSingleChild = () => {};
export const buildClerkJsScriptAttributes = () =>
  ({}) as Record<string, string>;
export const buildClerkJSScriptAttributes = () =>
  ({}) as Record<string, string>;
export const buildClerkUIScriptAttributes = () =>
  ({}) as Record<string, string>;
export const clerkJsScriptUrl = () => "";
export const clerkJSScriptUrl = () => "";
export const clerkUIScriptUrl = () => "";
export const useAPIKeys = () => ({ isLoaded: true });
export const useCheckout = () => ({ isLoaded: true });
export const useOAuthConsent = () => ({});
export const useDerivedAuth = () => useAuth();

/**
 * publishableKeyFromHost: just returns the env-var key.
 * The test runs on localhost so hostname-based lookup isn't meaningful.
 */
export const publishableKeyFromHost = (_hostname: string, envKey?: string) =>
  envKey ?? "pk_test_e2e_stub";
