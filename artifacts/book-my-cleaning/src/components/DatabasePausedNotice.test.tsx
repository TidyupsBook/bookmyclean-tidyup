// @vitest-environment jsdom
/**
 * The paused-database notice must appear exactly when the health endpoint
 * classifies the database as "paused" — not for ordinary errors, and not
 * once the database is awake again. These tests pin useDatabasePaused to
 * that contract and check the notice itself names the fix.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, renderHook, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

type HealthData = { status: string; database: string } | undefined;
let healthData: HealthData;

vi.mock("@workspace/api-client-react", () => ({
  useHealthCheck: () => ({ data: healthData }),
  getHealthCheckQueryKey: () => ["/api/healthz"],
}));

import {
  DatabasePausedNotice,
  useDatabasePaused,
} from "./DatabasePausedNotice";

afterEach(() => {
  cleanup();
  healthData = undefined;
});

describe("useDatabasePaused", () => {
  it("is true only when the health endpoint reports database paused", () => {
    healthData = { status: "ok", database: "paused" };
    expect(renderHook(() => useDatabasePaused()).result.current).toBe(true);

    // An ordinary database failure is NOT a pause — the notice would name
    // the wrong fix.
    healthData = { status: "ok", database: "error" };
    expect(renderHook(() => useDatabasePaused()).result.current).toBe(false);

    healthData = { status: "ok", database: "ok" };
    expect(renderHook(() => useDatabasePaused()).result.current).toBe(false);

    // Health not loaded yet: never assume paused.
    healthData = undefined;
    expect(renderHook(() => useDatabasePaused()).result.current).toBe(false);
  });

  it("clears once the database reports healthy again", () => {
    healthData = { status: "ok", database: "paused" };
    const { result, rerender } = renderHook(() => useDatabasePaused());
    expect(result.current).toBe(true);

    healthData = { status: "ok", database: "ok" };
    rerender();
    expect(result.current).toBe(false);
  });
});

describe("DatabasePausedNotice", () => {
  it("names the paused database and the fix in plain language", () => {
    render(<DatabasePausedNotice />);
    const notice = screen.getByTestId("notice-database-paused");
    expect(notice).toHaveTextContent("Your production database is paused");
    expect(notice).toHaveTextContent(/unpause \(enable\) the database/i);
  });
});
