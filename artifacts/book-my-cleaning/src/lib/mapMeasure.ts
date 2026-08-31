/**
 * The measure tool: "how far is this from that?" on the Live Map.
 *
 * Two things live here, both pure (no React, no Maps SDK):
 *
 *  - straight-line geometry used only to frame and rank points. The Live Map
 *    never presents this as a driving answer; its readout comes from the
 *    server-backed Google route;
 *  - the tool state, because three map tools compete for the same map click.
 *    Drop-pin, move-pin and measure are one field, not three booleans: with
 *    three booleans "turning one on turns the others off" is a rule every
 *    call site has to remember, and the day one forgets, a measuring click
 *    saves a pin. Here it is impossible to express two armed tools at once.
 *
 * Nothing in a measurement is ever sent anywhere. It exists in this state and
 * dies with it — switching tools, clearing, or leaving the page.
 */
import {
  haversineKm,
  formatKm,
  formatDriveMinutes,
  type Coords,
} from "./nearest";

/**
 * One end of a measurement. The label is what the map already called the
 * thing that was clicked ("Sarah M.", "Casey Cleaner (home)"); a click on
 * bare map has none, and the readout says "Point A"/"Point B" instead.
 */
export type MeasurePoint = Coords & { label: string | null };

/** A measured leg, formatted the way the rest of the map talks about distance. */
export type Measurement = {
  /** Straight-line kilometres — the raw number, for callers that need it. */
  km: number;
  /** "400 m", "1.4 km", "12 km". */
  distance: string;
  /** "~9 min" — always an estimate, and it reads like one. */
  drive: string;
};

/**
 * Distance and rough drive time between two spots.
 *
 * Straight-line, from the same helpers the crew rankings use. No Google
 * Distance Matrix call, so measuring costs nothing and works on a key that
 * only has Maps JavaScript enabled.
 */
export function measureBetween(a: Coords, b: Coords): Measurement {
  const km = haversineKm(a, b);
  return { km, distance: formatKm(km), drive: formatDriveMinutes(km) };
}

/** Human-readable labels for an actual server-returned driving route. */
export function formatDrivingMeasurement(
  distanceMeters: number,
  durationSeconds: number,
): { distance: string; duration: string } {
  const totalMinutes = Math.max(1, Math.round(durationSeconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return {
    distance: formatKm(distanceMeters / 1000),
    duration:
      hours > 0
        ? `${hours} h${minutes > 0 ? ` ${minutes} min` : ""}`
        : `${totalMinutes} min`,
  };
}

/** What to call an endpoint in the readout when nothing on the map named it. */
export function measurePointLabel(
  point: MeasurePoint | null | undefined,
  fallback: string,
): string {
  const label = point?.label?.trim();
  return label ? label : fallback;
}

/** The three tools that consume a map click. Exactly one, or none. */
export type MapTool = "none" | "drop" | "move" | "measure" | "route-add";

/** The pin a move is in flight for. */
export type MovingPin = { id: number; name: string };

export type MapToolState = {
  tool: MapTool;
  /** Only ever set while `tool === "move"`. */
  movingPin: MovingPin | null;
  /** First measured point — set by the first click in measure mode. */
  start: MeasurePoint | null;
  /** Second measured point. Never set without a start. */
  end: MeasurePoint | null;
  /** The spot just clicked in route-add mode, waiting for a name. */
  routeAddDraft: MeasurePoint | null;
};

/** Nothing armed, nothing measured. */
export const IDLE_TOOLS: MapToolState = {
  tool: "none",
  movingPin: null,
  start: null,
  end: null,
  routeAddDraft: null,
};

/** Arm the drop-pin tool, or put it away if it is already armed. */
export function toggleDropMode(state: MapToolState): MapToolState {
  return state.tool === "drop" ? IDLE_TOOLS : { ...IDLE_TOOLS, tool: "drop" };
}

/** Arm the route-add tool, or put it away. */
export function toggleRouteAddMode(state: MapToolState): MapToolState {
  return state.tool === "route-add"
    ? IDLE_TOOLS
    : { ...IDLE_TOOLS, tool: "route-add" };
}

/** Arm the measure tool, or put it away — which also wipes the measurement. */
export function toggleMeasureMode(state: MapToolState): MapToolState {
  return state.tool === "measure"
    ? IDLE_TOOLS
    : { ...IDLE_TOOLS, tool: "measure" };
}

/** Start moving a saved pin: the next map click is its new home. */
export function startMovingPin(
  _state: MapToolState,
  pin: MovingPin,
): MapToolState {
  return { ...IDLE_TOOLS, tool: "move", movingPin: pin };
}

/**
 * A click while adding a route stop. Sets the draft location to prompt for a name.
 */
export function addRouteDraftPoint(
  state: MapToolState,
  point: MeasurePoint,
): MapToolState {
  if (state.tool !== "route-add") return state;
  return { ...state, routeAddDraft: point };
}

/** Clears just the draft point, leaving the route-add tool armed. */
export function clearRouteAddDraft(state: MapToolState): MapToolState {
  if (state.tool !== "route-add") return state;
  return { ...state, routeAddDraft: null };
}

/**
 * A click while measuring.
 *
 * First click sets the start, second sets the end, and a third starts a fresh
 * measurement from that spot rather than silently doing nothing or growing a
 * three-point path. A click arriving while another tool is armed is ignored —
 * it belongs to that tool.
 */
export function addMeasurePoint(
  state: MapToolState,
  point: MeasurePoint,
): MapToolState {
  if (state.tool !== "measure") return state;
  if (!state.start) return { ...state, start: point, end: null };
  if (!state.end) return { ...state, end: point };
  return { ...state, start: point, end: null };
}

/**
 * Draw a complete comparison chosen from the distance list in one action.
 * This deliberately replaces any other armed tool or old measurement.
 */
export function setMeasurementPoints(
  start: MeasurePoint,
  end: MeasurePoint,
): MapToolState {
  return {
    ...IDLE_TOOLS,
    tool: "measure",
    start,
    end,
  };
}

/** The Clear button, and Escape: measurement gone, measuring off. */
export function clearMeasurement(_state: MapToolState): MapToolState {
  return IDLE_TOOLS;
}

/** Whatever is armed backs out — Escape, or a finished drop/move. */
export function cancelTool(_state: MapToolState): MapToolState {
  return IDLE_TOOLS;
}

/** The finished measurement, or null while it is still being placed. */
export function measurementOf(
  state: MapToolState,
): (Measurement & { start: MeasurePoint; end: MeasurePoint }) | null {
  if (!state.start || !state.end) return null;
  return {
    start: state.start,
    end: state.end,
    ...measureBetween(state.start, state.end),
  };
}
