// @vitest-environment jsdom
/**
 * The onboarding page warns a new owner — before they create a company — that
 * setup will ask for their own Jobber account and Quo API key (Business plan
 * for transcripts). These tests pin that the panel shows only to logins that
 * can create a company, and that its signup links point at the shared
 * constants (so the Quo affiliate override keeps applying everywhere).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

function query(data?: unknown) {
  return { data, isLoading: false };
}
function mutation() {
  return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
}

let userFixture: Record<string, unknown> | undefined;

vi.mock("@workspace/api-client-react", () => ({
  useCreateCompany: mutation,
  useUpdateCompany: mutation,
  useGetCurrentUser: () => query(userFixture),
  useRequestToJoinCompany: mutation,
  useCancelJoinRequest: mutation,
  getGetCurrentUserQueryKey: () => ["/api/me"],
}));
vi.mock("@clerk/react", () => ({
  useUser: () => ({ user: { fullName: "Pat", primaryEmailAddress: null } }),
  useClerk: () => ({ signOut: vi.fn() }),
}));
vi.mock("wouter", () => ({
  useLocation: () => ["/onboarding", vi.fn()],
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { OnboardingPage } from "./onboarding";
import { QUO_SIGNUP_URL, JOBBER_SIGNUP_URL } from "@/lib/signupLinks";

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <OnboardingPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  userFixture = undefined;
});

describe("onboarding what-you'll-need panel", () => {
  it("shows the panel with Jobber and Quo signup links for new owners", () => {
    userFixture = { canCreateCompany: true };
    renderPage();
    expect(screen.getByTestId("panel-what-youll-need")).toBeInTheDocument();
    expect(screen.getByTestId("link-jobber-signup")).toHaveAttribute(
      "href",
      JOBBER_SIGNUP_URL,
    );
    expect(screen.getByTestId("link-quo-signup")).toHaveAttribute(
      "href",
      QUO_SIGNUP_URL,
    );
    // The Business-plan caveat is the part people can't discover mid-wizard.
    expect(screen.getByText(/Business plan/)).toBeInTheDocument();
  });

  it("hides the panel on single-company sites where owners can't create one", () => {
    userFixture = { canCreateCompany: false };
    renderPage();
    expect(
      screen.queryByTestId("panel-what-youll-need"),
    ).not.toBeInTheDocument();
  });

  it("hides the panel while a join request is pending approval", () => {
    userFixture = { canCreateCompany: true, pendingCompanyName: "Sparkle Co" };
    renderPage();
    expect(
      screen.queryByTestId("panel-what-youll-need"),
    ).not.toBeInTheDocument();
  });
});
