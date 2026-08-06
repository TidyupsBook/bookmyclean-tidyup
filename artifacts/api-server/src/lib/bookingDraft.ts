import type { Call } from "@workspace/db";

/**
 * Turns what a caller said into a suggested booking for the New Booking form.
 *
 * Two things feed this: a finished Quo call (using the transcript and answers
 * already stored when the transcript landed) and raw text from the dispatcher's
 * microphone while they are still on the phone. Both end up in the same shape
 * so the form only has one way to fill itself in.
 *
 * Everything here is a suggestion the dispatcher can overwrite. When a value is
 * uncertain we return nothing rather than a guess — an empty box is a prompt to
 * ask the customer, whereas a wrong address gets saved and sent to a crew.
 *
 * Deliberately plain pattern matching, not an AI call: the dispatcher presses
 * this button mid-sentence, so it has to answer instantly and give the same
 * answer every time.
 */
export type BookingDraft = {
  callId: number | null;
  customerName: string | null;
  customerPhone: string | null;
  customerAddress: string | null;
  addressCity: string | null;
  addressProvince: string | null;
  addressPostal: string | null;
  service: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  preferredTime: string | null;
  internalNotes: string | null;
  filledFields: string[];
};

/** Placeholders Quo uses when it never learned who was calling. */
const UNKNOWN_NAMES = new Set(["unknown", "unknown caller", "restricted", ""]);

/** Canadian postal code — letter/digit alternation can't be anything else. */
const POSTAL_RE = /\b([A-Za-z]\d[A-Za-z])[ -]?(\d[A-Za-z]\d)\b/;

/**
 * US ZIP code, with the optional +4. The digit guards keep it from reading
 * five digits out of the middle of a phone number read without pauses.
 */
const ZIP_RE = /(?<!\d)(\d{5})(?:-(\d{4}))?(?!\d)/;

/**
 * A house number followed by one to three plain words and a street type.
 *
 * The street-name words deliberately allow no digits: without that, a sentence
 * like "a 3 bedroom 2 bath at 12 Oak Street" matches from the "3" and the
 * saved address is nonsense. Keeping it to letters makes the engine give up on
 * "3" and find the real house number instead.
 */
const ADDRESS_RE =
  /\b(\d{1,6}\s+[A-Za-z][A-Za-z.'-]{1,20}(?:\s+[A-Za-z][A-Za-z.'-]{1,20}){0,2}\s+(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|way|boulevard|blvd|terrace|place|pl)\b)/i;

const SERVICE_RE =
  /\b((?:deep|move[- ]?out|move[- ]?in|standard|recurring|post[- ]construction|airbnb)[a-z ]{0,20}clean(?:ing)?)/i;

const WHEN_RE =
  /\b((?:next |this )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today)[^.!?]{0,30})/i;

const PETS_RE =
  /\b((?:no pets|one dog|a dog|two dogs|a cat|cats?|dogs?)[^.!?]{0,30})/i;

/**
 * A North American phone number, however the caller reads it out: "780 920
 * 6391", "(780) 920-6391", "1-780-920-6391". Ten digits is a high enough bar
 * that a house number or a price can't be mistaken for one.
 */
const PHONE_RE =
  /(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?!\d)/;

/** One or two plain words — the shape a spoken name takes. */
const NAME_WORDS = String.raw`([a-z][a-z'-]{1,19}(?:\s+[a-z][a-z'-]{1,19})?)`;

/** "uh", "um" — filler between the introduction and the name. */
const NAME_FILLER = String.raw`(?:uh |um |ah )?`;

/**
 * "my name is Sarah Johnson". Whatever follows this is a name; nobody says it
 * about anything else.
 *
 * Speech recognition capitalises names unreliably, so this matches without
 * regard to case and title-cases the result.
 */
const STRONG_NAME_RE = new RegExp(
  String.raw`\b(?:my name(?:'s| is)|the name(?:'s| is))\s+` +
    NAME_FILLER +
    NAME_WORDS,
  "i",
);

