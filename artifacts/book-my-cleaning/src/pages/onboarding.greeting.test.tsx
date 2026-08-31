// @vitest-environment jsdom
/**
 * The onboarding greeting belongs to the address the visitor arrived on, not
 * to the build. cleaninghub.io runs the same code as bookmycleaning.net, and
 * until now both said "Welcome to Tidyups" — one company's name on a
 * stranger's signup page. These tests pin the contract:
 *
 * - on Tidyups' own site (server says company creation is closed here) the
 *   heading keeps saying "Welcome to Tidyups", exactly as before;
 * - on a signup address (company creation open) the heading is a neutral
 *   "Welcome" — no Tidyups anywhere on the page;
 * - once the new owner has typed their company's name, the heading greets
 *   them with that name instead;
 * - while /me is still loading, the heading is neutral on both sites — a
 *   beat of plain "Welcome" beats flashing Tidyups at a new owner.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Each test points /me at the fixture it wants before rendering.
let meData:
  { canCreateCompany: boolean; pendingCompanyName?: string } | undefined;

vi.mock("@workspace/api-client-react", () => ({
  useGetCurrentUser: () => ({ data: meData }),
  useCreateCompany: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useUpdateCompany: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useRequestToJoinCompany: () => ({ mutate: () => {}, isPending: false }),
  useCancelJoinRequest: () => ({ mutate: () => {}, isPending: false }),
  getGetCurrentUserQueryKey: () => ["/api/me"],
}));

vi.mock("@clerk/react", () => ({
  useUser: () => ({
    user: {
      fullName: "New Owner",
      primaryEmailAddress: { emailAddress: "owner@example.com" },
    },
  }),
  useClerk: () => ({ signOut: () => {} }),
}));

import { OnboardingPage } from "./onboarding";

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <OnboardingPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  meData = undefined;
});

describe("onboarding greeting", () => {
  it("keeps saying Welcome to Tidyups on Tidyups' own closed site", () => {
    meData = { canCreateCompany: false };
    renderPage();
    expect(screen.getByTestId("text-onboarding-greeting").textContent).toBe(
      "Welcome to Tidyups",
    );
  });

  it("greets neutrally on a signup address, with no Tidyups anywhere", () => {
    meData = { canCreateCompany: true };
    renderPage();
    expect(screen.getByTestId("text-onboarding-greeting").textContent).toBe(
      "Welcome",
    );
    expect(screen.queryByText(/Tidyups/)).toBeNull();
  });

  it("greets the owner with their own company name once they've typed it", () => {
    meData = { canCreateCompany: true };
    renderPage();
    fireEvent.change(screen.getByTestId("input-company-name"), {
      target: { value: "Sparkle Cleaners" },
    });
    expect(screen.getByTestId("text-onboarding-greeting").textContent).toBe(
      "Welcome, Sparkle Cleaners",
    );
  });

  it("stays neutral while /me is still loading, on either site", () => {
    meData = undefined;
    renderPage();
    expect(screen.getByTestId("text-onboarding-greeting").textContent).toBe(
      "Welcome",
    );
    expect(screen.queryByText(/Welcome to Tidyups/)).toBeNull();
  });
});
