/**
 * The horizontal cleaner strip beside a map — one chip per active crew
 * member, like the old system's "Cleaner" row.
 *
 * Clicking a name jumps the map to that person (fresh GPS first, home
 * otherwise). The checkbox on each chip shows or hides only their live car
 * and trail; their home stays visible. The choice is saved locally per user
 * via the hook below, so it follows the owner around the app instead of
 * resetting on every page.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { useGetCurrentUser } from "@workspace/api-client-react";
import { colorForTeamMember } from "@/lib/mapMarkers";
import {
  buildRoster,
  hiddenCleanersKey,
  hiddenPinsKey,
  loadHiddenCleaners,
  loadRosterCollapsed,
  loadShowTrails,
  rosterCollapsedKey,
  saveHiddenCleaners,
  saveRosterCollapsed,
  saveShowTrails,
  showTrailsKey,
  toggleHidden,
  type RosterCleaner,
} from "@/lib/cleanerRoster";
import { ChevronDown, ChevronUp, Users } from "lucide-react";

/**
 * A locally-stored hide list, loaded per signed-in user and written back on
 * every change.
 *
 * Keyed by email rather than a numeric id because that's the stable identity
 * the current-user endpoint always carries. Until the user resolves the list
 * is read from the anonymous slot — worst case a brief flash of "everything
 * shown", never a silently hidden marker.
 */
