import { useGetCompany } from "@workspace/api-client-react";
import { Redirect, useLocation } from "wouter";
import { Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sidebar } from "./sidebar";
import { LiveCallAlert } from "@/components/LiveCallAlert";
import { LiveCallBanner } from "@/components/LiveCallBanner";
import { NewMessageChime } from "@/components/NewMessageChime";
import { DeviceLocationReporter } from "@/components/DeviceLocationReporter";
import { LocationPermissionAsk } from "@/components/LocationPermissionAsk";
import { CallAlertsAsk } from "@/components/CallAlertsAsk";
import { useDatabasePaused } from "@/components/DatabasePausedNotice";
import { JobberReconnectBanner } from "@/components/JobberReconnectBanner";
import { ScrollToTopButton } from "@/components/ScrollToTopButton";
import { LiveBookingButton } from "@/components/LiveBookingButton";
import { useCornerOwner } from "@/lib/cornerStack";
import { cn } from "@/lib/utils";

/**
 * A 404 from `/company` is the real "you have no workspace yet" signal. Any
 * other failure — a restart, a dropped connection, a 500 — means we simply
 * don't know yet, and must NOT be treated the same way: sending an existing
 * owner to onboarding invites them to create a second, empty company and
 * lose sight of the real one.
 */
function isNoCompany(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status: unknown }).status === 404
  );
}

export function AppLayout({
  children,
  wide = false,
}: {
  children: React.ReactNode;
  /** Lets data-heavy pages use the full desktop workspace without widening every page. */
  wide?: boolean;
}) {
  const [location] = useLocation();
  const { data: company, isLoading, error, refetch } = useGetCompany();
  // One shared answer to "who gets the bottom-right corner?", read here so
  // the back-to-top button can queue around the launcher and the bar.
  const corner = useCornerOwner();
  // A paused production database makes every query fail, including the
  // company load above — so the generic "connection dropped" screen would be
  // the only thing an owner ever sees. The health endpoint doesn't need the
  // database to respond, so it can name the real cause.
  const databasePaused = useDatabasePaused();

  if (isLoading) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  if (error && isNoCompany(error) && location !== "/onboarding") {
    return <Redirect to="/onboarding" />;
  }

  if (error && !isNoCompany(error)) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background p-6">
        <div className="max-w-sm text-center space-y-4">
          <AlertCircle className="w-8 h-8 text-destructive mx-auto" />
          <h1 className="text-lg font-semibold">
            {databasePaused
              ? "Your production database is paused"
              : "We couldn't load your workspace"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {databasePaused
              ? "The database has gone to sleep, so nothing can load. Open the Database pane in Replit, unpause (enable) the database, then try again."
              : "Your account and data are fine — the connection to the server dropped. Try again in a moment."}
          </p>
          <Button
            onClick={() => void refetch()}
            data-testid="button-retry-load"
          >
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (
    company &&
    !company.setupStatus.accountCreated &&
    location !== "/onboarding"
  ) {
    return <Redirect to="/onboarding" />;
  }

  if (location === "/onboarding") {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-screen w-full overflow-x-hidden bg-background">
      {/* Watches for a ringing phone from every page, not just the Calls tab. */}
      <LiveCallAlert />
      {/* Sounds for a new message while you're looking at another screen. */}
      <NewMessageChime />
      {/* This browser reports itself as a device (once switched on from the
          Tracking page), from every page rather than only that one. */}
      <DeviceLocationReporter />
      {/* Asks this browser, once ever, whether it should join the crew map. */}
      <LocationPermissionAsk />
      {/* Asks this computer, once ever, to pop up when the phone rings —
          the only alert that reaches someone in another window. */}
      <CallAlertsAsk />
      <Sidebar company={company} />
      <main className="flex-1 flex flex-col min-w-0">
        {/* Above everything, on every page: bookings silently not reaching
            Jobber is not something to find out about later. */}
        <JobberReconnectBanner />
        {/* Left-aligned, not centred: on a wide screen `mx-auto` floated the
            page away from the sidebar, so every heading started a couple of
            hundred pixels right of the menu it belongs to. The max width still
            keeps lines readable. */}
        <div
          className={cn(
            "flex-1 p-6 md:p-8 lg:p-10 w-full",
            wide ? "max-w-none" : "max-w-7xl",
          )}
          data-layout-width={wide ? "wide" : "default"}
        >
          {children}
        </div>
      </main>
      {/* Stays on screen for the length of the call, unlike a toast. */}
      <LiveCallBanner />
      {/* The always-there route into the booking desk — the only one at
          phone widths, where the sidebar is hidden. Blinks for a ringing
          call or one still waiting to be booked. */}
      <LiveBookingButton />
      {/* Long lists (bookings, calls, messages) get a one-click way back up. */}
      <ScrollToTopButton corner={corner} />
    </div>
  );
}
