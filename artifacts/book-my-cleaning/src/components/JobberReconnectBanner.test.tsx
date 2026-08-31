// @vitest-environment jsdom
/**
 * The reconnect banner is the office's only warning that bookings are being
 * saved but not reaching Jobber, so it has to be unconditional: every page,
 * no dismiss button, gone by itself once the connection is healthy. It must
 * also stay quiet for a company that simply doesn't use Jobber — a warning
 * that shows up for people it doesn't apply to gets ignored by the people it
 * does.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

type CompanyData =
  { jobberConnected?: boolean; jobberNeedsReauth?: boolean } | undefined;

let companyData: CompanyData;
let path = "/dashboard";

vi.mock("@workspace/api-client-react", () => ({
  useGetCompany: () => ({ data: companyData }),
}));

vi.mock("wouter", () => ({
  useLocation: () => [path, vi.fn()],
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { JobberReconnectBanner } from "./JobberReconnectBanner";

afterEach(() => {
  cleanup();
  companyData = undefined;
  path = "/dashboard";
});

describe("JobberReconnectBanner", () => {
  it("warns, with no way to dismiss it, when Jobber needs reconnecting", () => {
    companyData = { jobberConnected: true, jobberNeedsReauth: true };
    render(<JobberReconnectBanner />);

    const banner = screen.getByTestId("banner-jobber-reconnect");
    expect(banner).toHaveTextContent(/not reaching Jobber/i);
    expect(screen.getByTestId("button-jobber-reconnect")).toBeInTheDocument();
    // Nothing that closes it: the only exit is fixing the connection.
    expect(banner.querySelectorAll("button")).toHaveLength(1);
  });

  it("says nothing while the connection is healthy, or unused", () => {
    companyData = { jobberConnected: true, jobberNeedsReauth: false };
    render(<JobberReconnectBanner />);
    expect(screen.queryByTestId("banner-jobber-reconnect")).toBeNull();
    cleanup();

    companyData = { jobberConnected: false, jobberNeedsReauth: true };
    render(<JobberReconnectBanner />);
    expect(screen.queryByTestId("banner-jobber-reconnect")).toBeNull();
    cleanup();

    // Company not loaded yet: never guess.
    companyData = undefined;
    render(<JobberReconnectBanner />);
    expect(screen.queryByTestId("banner-jobber-reconnect")).toBeNull();
  });

  it("keeps warning on the reconnect page, but drops the button that leads there", () => {
    companyData = { jobberConnected: true, jobberNeedsReauth: true };
    path = "/settings";
    render(<JobberReconnectBanner />);

    expect(screen.getByTestId("banner-jobber-reconnect")).toBeInTheDocument();
    expect(screen.queryByTestId("button-jobber-reconnect")).toBeNull();
  });
});