function useHiddenSet(keyFor: (who: string) => string): {
  hidden: Set<number>;
  toggle: (id: number) => void;
  show: (id: number) => void;
  showAll: () => void;
  hideAll: (ids: Iterable<number>) => void;
} {
  const { data: me } = useGetCurrentUser();
  const key = keyFor(me?.email ?? "");
  const storage = typeof window === "undefined" ? null : window.localStorage;

  const [hidden, setHidden] = useState<Set<number>>(() =>
    loadHiddenCleaners(storage, key),
  );

  // The key changes once when sign-in resolves — re-read that user's list.
  useEffect(() => {
    setHidden(loadHiddenCleaners(storage, key));
    // storage identity is stable per environment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const toggle = (id: number) => {
    setHidden((prev) => {
      const next = toggleHidden(prev, id);
      saveHiddenCleaners(storage, key, next);
      return next;
    });
  };

  const show = (id: number) => {
    setHidden((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      saveHiddenCleaners(storage, key, next);
      return next;
    });
  };

  const showAll = () => {
    setHidden((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set<number>();
      saveHiddenCleaners(storage, key, next);
      return next;
    });
  };

  const hideAll = (ids: Iterable<number>) => {
    const next = new Set(ids);
    setHidden((prev) => {
      if (prev.size === next.size && [...next].every((id) => prev.has(id))) {
        return prev;
      }
      saveHiddenCleaners(storage, key, next);
      return next;
    });
  };

  return { hidden, toggle, show, showAll, hideAll };
}

/**
 * The owner's "draw the trails" switch, saved per user the same way.
 *
 * A plain on/off rather than a list, and defaulting to on: the trails were
 * there before this switch existed, so a user who has never touched it must
 * see exactly what they saw yesterday.
 */
export function useShowTrails(): {
  showTrails: boolean;
  setShowTrails: (show: boolean) => void;
} {
  const { data: me } = useGetCurrentUser();
  const key = showTrailsKey(me?.email ?? "");
  const storage = typeof window === "undefined" ? null : window.localStorage;

  const [showTrails, setShow] = useState<boolean>(() =>
    loadShowTrails(storage, key),
  );

  // The key changes once when sign-in resolves — re-read that user's choice.
  useEffect(() => {
    setShow(loadShowTrails(storage, key));
    // storage identity is stable per environment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const setShowTrails = (show: boolean) => {
    saveShowTrails(storage, key, show);
    setShow(show);
  };

  return { showTrails, setShowTrails };
}

/** The roster strip's live-location hide list (cars and trails, never homes). */
export function useHiddenCleaners(): {
  hidden: Set<number>;
  toggle: (teamMemberId: number) => void;
  show: (teamMemberId: number) => void;
  showAll: () => void;
  hideAll: (teamMemberIds: Iterable<number>) => void;
} {
  return useHiddenSet(hiddenCleanersKey);
}

/**
 * The saved-pin hide list. Same mechanics, separate storage slot: a pin id
 * and a team-member id can collide, and neither list may hide the other's
 * markers.
 */
export function useHiddenPins(): {
  hidden: Set<number>;
  toggle: (pinId: number) => void;
  show: (pinId: number) => void;
} {
  return useHiddenSet(hiddenPinsKey);
}

export function CleanerRoster({
  data,
  hidden,
  late,
  onToggle,
  onShowAll,
  onHideAll,
  onFocus,
  highlighted,
  onClearHighlight,
}: {
  data: Parameters<typeof buildRoster>[0] | undefined;
  hidden: Set<number>;
  /**
   * Cleaners whose live trail is projected to arrive after the booked time
   * (same rule as the map's ETA chips). Their chip turns amber with a "late"
   * tag so dispatch sees the slip without hovering anything.
   */
  late?: Set<number>;
  onToggle: (teamMemberId: number) => void;
  onShowAll: () => void;
  onHideAll: (teamMemberIds: Iterable<number>) => void;
  /**
   * Jump the map to this person. Only offered when we have coordinates —
   * unless `highlighted` is wired up, in which case a name click always
   * fires so the calendar can be filtered even for cleaners with no pin.
   */
  onFocus: (cleaner: RosterCleaner) => void;
  /**
   * When provided (even as null), name clicks also drive a calendar
   * highlight; the currently highlighted cleaner's chip is emphasized and a
   * "Show everyone" clear button appears.
   */
  highlighted?: number | null;
  onClearHighlight?: () => void;
}) {
  const roster = useMemo(() => buildRoster(data), [data]);
  const { data: me } = useGetCurrentUser();
  const storage = typeof window === "undefined" ? null : window.localStorage;
  const collapseKey = rosterCollapsedKey(me?.email ?? "");
  const [collapsed, setCollapsed] = useState(() =>
    loadRosterCollapsed(storage, collapseKey),
  );
  const rosterContentId = useId();

  useEffect(() => {
    setCollapsed(loadRosterCollapsed(storage, collapseKey));
    // storage identity is stable per environment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapseKey]);

  if (roster.length === 0) return null;
  const hiddenRosterCount = roster.filter((c) =>
    hidden.has(c.teamMemberId),
  ).length;
  const visibleCount = roster.length - hiddenRosterCount;
  const setRosterCollapsed = (next: boolean) => {
    saveRosterCollapsed(storage, collapseKey, next);
    setCollapsed(next);
  };

  return (
    <div className="bg-card border border-border rounded-xl shadow-sm px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground shrink-0">
            <Users className="w-3.5 h-3.5" />
            Cleaners
          </span>
          <span
            className="text-xs text-muted-foreground"
            aria-live="polite"
            data-testid="text-live-cleaner-count"
          >
            {visibleCount} of {roster.length} live shown
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={onShowAll}
            disabled={hiddenRosterCount === 0}
            className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="button-show-all-live"
          >
            Show all live
          </button>
          <button
            type="button"
            onClick={() => onHideAll(roster.map((c) => c.teamMemberId))}
            disabled={hiddenRosterCount === roster.length}
            className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="button-hide-all-live"
          >
            Hide all live
          </button>
          <button
            type="button"
            onClick={() => setRosterCollapsed(!collapsed)}
            aria-expanded={!collapsed}
            aria-controls={rosterContentId}
            className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            data-testid="button-toggle-cleaner-roster"
          >
            {collapsed ? "Show list" : "Hide list"}
            {collapsed ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronUp className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>
      <div
        id={rosterContentId}
        hidden={collapsed}
        className="flex items-center gap-2 flex-wrap pt-2"
      >
        {roster.map((c) => {
          const color = colorForTeamMember(c.teamMemberId, c.color);
          const visible = !hidden.has(c.teamMemberId);
          const highlightable = highlighted !== undefined;
          const isHighlighted = highlighted === c.teamMemberId;
          const isLate = late?.has(c.teamMemberId) ?? false;
          return (
            <span
              key={c.teamMemberId}
              className={[
                "inline-flex items-center gap-1.5 rounded-full border pl-1.5 pr-2.5 py-1 transition-opacity",
                isLate ? "bg-amber-500/15" : "bg-background/60",
                isHighlighted ? "border-2" : isLate ? "" : "border-border",
              ].join(" ")}
              style={
                isHighlighted
                  ? { borderColor: color }
                  : isLate
                    ? { borderColor: "rgb(245 158 11 / 0.7)" }
                    : undefined
              }
              data-testid={`chip-cleaner-${c.teamMemberId}`}
            >
              <input
                type="checkbox"
                checked={visible}
                onChange={() => onToggle(c.teamMemberId)}
                aria-label={`${visible ? "Hide" : "Show"} ${c.name}'s live location`}
                data-testid={`toggle-cleaner-${c.teamMemberId}`}
                className="h-3.5 w-3.5 accent-current cursor-pointer"
                style={{ color }}
              />
              <button
                type="button"
                onClick={() => (c.focus || highlightable) && onFocus(c)}
                disabled={!c.focus && !highlightable}
                title={
                  c.focus
                    ? c.focus.source === "live"
                      ? `Jump to ${c.name} — live now`
                      : `Jump to ${c.name}'s home`
                    : highlightable
                      ? `Highlight ${c.name}'s visits on the calendar — not on the map yet`
                      : `${c.name} isn't on the map yet — no address or GPS`
                }
                data-testid={`button-focus-cleaner-${c.teamMemberId}`}
                className={[
                  "inline-flex items-center gap-1.5 text-sm font-medium",
                  c.focus || highlightable
                    ? "text-foreground hover:underline underline-offset-2 cursor-pointer"
                    : "text-muted-foreground cursor-default",
                  isHighlighted ? "font-semibold" : "",
                ].join(" ")}
              >
                <span
                  aria-hidden="true"
                  className={[
                    "w-2.5 h-2.5 rounded-full shrink-0",
                    c.live ? "ring-2 ring-offset-1 ring-offset-card" : "",
                    visible ? "" : "opacity-35",
                  ].join(" ")}
                  style={{
                    background: color,
                    ...(c.live ? { ["--tw-ring-color" as any]: color } : {}),
                  }}
                />
                {c.name}
              </button>
              {isLate && (
                <span
                  className="text-[10px] font-bold uppercase tracking-wide text-amber-500"
                  title="Projected to arrive after the booked time"
                  data-testid={`tag-late-cleaner-${c.teamMemberId}`}
                >
                  late
                </span>
              )}
            </span>
          );
        })}
        {highlighted != null && onClearHighlight && (
          <button
            type="button"
            onClick={onClearHighlight}
            data-testid="button-clear-highlight"
            className="text-xs font-medium text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
          >
            Show everyone
          </button>
        )}
      </div>
    </div>
  );
}
