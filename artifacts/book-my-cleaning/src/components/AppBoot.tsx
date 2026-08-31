import {
  Component,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";

import { describeStartupError, markAppReady } from "@/lib/appShell";

/**
 * The screens the app shows before it has anything else to show: the handoff
 * from the static shell, the wait while auth boots, and the two ways startup
 * can fail.
 *
 * Everything here is built from plain elements on purpose. These are the
 * fallbacks of last resort, so they must not depend on a module that could
 * itself be part of whatever broke.
 */

/** How long a boot can take before we stop implying it is about to finish. */
const SLOW_BOOT_MS = 8000;

const SUPPORT_PHONE = "(780) 718-5092";
const SUPPORT_PHONE_HREF = "tel:+17807185092";

/**
 * Dismisses the static marketing shell — but only once React has rendered
 * something into `#root`.
 *
 * Renders nothing itself. The check runs after every commit until it succeeds,
 * because the first commit does not always paint: a route that immediately
 * redirects renders `null`, and the real page only lands on the next one. If
 * the app never renders anything, the shell simply stays up and the visitor
 * keeps looking at a marketing page instead of a blank window.
 */
export function AppShellHandoff() {
  const handedOff = useRef(false);

  // Layout effect, not a passive one: the DOM is committed but the browser has
  // not painted yet, so the shell disappears in the same frame the app appears
  // — no flash of an empty page, no moment with both on screen.
  useLayoutEffect(() => {
    if (handedOff.current) return;
    handedOff.current = markAppReady();
  });

  return null;
}

function Spinner({ className = "" }: { className?: string }) {
  return (
    <Loader2
      aria-hidden="true"
      className={`animate-spin text-brand-pink ${className}`}
    />
  );
}

/**
 * Full-page "we're starting" state. Shown while auth boots so that a slow
 * handshake reads as work in progress rather than a broken page — and says so
 * out loud once it has been slow for long enough to be suspicious.
 */
export function AppLoadingScreen({
  label = "Getting things ready…",
}: {
  label?: string;
}) {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), SLOW_BOOT_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-background px-6 text-center"
    >
      <Spinner className="h-8 w-8" />
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      {slow && (
        <p className="max-w-sm text-sm text-muted-foreground/80">
          This is taking longer than usual. Sign-in can be blocked inside an
          embedded preview — try opening the site in its own browser tab, or
          call {SUPPORT_PHONE}.
        </p>
      )}
    </div>
  );
}

/**
 * Full-page failure state: a readable explanation plus the two things a
 * visitor can actually do about it.
 */
export function AppStatusScreen({
  title,
  message,
  detail,
}: {
  title: string;
  message: string;
  detail?: string;
}) {
  return (
    <div
      role="alert"
      className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-background px-6 text-center"
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
        <AlertTriangle aria-hidden="true" className="h-6 w-6 text-amber-400" />
      </div>
      <h1 className="font-serif text-2xl font-extrabold tracking-tight text-foreground">
        {title}
      </h1>
      <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
        {message}
      </p>
      {detail && (
        <p className="max-w-md break-words font-mono text-xs text-muted-foreground/70">
          {detail}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-2 rounded-full brand-gradient px-5 py-2.5 text-sm font-bold text-white"
        >
          <RefreshCw aria-hidden="true" className="h-4 w-4" /> Reload the page
        </button>
        <a
          href={SUPPORT_PHONE_HREF}
          className="rounded-full border border-border px-5 py-2.5 text-sm font-semibold text-foreground hover:bg-secondary/50"
        >
          Call {SUPPORT_PHONE}
        </a>
      </div>
    </div>
  );
}

/** Inline placeholder where a Clerk widget will appear once it has loaded. */
export function AuthLoadingPanel({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex w-full flex-col items-center justify-center gap-3 rounded-2xl border border-border bg-card px-6 py-16"
    >
      <Spinner className="h-6 w-6" />
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}

/** Inline stand-in for a Clerk widget that will never arrive. */
export function AuthUnavailablePanel() {
  return (
    <div
      role="alert"
      className="flex w-full flex-col items-center gap-3 rounded-2xl border border-border bg-card px-6 py-12 text-center"
    >
      <AlertTriangle aria-hidden="true" className="h-6 w-6 text-amber-400" />
      <h2 className="font-serif text-lg font-bold text-foreground">
        Sign-in can&apos;t load right now
      </h2>
      <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
        The sign-in service didn&apos;t respond. Some browsers block it inside
        an embedded preview — opening the site in its own tab usually fixes it.
        You can also call {SUPPORT_PHONE} and we&apos;ll book you in.
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-1 inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm font-semibold text-foreground hover:bg-secondary/50"
      >
        <RefreshCw aria-hidden="true" className="h-4 w-4" /> Try again
      </button>
    </div>
  );
}

/**
 * Last line of defence around the whole tree. A throw anywhere in the app used
 * to leave an empty document in production (the dev-only overlay does not ship
 * in a build); now it leaves a page the visitor can read and act on.
 */
export class AppErrorBoundary extends Component<
  { children: ReactNode },
  { error: unknown }
> {
  state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // Keep the real failure debuggable.
    console.error(
      "[AppErrorBoundary] app crashed:",
      error,
      info.componentStack,
    );
  }

  render() {
    if (this.state.error) {
      return (
        <>
          {/* The shell would otherwise sit on top of this message. */}
          <AppShellHandoff />
          <AppStatusScreen
            title="Something went wrong"
            message="The app hit an unexpected error and stopped. Reloading usually clears it — if it doesn't, give us a call and we'll sort it out."
            detail={describeStartupError(this.state.error)}
          />
        </>
      );
    }
    return this.props.children;
  }
}
