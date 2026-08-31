import { measureBetween, type MeasurePoint } from "./mapMeasure";

export type RoutePlanStop = MeasurePoint & {
  id: number;
  position: number;
  name: string;
};

export type RoutePlanLeg = ReturnType<typeof measureBetween> & {
  from: MeasurePoint;
  to: RoutePlanStop;
  stopId: number;
};

/**
 * Build the ordered cleaner → stop 1 → stop 2 route shown in the planner.
 *
 * This remains deliberately straight-line math, matching every other distance
 * on the map. It makes no claim to be traffic-aware turn-by-turn routing.
 */
export function routePlanLegs(
  cleaner: MeasurePoint,
  stops: ReadonlyArray<RoutePlanStop>,
): RoutePlanLeg[] {
  const ordered = [...stops].sort(
    (a, b) => a.position - b.position || a.id - b.id,
  );
  let from = cleaner;
  return ordered.map((stop) => {
    const measured = measureBetween(from, stop);
    const leg = {
      ...measured,
      from,
      to: stop,
      stopId: stop.id,
    };
    from = stop;
    return leg;
  });
}

export function routePlanTotalKm(legs: ReadonlyArray<RoutePlanLeg>): number {
  return legs.reduce((total, leg) => total + leg.km, 0);
}

/**
 * Return the stop ids in their new order after a single up/down move.
 * Boundary moves are harmless and duplicate positions stay deterministic.
 */
export function moveRouteStop(
  stops: ReadonlyArray<Pick<RoutePlanStop, "id" | "position">>,
  stopId: number,
  direction: -1 | 1,
): number[] {
  const ids = [...stops]
    .sort((a, b) => a.position - b.position || a.id - b.id)
    .map((stop) => stop.id);
  const index = ids.indexOf(stopId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ids.length) return ids;
  [ids[index], ids[target]] = [ids[target]!, ids[index]!];
  return ids;
}
