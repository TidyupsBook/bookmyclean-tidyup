// @vitest-environment jsdom
/**
 * The launch gate leans on this to tell "signed out" apart from "can't reach
 * Clerk right now" — get it wrong and a dropped connection looks like a
 * sign-out and demands the password again.
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

type Handler = (status: string) => void;

const clerk = vi.hoisted(() => ({
  status: "loading" as string,
  handlers: [] as Handler[],
  on: vi.fn((_event: string, handler: Handler, opts?: { notify: boolean }) => {
    clerk.handlers.push(handler);
    if (opts?.notify) handler(clerk.status);
  }),
  off: vi.fn((_event: string, handler: Handler) => {
    clerk.handlers = clerk.handlers.filter((h) => h !== handler);
  }),
}));

vi.mock("@clerk/expo", () => ({ useClerk: () => clerk }));

import { isConnectionTrouble, useClerkStatus } from "./clerk-status";

describe("useClerkStatus", () => {
  it("tracks Clerk's connection status as it changes", () => {
    clerk.status = "loading";
    const { result, unmount } = renderHook(() => useClerkStatus());
    expect(result.current).toBe("loading");

    act(() => clerk.handlers.forEach((h) => h("ready")));
    expect(result.current).toBe("ready");

    act(() => clerk.handlers.forEach((h) => h("degraded")));
    expect(result.current).toBe("degraded");

    unmount();
    expect(clerk.handlers).toHaveLength(0);
  });
});

describe("isConnectionTrouble", () => {
  it("holds the user only when Clerk can't confirm the session", () => {
    expect(isConnectionTrouble("degraded")).toBe(true);
    expect(isConnectionTrouble("error")).toBe(true);
    expect(isConnectionTrouble("ready")).toBe(false);
    expect(isConnectionTrouble("loading")).toBe(false);
  });
});
