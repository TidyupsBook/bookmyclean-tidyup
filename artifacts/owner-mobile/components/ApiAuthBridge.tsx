import React, { useEffect, useRef } from "react";
import { useAuth } from "@clerk/expo";
import { setAuthTokenGetter } from "@workspace/api-client-react";
import { createResilientTokenGetter } from "@/lib/auth-token";

type TokenGetter = ReturnType<typeof createResilientTokenGetter>;

// Ownership marker: cleanup must only clear the registration if it is still
// OURS. A replacement bridge registers synchronously during render, before
// the outgoing instance's passive cleanup runs — an unconditional
// setAuthTokenGetter(null) there would wipe the newcomer's getter and put
// every request back to unauthenticated.
let registeredGetter: TokenGetter | null = null;

function register(getter: TokenGetter): void {
  registeredGetter = getter;
  setAuthTokenGetter(getter);
}

/**
 * Attaches a Clerk bearer token to every generated API client request.
 *
 * On mobile there is no browser cookie jar, so this wiring must live above
 * EVERY routed screen — not just the tabs. A deep link (cold start from a
 * push notification, or a hard reload on web) mounts stack screens like
 * /calls or /leads without the tabs layout ever rendering; when this wiring
 * lived inside the tabs layout, those screens fired every request without
 * an Authorization header and 401'd forever, retries included.
 *
 * Registration must happen SYNCHRONOUSLY during render, before any child
 * screen mounts and fires its first query; a passive effect here would run
 * after child effects and let the first request go out unauthenticated.
 */
export function ApiAuthBridge({ children }: { children: React.ReactNode }) {
  const { getToken } = useAuth();
  // The registered getter must always call the LATEST getToken — Clerk hands
  // out a new function identity across renders, and a frozen closure would
  // keep minting tokens from a stale session.
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  // One stable getter per bridge instance, so ownership can be compared.
  const getterRef = useRef<TokenGetter | null>(null);
  if (getterRef.current === null) {
    getterRef.current = createResilientTokenGetter((options) =>
      getTokenRef.current(options),
    );
  }
  if (registeredGetter !== getterRef.current) register(getterRef.current);

  useEffect(() => {
    const mine = getterRef.current;
    if (mine === null) return;
    // Strict Mode replays cleanup+setup on mount; the replayed cleanup
    // cleared the registration, so setup must restore it.
    if (registeredGetter !== mine) register(mine);
    return () => {
      if (registeredGetter === mine) {
        registeredGetter = null;
        setAuthTokenGetter(null);
      }
    };
  }, []);

  return <>{children}</>;
}
