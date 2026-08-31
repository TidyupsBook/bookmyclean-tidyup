/**
 * The address box above a mini map: type or pick an address, get a
 * temporary pin and the closest crew — nothing is saved anywhere. Shared
 * between Schedule & Map and the Dashboard's "Find the nearest cleaner"
 * widget so both read the same ranking logic and never drift apart.
 */
import { useMemo, useState } from "react";
import { geocodeMapAddress } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import type { SearchTarget } from "@/components/MiniMap";
import { useToast } from "@/hooks/use-toast";
import { colorForTeamMember, hasCoords } from "@/lib/mapMarkers";
import { nearestCleaners, formatKm, formatDriveMinutes } from "@/lib/nearest";
import { Navigation, RefreshCw, X } from "lucide-react";

export function AddressLookup({
  mapData,
  target,
  onTarget,
  testIdPrefix = "schedule-map",
  placeholder = "Type an address to drop a pin and see who's closest",
}: {
  mapData: Parameters<typeof nearestCleaners>[1] | undefined;
  target: SearchTarget | null;
  onTarget: (t: SearchTarget | null) => void;
  testIdPrefix?: string;
  placeholder?: string;
}) {
  const { toast } = useToast();
  const [address, setAddress] = useState("");
  const [looking, setLooking] = useState(false);

  // Bias suggestions and geocoding toward wherever this company works.
  const bias = useMemo(() => {
    const anchor =
      (mapData?.cleaners ?? []).find(hasCoords) ??
      (mapData?.staffHomes ?? []).find(hasCoords);
    return anchor ? { lat: anchor.lat, lng: anchor.lng } : undefined;
  }, [mapData]);

  const ranked = useMemo(
    () => (target ? nearestCleaners(target, mapData ?? {}) : []),
    [target, mapData],
  );

  const look = async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed || looking) return;
    setLooking(true);
    try {
      const found = await geocodeMapAddress({
        address: trimmed,
        ...(bias ? { lat: bias.lat, lng: bias.lng } : {}),
      });
      if (!found.found || found.lat == null || found.lng == null) {
        toast({
          title: "Couldn't place that address",
          description:
            found.message ?? "We couldn't find that address on the map.",
          variant: "destructive",
        });
        return;
      }
      onTarget({ label: trimmed, lat: found.lat, lng: found.lng });
    } catch (error: any) {
      toast({
        title: "Couldn't place that address",
        description:
          error?.data?.error ||
          error?.message ||
          "We couldn't find that address on the map.",
        variant: "destructive",
      });
    } finally {
      setLooking(false);
    }
  };

  return (
    <div className="bg-card border border-border rounded-xl shadow-sm p-3 space-y-2">
      <div className="flex gap-2">
        <div className="flex-1 min-w-0">
          <AddressAutocomplete
            testId={`input-${testIdPrefix}-address`}
            value={address}
            onChange={setAddress}
            onSelect={look}
            bias={bias}
            disabled={looking}
            placeholder={placeholder}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => look(address)}
          disabled={looking || !address.trim()}
          className="gap-2 shrink-0"
          data-testid={`button-${testIdPrefix}-measure`}
        >
          {looking ? (
            <RefreshCw className="w-4 h-4 animate-spin" />
          ) : (
            <Navigation className="w-4 h-4" />
          )}
          {looking ? "Finding…" : "Check"}
        </Button>
        {target && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => onTarget(null)}
            aria-label="Clear the searched address"
            className="shrink-0"
          >
            <X className="w-4 h-4" />
          </Button>
        )}
      </div>

      {target && (
        <div
          className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"
          data-testid="row-closest-crew"
        >
          <span className="font-medium text-foreground">{target.label}:</span>
          {ranked.length === 0 ? (
            <span>
              No crew locations yet — add home addresses on the Team page.
            </span>
          ) : (
            ranked.slice(0, 4).map((c) => (
              <span key={c.teamMemberId} className="flex items-center gap-1.5">
                <span
                  className="w-2 h-2 rounded-full inline-block"
                  style={{
                    background: colorForTeamMember(c.teamMemberId, c.color),
                  }}
                />
                {c.name}
                {c.source === "live" ? " (on the move)" : ""} ·{" "}
                <span className="font-semibold text-foreground">
                  {formatKm(c.km)}
                </span>{" "}
                · {formatDriveMinutes(c.km)} drive
              </span>
            ))
          )}
        </div>
      )}
    </div>
  );
}
