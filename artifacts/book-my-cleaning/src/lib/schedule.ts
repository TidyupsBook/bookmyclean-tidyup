/**
 * Pure helpers for the day Schedule and the map date picker. Date maths and
 * job ordering live here — free of React — so prev/next-day stepping, "today"
 * in the company's zone, and time-ordering are unit-testable.
 */
import type { ScheduleJob } from "@workspace/api-client-react";
import { isoToZonedInput } from "./time";

/** Today as YYYY-MM-DD in the company's timezone (not the browser's). */
export function todayInZone(timeZone: string, now: Date = new Date()): string {
  return isoToZonedInput(now.toISOString(), timeZone).slice(0, 10);
}

/** Step a YYYY-MM-DD date string by whole days, staying calendar-correct. */
export function shiftDay(date: string, deltaDays: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const [, y, m, d] = match.map(Number) as unknown as number[];
  // Anchor at UTC noon so a ±1 day step never trips over a DST edge.
  const anchor = new Date(Date.UTC(y!, m! - 1, d!, 12));
  anchor.setUTCDate(anchor.getUTCDate() + deltaDays);
  return anchor.toISOString().slice(0, 10);
}

/**
 * Jobs in the order a dispatcher reads a day: earliest first. Ties (same start)
 * break on customer name so the order is stable across refreshes rather than
 * jittering with array order.
 */
export function sortJobsByTime(jobs: ScheduleJob[]): ScheduleJob[] {
  return [...jobs].sort((a, b) => {
    const ta = new Date(a.scheduledFor).getTime();
    const tb = new Date(b.scheduledFor).getTime();
    if (ta !== tb) return ta - tb;
    return a.customerName.localeCompare(b.customerName);
  });
}

/** Total minutes booked across a lane — the small "4h 30m" lane summary. */
export function totalDurationMinutes(jobs: ScheduleJob[]): number {
  return jobs.reduce((sum, j) => sum + (j.durationMinutes || 0), 0);
}

/** "45 min", "1 hr", "2 hr 30 min" from a minute count. */
export function formatDuration(minutes: number): string {
  if (!minutes || minutes <= 0) return "";
  const hrs = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hrs === 0) return `${mins} min`;
  if (mins === 0) return `${hrs} hr`;
  return `${hrs} hr ${mins} min`;
}

/** "$120.00" or null when there's no price to show. */
export function formatPrice(price: number | null | undefined): string | null {
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0)
    return null;
  return `$${price.toFixed(2)}`;
}
