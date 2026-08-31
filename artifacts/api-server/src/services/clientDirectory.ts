/**
 * The company's client directory — one row per customer in `clients`.
 *
 * Every place a customer surfaces (a booking typed at the desk, a visit
 * pulled from Jobber's calendar, a quote written in Jobber, a converted
 * lead) calls recordClientContact. The directory is a convenience index,
 * never load-bearing: every call site treats a failure here as a warning,
 * because losing a directory update must not lose the booking or the sync
 * that carried it.
 *
 * Identity, in precedence order:
 *  1. Jobber's client id — the strongest identity when present.
 *  2. The E.164-normalized phone — how this product identifies people
 *     everywhere else (threads, calls, Jobber matching).
 *  3. The raw phone as typed — last resort for undialable numbers, matched
 *     verbatim the way the backfill migration keyed them.
 *
 * Fill, never blank: a later sighting with fewer details (a Jobber visit
 * carries only name + phone) must not erase an email or address captured at
 * booking time. The one field that always follows the newest sighting is the
 * name — people correct typos, and Jobber's spelling is the owner's own.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db, clientsTable, type Client } from "@workspace/db";
import { toE164 } from "../lib/quo";
import { logger } from "../lib/logger";
import { syncClientByIdToQuo } from "./quoContactSync";
import { relinkClientCallers } from "./callerDirectory";

export type ClientContact = {
  name: string;
  phone?: string | null;
  email?: string | null;
  streetAddress?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
  jobberClientId?: string | null;
  /** Where this sighting came from: booking | jobber | lead. */
  source: "booking" | "jobber" | "lead";
};

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

async function findExisting(
  companyId: number,
  jobberClientId: string | null,
  phoneE164: string | null,
  rawPhone: string | null,
): Promise<Client | undefined> {
  if (jobberClientId) {
    const [byJobber] = await db
      .select()
      .from(clientsTable)
      .where(
        and(
          eq(clientsTable.companyId, companyId),
          eq(clientsTable.jobberClientId, jobberClientId),
        ),
      )
      .limit(1);
    if (byJobber) return byJobber;
  }
  if (phoneE164) {
    const [byPhone] = await db
      .select()
      .from(clientsTable)
      .where(
        and(
          eq(clientsTable.companyId, companyId),
          eq(clientsTable.phoneE164, phoneE164),
        ),
      )
      .limit(1);
    if (byPhone) return byPhone;
  }
  if (!phoneE164 && rawPhone) {
    // Undialable numbers were backfilled keyed by the raw string; match them
    // the same way so re-sightings update rather than duplicate.
    const [byRaw] = await db
      .select()
      .from(clientsTable)
      .where(
        and(
          eq(clientsTable.companyId, companyId),
          eq(clientsTable.phone, rawPhone),
          isNull(clientsTable.phoneE164),
        ),
      )
      .limit(1);
    if (byRaw) return byRaw;
  }
  return undefined;
}

/**
 * Insert or update the directory row for this customer. Never throws — the
 * directory is bookkeeping on the side of whatever operation saw the
 * customer, and that operation must survive a directory hiccup.
 */
export async function recordClientContact(
  companyId: number,
  contact: ClientContact,
): Promise<void> {
  try {
    const name = clean(contact.name);
    if (!name) return;
    // A "phone" with no digit in it ("Unknown", "N/A") identifies nobody;
    // treat it as absent rather than minting a junk row keyed on it.
    const typedPhone = clean(contact.phone);
    const rawPhone = typedPhone && /\d/.test(typedPhone) ? typedPhone : null;
    const phoneE164 = rawPhone ? toE164(rawPhone) : null;
    const jobberClientId = clean(contact.jobberClientId);
    // Nothing to identify the person by — a bare name is not a client row.
    if (!rawPhone && !jobberClientId) return;

    const existing = await findExisting(
      companyId,
      jobberClientId,
      phoneE164,
      rawPhone,
    );

    if (!existing) {
      const [inserted] = await db
        .insert(clientsTable)
        .values({
          companyId,
          name,
          phone: rawPhone,
          phoneE164,
          email: clean(contact.email),
          streetAddress: clean(contact.streetAddress),
          city: clean(contact.city),
          province: clean(contact.province),
          postalCode: clean(contact.postalCode),
          jobberClientId,
          source: contact.source,
        })
        // Two writers can race past findExisting (booking create + a sync
        // cycle); the partial unique indexes turn the loser into a no-op and
        // the next sighting updates the winner's row.
        .onConflictDoNothing()
        .returning();
      const saved =
        inserted ??
        (await findExisting(companyId, jobberClientId, phoneE164, rawPhone));
      if (saved) {
        await relinkClientCallers(saved);
        void syncClientByIdToQuo(companyId, saved.id);
      }
      return;
    }

    const updates: Partial<typeof clientsTable.$inferInsert> = {};
    if (name !== existing.name) updates.name = name;
    if (!existing.phoneE164 && phoneE164) {
      updates.phoneE164 = phoneE164;
      updates.phone = rawPhone;
    } else if (!existing.phone && rawPhone) {
      updates.phone = rawPhone;
    }
    if (!existing.email && clean(contact.email))
      updates.email = clean(contact.email);
    if (!existing.streetAddress && clean(contact.streetAddress)) {
      updates.streetAddress = clean(contact.streetAddress);
      // An address travels as a unit; a filled street with a stale city
      // would geocode to nowhere.
      if (clean(contact.city)) updates.city = clean(contact.city);
      if (clean(contact.province)) updates.province = clean(contact.province);
      if (clean(contact.postalCode))
        updates.postalCode = clean(contact.postalCode);
    }
    if (!existing.jobberClientId && jobberClientId)
      updates.jobberClientId = jobberClientId;

    if (Object.keys(updates).length === 0) {
      await relinkClientCallers(existing);
      return;
    }
    const [saved] = await db
      .update(clientsTable)
      .set(updates)
      .where(eq(clientsTable.id, existing.id))
      .returning();
    await relinkClientCallers(saved!);
    void syncClientByIdToQuo(companyId, saved!.id);
  } catch (err) {
    // A second row already carrying this jobberClientId (one customer, two
    // phone numbers) lands here via the partial unique index. Log and move
    // on — the primary operation must not fail over directory bookkeeping.
    logger.warn(
      { err, companyId, source: contact.source },
      "Client directory update failed",
    );
  }
}
