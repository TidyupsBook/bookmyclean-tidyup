/**
 * The pinned start of Jobber history: August 1, 2026.
 *
 * The owner runs their business here from August 2026 onward, so every
 * inbound pull — jobs, quotes, requests, invoices — keeps everything from
 * this date and pulls nothing older. A calendar-days lookback ("the last 365
 * days") can't do that: it silently loses early history as time passes and
 * drags in pre-cutover noise today. A pinned date does exactly one thing,
 * forever.
 *
 * The Date form is UTC midnight, which in every western-hemisphere zone falls
 * on the evening of July 31 local time — deliberately a few hours EARLY, so
 * "from August 2026" is inclusive no matter which zone a company keeps its
 * books in. Pulling a spare evening of history is harmless; losing the
 * morning of August 1 is not.
 */
export const JOBBER_HISTORY_FLOOR_DATE = "2026-08-01";

export const JOBBER_HISTORY_FLOOR = new Date(
  `${JOBBER_HISTORY_FLOOR_DATE}T00:00:00.000Z`,
);
