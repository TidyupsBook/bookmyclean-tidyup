/**
 * Hiding customer contact details and money from crew.
 *
 * Cleaners see the activity feed, but the app never shows them a customer's
 * phone number or what a job is worth — that stays between the office and the
 * customer. Activity messages are free text written for dispatch, so anything
 * that reads as a phone number or a dollar figure is masked on the way out
 * rather than the messages being rewritten at every call site.
 *
 * Two ways to get this wrong, and both matter:
 *  - too narrow and a real phone number reaches a cleaner;
 *  - too broad and it eats the dates, times and job numbers crew work from.
 * So the patterns below describe phone *structure* (3-3-4 with optional
 * country code) rather than "ten digits near some punctuation", which is what
 * keeps `2026-08-06 12:30` intact.
 */

export const HIDDEN = "(hidden)";

/**
 * `$150`, `$150.00`, `$1,250`, `$1 250.50`, `$.99`. Thousands groups must be
 * exactly three digits, so `$150 toward Deep Clean` masks only the amount and
 * leaves the words alone.
 */
const MONEY = /\$\s?(?:\d{1,3}(?:[,\s]\d{3})+|\d+)(?:\.\d+)?|\$\s?\.\d+/g;

/** Separators people actually type between the parts of a phone number. */
const SEP = "[\\s.\\-/]?";

/**
 * North American shapes: `5551234567`, `555-123-4567`, `555.123.4567`,
 * `555/123-4567`, `(555) 123-4567`, `+1 555 123 4567`, `15551234567`.
 * The digit boundaries stop it from biting a chunk out of a longer number.
 */
const PHONE_NA = new RegExp(
  `(?<!\\d)(?:\\+?1${SEP})?(?:\\(\\d{3}\\)|\\d{3})${SEP}\\d{3}${SEP}\\d{4}(?!\\d)`,
  "g",
);

/**
 * Anything explicitly international: `+44 20 7123 4567`. The leading `+` is
 * what makes this safe to keep loose — no date or job number starts with one.
 */
const PHONE_INTERNATIONAL = /\+\d[\d\s.\-/()]{7,}\d(?!\d)/g;

/** A real international number has at least this many digits. */
const MIN_INTERNATIONAL_DIGITS = 10;

function digitCount(value: string): number {
  return (value.match(/\d/g) ?? []).length;
}

/**
 * Mask phone numbers and dollar amounts in a message meant for a cleaner.
 * Money goes first: once it is masked there are no digits left in it for the
 * phone passes to trip over.
 */
export function redactForCrew(message: string): string {
  return message
    .replace(MONEY, HIDDEN)
    .replace(PHONE_INTERNATIONAL, (match) =>
      digitCount(match) >= MIN_INTERNATIONAL_DIGITS ? HIDDEN : match,
    )
    .replace(PHONE_NA, HIDDEN);
}
