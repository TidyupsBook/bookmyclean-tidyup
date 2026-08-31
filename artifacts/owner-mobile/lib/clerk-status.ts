/**
 * Subscribes to Clerk's connection status.
 *
 * `useAuth().isSignedIn` alone can't tell "nobody is signed in" apart from
 * "we can't reach Clerk right now". This exposes the difference so the app
 * holds a signed-in person on a reconnect screen instead of bouncing them
 * back to sign-in over a dropped connection.
 */
import { useEffect, useState } from "react";
import { useClerk } from "@clerk/expo";

export type ClerkConnectionStatus = "loading" | "ready" | "degraded" | "error";

export function useClerkStatus(): ClerkConnectionStatus {
  const clerk = useClerk();
  const [status, setStatus] = useState<ClerkConnectionStatus>(
    (clerk?.status as ClerkConnectionStatus) ?? "loading",
  );

  useEffect(() => {
    if (!clerk?.on) return;
    const handler = (next: ClerkConnectionStatus) => setStatus(next);
    clerk.on("status", handler, { notify: true });
    return () => clerk.off?.("status", handler);
  }, [clerk]);

  return status;
}

/** True while Clerk can't confirm anything about the stored session. */
export function isConnectionTrouble(status: ClerkConnectionStatus): boolean {
  return status === "degraded" || status === "error";
}
