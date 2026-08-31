/**
 * The "Cleaners by distance" block inside a marker's info window — shared by
 * the Live Map and the Schedule & Map mini map so the two cards cannot drift
 * apart.
 *
 * Built as a string because Google's InfoWindow takes HTML, not React. Every
 * value that came from the database goes through `escapeHtml` — a customer
 * called `Smith & Sons <Ltd>` must not be able to write markup into the card.
 *
 * The whole crew is listed, nearest first, each name in the member's own
 * colour with the same two glyphs the map itself uses — a car for a phone
 * reporting in live, a house for the address on their staff card — so
 * clicking any address answers "who's closest" the same way the search
 * panels do, colours and all.
 *
 * The hide set only decorates: a hidden cleaner keeps their exact rank and
 * distance and gains a " · live hidden" label, because hiding someone's live
 * position is a display preference, not an availability filter.
 * Pinned by closestCrewCard.test.ts.
 */
import { formatDriveMinutes, formatKm, type NearbyCleaner } from "./nearest";
import { escapeHtml, carSvg, homeSvg } from "./mapMarkerDom";
import { colorForTeamMember } from "./mapMarkers";

/** The list scrolls past this height, so a big roster can't bury the card. */
const LIST_MAX_HEIGHT_PX = 200;

/** The same glyph the marker uses, in muted grey, sized for a 12px row. */
const sourceIcon = (source: NearbyCleaner["source"]): string =>
  `<span style="display:inline-flex;flex:none;color:#999">${
    source === "live" ? carSvg() : homeSvg()
  }</span>`;

export function closestCrewHtml(
  ranked: NearbyCleaner[],
  hiddenCleaners: Set<number>,
  actions: {
    /**
     * On the full Live Map, the distance row itself is a non-destructive
     * compare button. Its DOM owner binds it to the measurement overlay.
     */
    compare?: boolean;
    /**
     * Booking remains available to dispatch as a separate, explicit action.
     * It must never wrap the distance row: that was the accidental navigation
     * this map interaction was changed to prevent.
     */
    bookHref?: (cleaner: NearbyCleaner) => string | null;
  } = {},
): string {
  if (ranked.length === 0) return "";
  let hasBookAction = false;
  const rows = ranked
    .map((c, i) => {
      const color = colorForTeamMember(c.teamMemberId, c.color);
      const row = `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:12px;line-height:1.8">
          <span style="display:flex;align-items:center;gap:6px;min-width:0">
            <span style="width:9px;height:9px;border-radius:9999px;background:${color};flex:none"></span>
            <span data-crew-name style="color:${color};font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(
              c.name,
            )}</span>
            ${sourceIcon(c.source)}${
              // Ranked by geography regardless, but tell the dispatcher when
              // this person's live car and trail are switched off. Their home
              // still stays on the map as a planning reference.
              hiddenCleaners.has(c.teamMemberId)
                ? `<span style="color:#999;font-style:italic;flex:none"> · live hidden</span>`
                : ""
            }
          </span>
          <span style="white-space:nowrap;flex:none"><span style="font-weight:600;color:#111">${escapeHtml(
            formatKm(c.km),
          )}</span><span style="color:#777;font-size:11px"> · ${escapeHtml(
            formatDriveMinutes(c.km),
          )}</span>${
            i === 0 && ranked.length > 1
              ? `<span style="color:#999;font-size:11px"> (closest)</span>`
              : ""
          }</span>
        </div>`;
      const compareRow = actions.compare
        ? `<button type="button" data-crew-compare="${
            c.teamMemberId
          }" aria-label="Compare ${escapeHtml(
            c.name,
          )} with this address" style="display:block;flex:1;min-width:0;padding:0;border:0;background:transparent;text-align:inherit;color:inherit;cursor:pointer">${row}</button>`
        : row;
      const href = actions.bookHref?.(c) ?? null;
      if (!href) return compareRow;
      hasBookAction = true;
      return `<div style="display:flex;align-items:center;gap:6px">${compareRow}<a href="${escapeHtml(
        href,
      )}" data-crew-book="${c.teamMemberId}" aria-label="Book ${escapeHtml(
        c.name,
      )}" style="flex:none;padding:2px 7px;border:1px solid #2563eb;border-radius:5px;color:#2563eb;font-size:10px;font-weight:700;text-decoration:none">Book</a></div>`;
    })
    .join("");
  const actionHint =
    actions.compare && hasBookAction
      ? "Select a cleaner to compare, or use Book to start a booking."
      : actions.compare
        ? "Select a cleaner to draw this distance on the map."
        : hasBookAction
          ? "Use Book to start a booking with that cleaner assigned."
          : null;
  return `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #e5e5e5">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#888;margin-bottom:2px">Cleaners by distance</div>
      <div style="max-height:${LIST_MAX_HEIGHT_PX}px;overflow-y:auto">${rows}</div>
      <div style="display:flex;align-items:center;gap:4px;margin-top:5px;font-size:10px;color:#999">${sourceIcon(
        "live",
      )} live position · ${sourceIcon("home")} home address · straight-line</div>${
        actionHint
          ? `<div style="font-size:10px;color:#2563eb;margin-top:3px">${escapeHtml(
              actionHint,
            )}</div>`
          : ""
      }
    </div>`;
}
