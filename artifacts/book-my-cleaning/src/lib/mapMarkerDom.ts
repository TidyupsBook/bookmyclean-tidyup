/**
 * The DOM/HTML builders shared by the Live Map and the Schedule & Map mini
 * map: marker elements, the little SVGs inside them, and the escaping that
 * keeps customer- and staff-entered text from becoming markup in an info
 * window. No React and no Maps SDK — just document.createElement and strings.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A "Directions" link for an info window — opens Google Maps navigation to
 * the address (falling back to the exact coordinates when there is none).
 */
export function directionsHtml(
  address: string | null | undefined,
  lat: number,
  lng: number,
): string {
  const dest = address && address.trim() ? address.trim() : `${lat},${lng}`;
  const url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
  return `<div style="margin-top:6px"><a href="${escapeHtml(url)}" target="_blank" rel="noopener" style="font:600 12px sans-serif;color:#2563eb;text-decoration:none">Directions&nbsp;&rarr;</a></div>`;
}

/**
 * The "Edit in Bookings" link for a job's info window. It must carry the
 * booking hash — the Bookings page scrolls to and highlights the matching
 * card off `#booking-<id>`, and a bare /bookings link silently loses the job
 * the dispatcher was looking at.
 */
export function editInBookingsHtml(bookingId: number): string {
  return `<div style="margin-top:4px"><a href="/bookings#booking-${bookingId}" style="font:600 12px sans-serif;color:#2563eb;text-decoration:none">Edit in Bookings&nbsp;&rarr;</a></div>`;
}

/**
 * A map pin: the teardrop everyone recognises, pointing at its address.
 *
 * The outer element stays upright (so a badge pinned to its corner doesn't come
 * out sideways) and only the drop itself is rotated. The marker anchors on the
 * bottom of its content, which is exactly where the point is.
 */
export function pinMarker(
  color: string,
  badgeText?: string | number,
): HTMLDivElement {
  const el = document.createElement("div");
  // 26px square + the 6px its rotated corner sticks out below, so the bottom
  // of the content — which is what the marker anchors on — lands on the tip.
  el.style.cssText = `position:relative;width:26px;height:32px;`;
  const drop = document.createElement("div");
  // The square corner is bottom-LEFT, so the rotation has to be anticlockwise
  // to bring it to the bottom. Rotating the other way points the pin sideways,
  // at a house half a block west of the one it means.
  drop.style.cssText = `position:absolute;left:0;top:0;width:26px;height:26px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;`;
  const dot = document.createElement("div");
  dot.style.cssText = `width:9px;height:9px;border-radius:9999px;background:#fff;`;
  drop.appendChild(dot);
  el.appendChild(drop);
  if (badgeText !== undefined) {
    const badge = document.createElement("div");
    badge.style.cssText = `position:absolute;top:-9px;right:-11px;min-width:20px;height:20px;padding:0 4px;border-radius:9999px;background:#fff;color:${color};border:2px solid ${color};box-shadow:0 1px 4px rgba(0,0,0,.4);font:800 10px/16px "Plus Jakarta Sans",sans-serif;text-align:center;z-index:2;`;
    badge.textContent = String(badgeText);
    el.appendChild(badge);
  }
  return el;
}

/**
 * A dispatcher-created waypoint: a numbered flag on a pole.
 *
 * It deliberately shares no silhouette with the map's other two important
 * meanings. Cleaners are circles containing a car/home, and client properties
 * are teardrops. A flag always means "a place dispatch added or is planning".
 */
export function waypointMarker(
  color: string,
  badgeText: string | number,
): HTMLDivElement {
  const el = document.createElement("div");
  el.dataset.markerKind = "waypoint";
  el.style.cssText =
    "position:relative;width:38px;height:44px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.38));";

  const pole = document.createElement("div");
  pole.style.cssText =
    "position:absolute;left:8px;top:5px;width:3px;height:35px;border-radius:9999px;background:#fff;border:1px solid rgba(15,23,42,.45);";

  const flag = document.createElement("div");
  flag.style.cssText = `position:absolute;left:10px;top:3px;min-width:28px;height:25px;padding:0 7px 0 6px;display:flex;align-items:center;justify-content:center;background:${color};color:#fff;border:2px solid #fff;border-left-width:1px;border-radius:3px 4px 4px 1px;clip-path:polygon(0 0,100% 0,82% 50%,100% 100%,0 100%);font:800 11px/20px "Plus Jakarta Sans",sans-serif;letter-spacing:-.02em;white-space:nowrap;`;
  flag.textContent = String(badgeText);

  const foot = document.createElement("div");
  foot.style.cssText = `position:absolute;left:4px;bottom:0;width:12px;height:6px;border-radius:9999px;background:${color};border:2px solid #fff;`;

  el.append(pole, flag, foot);
  return el;
}

