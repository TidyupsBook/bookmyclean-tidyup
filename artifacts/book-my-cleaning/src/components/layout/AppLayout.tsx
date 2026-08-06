import { useGetCompany } from "@workspace/api-client-react";
import { Redirect, useLocation } from "wouter";
import { Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sidebar } from "./sidebar";

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

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { data: company, isLoading, error, refetch } = useGetCompany();

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
            We couldn't load your workspace
          </h1>
          <p className="text-sm text-muted-foreground">
            Your account and data are fine — the connection to the server
            dropped. Try again in a moment.
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
    <div className="flex min-h-screen w-full bg-background">
      <Sidebar company={company} />
      <main className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 p-6 md:p-8 lg:p-10 max-w-7xl mx-auto w-full">
          {children}
        </div>
      </main>
    </div>
  );
}