/**
 * "this is Sarah", "I'm Sarah Johnson". These openings introduce a name about
 * as often as they start an ordinary sentence — "this is for my mother", "I'm
 * calling about a quote" — so the name has to be the end of the thought.
 *
 * Requiring a full stop, a comma or a joining word after it is what keeps a
 * customer called "For My" out of the booking.
 */
const WEAK_NAME_RE = new RegExp(
  String.raw`\b(?:this is|i'm|i am|it's)\s+` +
    NAME_FILLER +
    NAME_WORDS +
    String.raw`(?=\s*[.,!?]|\s*$|\s+(?:calling|speaking|here|again|and|but|so)\b)`,
  "i",
);

/**
 * Words that follow "I'm" or "it's" far more often than a name does. Without
 * this the form confidently fills in a customer called "Looking" or "Just".
 */
const NOT_A_NAME = new Set([
  "a",
  "an",
  "the",
  "about",
  "actually",
  "afraid",
  "all",
  "also",
  "at",
  "available",
  "calling",
  "fine",
  "free",
  "going",
  "good",
  "great",
  "here",
  "hoping",
  "in",
  "interested",
  "just",
  "looking",
  "my",
  "no",
  "not",
  "okay",
  "on",
  "only",
  "probably",
  "really",
  "sorry",
  "still",
  "sure",
  "thinking",
  "trying",
  "uh",
  "um",
  "wondering",
  "yeah",
  "yes",
  "with",
]);

/** Filler a caller tacks on the end: "this is Sarah calling". */
const NAME_TAIL = /\s+(?:calling|speaking|here|again)$/i;

function nameIn(text: string): string | null {
  const match = text.match(STRONG_NAME_RE) ?? text.match(WEAK_NAME_RE);
  const raw = match?.[1]?.replace(NAME_TAIL, "").trim();
  if (!raw) return null;
  const words = raw.split(/\s+/);
  if (NOT_A_NAME.has(words[0]!.toLowerCase())) return null;
  // A trailing filler word means we caught a sentence, not a surname.
  if (words.length === 2 && NOT_A_NAME.has(words[1]!.toLowerCase())) {
    return titleCase(words[0]!);
  }
  return titleCase(words.join(" "));
}

function phoneIn(text: string): string | null {
  const m = text.match(PHONE_RE);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : null;
}

/**
 * "3 bedroom", "three bedrooms", "2 bath". Only small numbers, because
 * anything larger in a house is a mishearing rather than a mansion.
 */
const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function countOf(text: string, noun: "bed" | "bath"): number | null {
  const words = Object.keys(WORD_NUMBERS).join("|");
  const re = new RegExp(
    `\\b(\\d{1,2}|${words})\\s*(?:and a half\\s*)?${noun}(?:room|s)?\\b`,
    "i",
  );
  const m = text.match(re);
  if (!m?.[1]) return null;
  const raw = m[1].toLowerCase();
  const n = WORD_NUMBERS[raw] ?? Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 20) return null;
  return n;
}

