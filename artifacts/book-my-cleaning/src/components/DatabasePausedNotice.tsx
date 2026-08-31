import {
  useHealthCheck,
  getHealthCheckQueryKey,
} from "@workspace/api-client-react";
import { AlertCircle } from "lucide-react";

/**
 * The platform pauses idle production databases. When that happens every API
 * query fails, but the raw errors read as gibberish to an owner — and the
 * first they'd otherwise hear of it is a failed publish. The API's health
 * endpoint probes the database and classifies the paused-endpoint signature
 * (SQLSTATE 28000, "endpoint has been disabled"), so the dashboard can name
 * the actual fix in plain language.
 */
export function useDatabasePaused(): boolean {
  const { data } = useHealthCheck({
    query: {
      queryKey: getHealthCheckQueryKey(),
      // Health must stay fresh enough to catch a pause while the tab is
      // open, and to clear the warning promptly once the owner unpauses.
      refetchInterval: 30_000,
      staleTime: 0,
    },
  });
  return data?.database === "paused";
}

export function DatabasePausedNotice() {
  return (
    <div
      className="mb-8 bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-4"
      data-testid="notice-database-paused"
    >
      <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center shrink-0 mt-0.5">
        <AlertCircle className="w-5 h-5 text-red-600" />
      </div>
      <div>
        <h3 className="font-semibold text-red-900">
          Your production database is paused
        </h3>
        <p className="text-sm text-red-800 mt-1">
          The database has gone to sleep, so the app can't read or save anything
          — and publishing will fail until it's awake. Open the Database pane in
          Replit, unpause (enable) the database, then retry what you were doing.
        </p>
      </div>
    </div>
  );
}
