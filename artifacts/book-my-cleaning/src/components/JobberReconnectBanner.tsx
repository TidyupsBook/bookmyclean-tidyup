import { Link, useLocation } from "wouter";
import { AlertTriangle } from "lucide-react";
import { useGetCompany } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";

/**
 * The one thing an owner must not be able to miss.
 *
 * When Jobber's authorization goes stale, every booking the office takes is
 * still saved and still looks fine — it just never reaches Jobber. The old
 * behaviour left that entirely to a small amber button on the Bookings page,
 * so a week could go by before anyone noticed nothing had synced.
 *
 * So: on every page, at the top, with no way to dismiss it. It is not noise —
 * it goes away by itself the moment the reconnect succeeds, and the only way
 * to make it go away is to fix the thing it is complaining about.
 *
 * Reads the company from the same query the shell already loaded, so this
 * costs no extra request and refreshes with everything else.
 */
export function JobberReconnectBanner() {
  const { data: company } = useGetCompany();
  const [location] = useLocation();

  if (!company?.jobberConnected || !company.jobberNeedsReauth) return null;

  // On the reconnect page itself the banner would be pointing at the button
  // right below it; the page makes the same case better.
  const onSettings = location === "/settings" || location === "/setup";

  return (
    <div
      className="border-b border-amber-800 bg-amber-950/70 px-4 py-3 md:px-6"
      data-testid="banner-jobber-reconnect"
    >
      <div className="max-w-7xl mx-auto flex flex-wrap items-center gap-x-3 gap-y-2">
        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
        <p className="text-sm text-amber-100 flex-1 min-w-[16rem]">
          <span className="font-semibold">
            Jobber authorization expired — new bookings are not reaching Jobber.
          </span>{" "}
          <span className="text-amber-200/80">
            They&apos;re still saved here. Reconnect, then sync anything from
            the Bookings page.
          </span>
        </p>
        {!onSettings && (
          <Link href="/settings">
            <Button
              size="sm"
              className="bg-amber-500 text-amber-950 hover:bg-amber-400"
              data-testid="button-jobber-reconnect"
            >
              Reconnect Jobber
            </Button>
          </Link>
        )}
      </div>
    </div>
  );
}