function titleCase(text: string): string {
  return text.replace(
    /\w\S*/g,
    (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase(),
  );
}

/** The half of a draft that can be read out of free text alone. */
type TextDraft = {
  customerName: string | null;
  customerPhone: string | null;
  customerAddress: string | null;
  addressPostal: string | null;
  service: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  preferredTime: string | null;
  pets: string | null;
};

/**
 * A postal code out of free text: Canadian first (its shape is unmistakable),
 * then a US ZIP. A five-digit number that is the house number of the address
 * we just matched is not a ZIP — "12345 Oak Street" must not fill the postal
 * box with its own house number.
 */
function postalIn(text: string, address: string | null): string | null {
  const ca = text.match(POSTAL_RE);
  if (ca) return `${ca[1]!.toUpperCase()} ${ca[2]!.toUpperCase()}`;
  const zip = text.match(ZIP_RE);
  if (!zip) return null;
  const code = zip[2] ? `${zip[1]}-${zip[2]}` : zip[1]!;
  if (address && address.includes(zip[1]!)) return null;
  return code;
}

function draftFromText(text: string): TextDraft {
  const address = text.match(ADDRESS_RE)?.[1]?.trim() ?? null;
  const service = text.match(SERVICE_RE)?.[1]?.trim() ?? null;
  return {
    customerName: nameIn(text),
    customerPhone: phoneIn(text),
    customerAddress: address,
    addressPostal: postalIn(text, address),
    service: service ? titleCase(service) : null,
    bedrooms: countOf(text, "bed"),
    bathrooms: countOf(text, "bath"),
    preferredTime: text.match(WHEN_RE)?.[1]?.trim() ?? null,
    pets: text.match(PETS_RE)?.[1]?.trim() ?? null,
  };
}

/**
 * Which boxes we actually found something for, so the form can highlight what
 * it filled instead of the dispatcher hunting for the changes.
 */
function withFilledFields(draft: Omit<BookingDraft, "filledFields">) {
  const filledFields = (
    Object.entries(draft) as Array<[keyof BookingDraft, unknown]>
  )
    .filter(([key, value]) => key !== "callId" && value != null)
    .map(([key]) => key);
  return { ...draft, filledFields };
}

/** A draft from the dispatcher's microphone. No caller identity to go on. */
export function buildDraftFromText(text: string): BookingDraft {
  const found = draftFromText(text);
  return withFilledFields({
    callId: null,
    customerName: found.customerName,
    customerPhone: found.customerPhone,
    customerAddress: found.customerAddress,
    // City and province stay empty on purpose: nothing in the text tells us
    // them, and filling in the company's own city would be a guess that looks
    // like a fact.
    addressCity: null,
    addressProvince: null,
    addressPostal: found.addressPostal,
    service: found.service,
    bedrooms: found.bedrooms,
    bathrooms: found.bathrooms,
    preferredTime: found.preferredTime,
    internalNotes: found.pets ? `Pets: ${found.pets}` : null,
  });
}

/** A draft from a call Quo has already transcribed. */
export function buildBookingDraft(call: Call): BookingDraft {
  const said = (call.transcript ?? [])
    .filter((t) => t.speaker === "caller")
    .map((t) => t.text)
    .join(" ");
  const found = draftFromText(said);

  const answer = (field: string) =>
    (call.extractedAnswers ?? [])
      .find((a) => a.field === field)
      ?.value?.trim() || null;

  const name = (call.callerName ?? "").trim();
  const phone = (call.callerPhone ?? "").trim();

  // Things worth telling the crew that have nowhere else to go.
  const noteParts: string[] = [];
  const pets = answer("pets") ?? found.pets;
  if (pets) noteParts.push(`Pets: ${pets}`);
  const budget = answer("budget");
  if (budget) noteParts.push(`Mentioned budget: ${budget}`);
  if (call.summary) noteParts.push(`Call summary: ${call.summary}`);

  return withFilledFields({
    callId: call.id,
    // Caller ID wins when Quo has it; otherwise fall back to whatever the
    // caller said out loud ("this is Sarah", "my number is …"), which is all
    // we have for a blocked or unknown number.
    customerName: UNKNOWN_NAMES.has(name.toLowerCase())
      ? found.customerName
      : name,
    customerPhone: UNKNOWN_NAMES.has(phone.toLowerCase())
      ? found.customerPhone
      : phone,
    // The stored answer wins over a fresh scan: it was extracted from the same
    // transcript, and re-deriving it here would only ever disagree.
    customerAddress: answer("address") ?? found.customerAddress,
    addressCity: null,
    addressProvince: null,
    addressPostal: found.addressPostal,
    service: call.serviceRequested?.trim() || found.service,
    bedrooms: countOf(answer("home size") ?? "", "bed") ?? found.bedrooms,
    bathrooms: found.bathrooms,
    preferredTime: call.preferredTime?.trim() || found.preferredTime,
    internalNotes: noteParts.length > 0 ? noteParts.join("\n") : null,
  });
}