/**
 * The "this is the one you asked for" tag: a small white box riding above the
 * focused pin with the address written inside. Every other job pin is a bare
 * teardrop, so the one wearing its own address is unmistakably the pin the
 * dispatcher clicked through to from a booking.
 *
 * textContent on purpose — the address is customer-typed text and must never
 * be parsed as markup.
 */
export function focusAddressTag(
  address: string | null,
  name: string,
): HTMLDivElement {
  const tag = document.createElement("div");
  tag.style.cssText = `position:absolute;bottom:38px;left:50%;transform:translateX(-50%);width:max-content;max-width:220px;padding:4px 8px;border-radius:6px;background:#fff;color:#111;border:2px solid hsl(330,81%,55%);box-shadow:0 2px 6px rgba(0,0,0,.35);font:600 11px/1.35 sans-serif;text-align:center;z-index:2;`;
  tag.textContent = address || name;
  // A short stem tying the box to its pin, so it can't read as a label for
  // some neighbouring marker.
  const stem = document.createElement("div");
  stem.style.cssText = `position:absolute;top:100%;left:50%;transform:translateX(-50%);width:2px;height:8px;background:hsl(330,81%,55%);`;
  tag.appendChild(stem);
  return tag;
}

/**
 * The measure tool's colour — a teal that belongs to nothing else on the map.
 *
 * Job pins are pink, saved pins purple, the searched address sky blue and the
 * crew wear their own roster colours, so a measurement has to sit outside all
 * of them: it is a scratch overlay, not another thing that lives here.
 */
export const MEASURE_COLOR = "hsl(173,80%,32%)";

/**
 * One end of a measurement: a small teal disc with A or B in it.
 *
 * Deliberately not a teardrop and not a disc with initials — the two shapes
 * that already mean "a place" and "a person". Nothing has been saved, and the
 * marker should not look like it has.
 */
export function measureEndpoint(letter: string): HTMLDivElement {
  const el = document.createElement("div");
  el.style.cssText = `width:22px;height:22px;border-radius:9999px;display:flex;align-items:center;justify-content:center;background:${MEASURE_COLOR};color:#fff;border:2px dashed #fff;box-shadow:0 1px 5px rgba(0,0,0,.45);font:800 11px/1 "Plus Jakarta Sans",sans-serif;`;
  el.textContent = letter;
  return el;
}

/**
 * The chip riding the middle of a measured line. Unclickable on purpose, so
 * it never steals a click meant for the pin underneath it.
 */
export function measureChip(text: string): HTMLDivElement {
  const chip = document.createElement("div");
  chip.style.cssText = `pointer-events:none;padding:2px 8px;border-radius:9999px;background:#fff;color:${MEASURE_COLOR};border:1.5px solid ${MEASURE_COLOR};font:700 11px/16px "Plus Jakarta Sans",sans-serif;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.35);`;
  chip.textContent = text;
  return chip;
}

/**
 * A name short enough to sit above a marker without covering the next street.
 *
 * First name plus a last initial: enough to tell two cleaners apart, which is
 * the whole job of the label.
 */
export function shortName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]!;
  const rest = parts[parts.length - 1]!;
  return parts.length > 1 ? `${first} ${rest[0]!.toUpperCase()}.` : first;
}

export function carSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 17h2v-4l-2.6-5.2A2 2 0 0 0 16.6 7H7.4a2 2 0 0 0-1.8 1.1L3 13v4h2"/><circle cx="7.5" cy="17" r="2"/><circle cx="16.5" cy="17" r="2"/><path d="M9.5 17h5"/></svg>`;
}

