// @vitest-environment jsdom
/**
 * The bearer-token wiring lives at the ROOT layout so every routed screen —
 * including stack screens reached by deep link (cold start from a push
 * notification, hard reload on web) — sends authenticated requests. These
 * tests pin the contract that moved it there: the getter is registered
 * before any child renders, always calls the latest Clerk getToken, and is
 * torn down on unmount.
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

const clerk = vi.hoisted(() => ({
  getToken: vi.fn(async () => "token-a") as (options?: unknown) => unknown,
}));
vi.mock("@clerk/expo", () => ({
  useAuth: () => ({ getToken: clerk.getToken }),
}));

const registered = vi.hoisted(() => ({
  getter: null as null | ((options?: unknown) => unknown),
  calls: [] as Array<unknown>,
}));
vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/api-client-react")>()),
  setAuthTokenGetter: (fn: ((options?: unknown) => unknown) | null) => {
    registered.getter = fn;
    registered.calls.push(fn);
  },
}));

// The resilience wrapper is plain logic tested on its own; pass the raw
// getter through so these tests observe exactly what the bridge registers.
vi.mock("@/lib/auth-token", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-token")>()),
  createResilientTokenGetter: (fn: (options?: unknown) => unknown) => fn,
}));

import { ApiAuthBridge } from "@/components/ApiAuthBridge";

afterEach(() => {
  cleanup();
  registered.getter = null;
  registered.calls = [];
});

describe("ApiAuthBridge", () => {
  it("registers the token getter before any child renders", () => {
    let getterAtChildRender: unknown = "never-rendered";
    function Child() {
      getterAtChildRender = registered.getter;
      return <div data-testid="child" />;
    }
    const { getByTestId } = render(
      <ApiAuthBridge>
        <Child />
      </ApiAuthBridge>,
    );
    expect(getByTestId("child")).toBeTruthy();
    expect(typeof getterAtChildRender).toBe("function");
  });

  it("always calls the latest getToken, not the one from first render", async () => {
    const { rerender } = render(<ApiAuthBridge>{null}</ApiAuthBridge>);
    const first = registered.getter;
    expect(first).toBeTypeOf("function");

    const fresh = vi.fn(async () => "token-b");
    clerk.getToken = fresh;
    rerender(<ApiAuthBridge>{null}</ApiAuthBridge>);

    await expect(first!({ skipCache: true })).resolves.toBe("token-b");
    expect(fresh).toHaveBeenCalledWith({ skipCache: true });
  });

  it("unregisters on unmount", () => {
    const { unmount } = render(<ApiAuthBridge>{null}</ApiAuthBridge>);
    expect(registered.getter).toBeTypeOf("function");
    unmount();
    expect(registered.calls[registered.calls.length - 1]).toBeNull();
  });

  it("survives Strict Mode's cleanup+setup replay with a live getter", () => {
    render(
      <React.StrictMode>
        <ApiAuthBridge>{null}</ApiAuthBridge>
      </React.StrictMode>,
    );
    // The replayed cleanup cleared the registration; effect setup must have
    // restored it, or every request after mount goes out unauthenticated.
    expect(registered.getter).toBeTypeOf("function");
  });

  it("outgoing bridge's cleanup never clears a replacement's registration", () => {
    const first = render(<ApiAuthBridge>{null}</ApiAuthBridge>);
    const getterA = registered.getter;
    const second = render(<ApiAuthBridge>{null}</ApiAuthBridge>);
    const getterB = registered.getter;
    expect(getterB).toBeTypeOf("function");
    expect(getterB).not.toBe(getterA);

    // The old instance unmounts AFTER the newcomer registered — its cleanup
    // must leave the newcomer's getter in place.
    first.unmount();
    expect(registered.getter).toBe(getterB);

    second.unmount();
    expect(registered.calls[registered.calls.length - 1]).toBeNull();
  });
});
