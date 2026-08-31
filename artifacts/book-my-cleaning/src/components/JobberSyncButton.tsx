/**
 * "Sync Jobber" — pull scheduled Jobber jobs onto our calendar and map now.
 *
 * The background sync already runs every ten minutes; this is for the owner
 * who just booked something in Jobber and wants to see it immediately. The
 * result is spelled out in plain counts rather than a silent success, because
 * "nothing happened" and "nothing needed to happen" look identical otherwise.
 *
 * When Jobber isn't connected the button stays on screen and becomes the way
 * in — hiding it until setup is done leaves an owner staring at an empty
 * calendar with no hint that their Jobber work could be on it.
 *
 * Each page passes its own `onSynced`, because the caches worth refreshing
 * after an import are the ones that page is showing.
 */
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  useSyncJobberCalendar,
  getGetCompanyQueryKey,
} from "@workspace/api-client-react";

export function JobberSyncButton({
  connected,
  needsReauth,
  onSynced,
  connectHint,
}: {
  connected: boolean;
  needsReauth: boolean;
  onSynced: () => void;
  /** What the owner gets out of connecting, in this page's terms. */
  connectHint: string;
}) {
  const { toast } = useToast();
  const sync = useSyncJobberCalendar();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();

  if (!connected || needsReauth) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setLocation("/settings")}
        data-testid="button-connect-jobber"
        title={
          needsReauth
            ? "Jobber needs signing in again before it can sync."
            : connectHint
        }
      >
        <RefreshCw className="w-4 h-4 mr-2" />
        {needsReauth ? "Reconnect Jobber" : "Connect Jobber"}
      </Button>
    );
  }

  const run = () => {
    sync.mutate(undefined, {
      onSuccess: (result) => {
        const bits: string[] = [];
        if (result.imported) bits.push(`${result.imported} new`);
        if (result.updated) bits.push(`${result.updated} updated`);
        if (result.canceled) bits.push(`${result.canceled} cancelled`);
        toast({
          title: "Jobber sync finished",
          description: bits.length
            ? `${bits.join(", ")}. New addresses get pinned once they're looked up.`
            : "Everything on your Jobber calendar was already here.",
        });
        onSynced();
      },
      onError: (error: any) => {
        // A stale grant flips jobberNeedsReauth on the server mid-request.
        // Refetch the company so this button turns into "Reconnect Jobber"
        // right away instead of failing identically on the next click.
        queryClient.invalidateQueries({ queryKey: getGetCompanyQueryKey() });
        toast({
          title: "Jobber sync failed",
          description:
            error?.data?.error ||
            error?.message ||
            "We couldn't reach Jobber. Try again in a moment.",
          variant: "destructive",
        });
      },
    });
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={run}
      disabled={sync.isPending}
      data-testid="button-sync-jobber"
    >
      <RefreshCw
        className={`w-4 h-4 mr-2 ${sync.isPending ? "animate-spin" : ""}`}
      />
      {sync.isPending ? "Syncing…" : "Sync Jobber"}
    </Button>
  );
}
