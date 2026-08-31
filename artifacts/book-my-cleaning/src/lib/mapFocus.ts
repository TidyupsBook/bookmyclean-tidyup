/**
 * "Show this job on the map" — the handful of query params the live map reads
 * when another page sends a dispatcher there.
 *
 * Parsing lives here, away from the map page, so it can be tested without a
 * Google Maps script. Anything malformed is dropped rather than guessed at:
 * a junk date would silently move the whole calendar to a day the dispatcher
 * never asked for.
 */

/** A job to centre on, and the day it belongs to in the company's zone. */
export type MapFocus = {
  jobId: number | null;
  date: string | null;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseMapFocus(search: string): MapFocus {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return { jobId: null, date: null };
  }

  const rawJob = params.get("job");
  const jobId =
    rawJob && /^\d+$/.test(rawJob) && Number(rawJob) > 0
      ? Number(rawJob)
      : null;

  const rawDate = params.get("date");
  const date =
    rawDate && DATE_RE.test(rawDate) && !Number.isNaN(Date.parse(rawDate))
      ? rawDate
      : null;

  return { jobId, date };
}

/** The link that sends a dispatcher to the map with this job centred. */
export function mapFocusHref(jobId: number, date: string | null): string {
  const params = new URLSearchParams({ job: String(jobId) });
  if (date && DATE_RE.test(date)) params.set("date", date);
  return `/map?${params.toString()}`;
}