export function crosshairSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/></svg>`;
}

/**
 * The office marker's colour — a deep slate blue that belongs to nothing else
 * on the map. Crew wear roster colours, jobs are pink, saved pins purple, the
 * searched address sky blue and measurements teal; the shop needs its own ink.
 */
export const OFFICE_COLOR = "hsl(222,45%,38%)";

export function buildingSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01"/><path d="M16 6h.01"/><path d="M12 6h.01"/><path d="M12 10h.01"/><path d="M8 10h.01"/><path d="M16 10h.01"/><path d="M12 14h.01"/><path d="M8 14h.01"/><path d="M16 14h.01"/></svg>`;
}

/**
 * The office: a rounded SQUARE with a building in it, its name on a tag
 * above. Deliberately neither of the two shapes already in use — not the
 * disc that means "a person on the move" and not the teardrop that means "a
 * client address" — because it is a third kind of thing: the shop itself,
 * parked on its stored spot for good.
 */
export function officeMarker(label: string): HTMLDivElement {
  const el = document.createElement("div");
  el.style.cssText = `display:flex;flex-direction:column;align-items:center;gap:2px;`;

  const tag = document.createElement("div");
  tag.style.cssText = `padding:0 6px;border-radius:9px;background:#fff;color:${OFFICE_COLOR};border:1px solid ${OFFICE_COLOR};font:700 10px/16px "Plus Jakarta Sans",sans-serif;white-space:nowrap;max-width:130px;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 3px rgba(0,0,0,.35);`;
  // textContent, never markup — the device name is user input.
  tag.textContent = label;

  const box = document.createElement("div");
  box.style.cssText = `width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;background:${OFFICE_COLOR};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);`;
  box.innerHTML = buildingSvg();

  el.append(tag, box);
  return el;
}

export function homeSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;
}

/**
 * The crew badge row that rides above a job pin: one coloured disc per
 * assigned cleaner (up to `max`), each showing initials in a contrasting ink,
 * followed by a "+N" overflow pill when there are more than `max` assignees.
 *
 * An unassigned job returns `null` — callers should skip appending entirely so
 * a bare pink pin keeps its "nobody yet" meaning.
 *
 * Ink is already resolved in each chip (see `crewChipsFor` in mapMarkers.ts),
 * so the disc just picks it up from `chip.ink`.
 */
export function crewBadgeRow(
  chips: Array<{ initials: string; name: string; color: string; ink: string }>,
  extra: number,
): HTMLDivElement | null {
  if (chips.length === 0) return null;
  const row = document.createElement("div");
  // Sits above the pin's 26 × 32 content box, centred on its horizontal mid.
  // High enough (−24 px) that a three-disc row clears the visits badge that
  // may be on the pin's top-right corner.
  row.style.cssText = `position:absolute;top:-24px;left:50%;transform:translateX(-50%);display:flex;z-index:1;pointer-events:none;`;
  for (const chip of chips) {
    const disc = document.createElement("div");
    // Ink from the fill, not assumed white — pastel roster colours would
    // otherwise swallow the initials.
    disc.style.cssText = `width:16px;height:16px;border-radius:9999px;background:${chip.color};color:${chip.ink};border:1.5px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.35);font:700 8px/13px "Plus Jakarta Sans",sans-serif;display:flex;align-items:center;justify-content:center;margin-left:-4px;`;
    // textContent, never markup — names are user input.
    disc.textContent = chip.initials;
    row.appendChild(disc);
  }
  if (extra > 0) {
    const more = document.createElement("div");
    more.style.cssText = `height:16px;padding:0 4px;border-radius:8px;background:#fff;color:#111;border:1px solid #d1d5db;box-shadow:0 1px 3px rgba(0,0,0,.35);font:700 8px/14px "Plus Jakarta Sans",sans-serif;display:flex;align-items:center;margin-left:-3px;`;
    more.textContent = `+${extra}`;
    row.appendChild(more);
  }
  // Reset the leftmost disc's margin so the row starts flush.
  const first = row.firstElementChild as HTMLElement | null;
  if (first) first.style.marginLeft = "0";
  return row;
}
