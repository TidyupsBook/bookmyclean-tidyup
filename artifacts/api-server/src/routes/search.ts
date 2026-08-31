import { Router, type IRouter } from "express";
import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import {
  db,
  leadsTable,
  bookingsTable,
  clientsTable,
  teamMembersTable,
} from "@workspace/db";
import {
  SearchDirectoryQueryParams,
  SearchDirectoryResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireRole } from "../middlewares/requireRole";
import { getCompanyForUser } from "../lib/company";

const router: IRouter = Router();

router.use(requireAuth);

/**
 * The search surfaces names, numbers and addresses across leads, bookings,
 * clients and staff — the same audience as Calls and Leads, so it is
 * owner/dispatcher only. Guard is per-route, never router-level: routers all
 * mount at `/`, and a `router.use(requireRole)` here would guard other
 * routers' routes too.
 */
const dispatchOnly = requireRole("owner", "dispatcher");

/** Cap per category so one prolific name can't drown out the other lists. */
const PER_KIND_LIMIT = 10;

/**
 * A digit-normalized "column contains these digits" predicate. Phones are
 * stored in mixed shapes (raw-as-typed alongside E.164, or raw only on
 * bookings and staff), so both sides are reduced to digits before comparing —
 * the same both-sides normalization the lead import does.
 */
function phoneContains(column: SQL | unknown, digits: string): SQL {
  return sql`regexp_replace(coalesce(${column}, ''), '\\D', '', 'g') LIKE ${"%" + digits + "%"}`;
}

/** Escape LIKE wildcards so a literal "%" in the query can't match everything. */
function likePattern(term: string): string {
  return "%" + term.replace(/[\\%_]/g, (m) => `\\${m}`) + "%";
}

router.get("/search", dispatchOnly, async (req, res): Promise<void> => {
  const parsed = SearchDirectoryQueryParams.safeParse(req.query);
  const q = parsed.success ? parsed.data.q.trim() : "";
  if (q.length < 2) {
    res.json(SearchDirectoryResponse.parse({ results: [] }));
    return;
  }
  const company = await getCompanyForUser(req.userId!);
  if (!company) {
    res.json(SearchDirectoryResponse.parse({ results: [] }));
    return;
  }

  const namePattern = likePattern(q);
  // Digits from the query — "555-1234" and "(555) 1234" search the same.
  // Fewer than 3 digits (e.g. the "2" in a street name) is noise, not a
  // phone search.
  const digits = q.replace(/\D/g, "");
  const phoneSearch = digits.length >= 3 ? digits : null;

  const joinAddress = (
    parts: Array<string | null | undefined>,
  ): string | null => {
    const line = parts.filter(Boolean).join(", ");
    return line === "" ? null : line;
  };

  const [leads, bookings, clients, team] = await Promise.all([
    db
      .select()
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.companyId, company.id),
          or(
            ilike(
              sql`concat_ws(' ', ${leadsTable.firstName}, ${leadsTable.lastName})`,
              namePattern,
            ),
            ...(phoneSearch
              ? [
                  phoneContains(leadsTable.phoneE164, phoneSearch),
                  phoneContains(leadsTable.phoneNumber, phoneSearch),
                ]
              : []),
          ),
        ),
      )
      .orderBy(desc(leadsTable.createdAt), desc(leadsTable.id))
      .limit(PER_KIND_LIMIT),
    db
      .select()
      .from(bookingsTable)
      .where(
        and(
          eq(bookingsTable.companyId, company.id),
          or(
            ilike(bookingsTable.customerName, namePattern),
            ...(phoneSearch
              ? [phoneContains(bookingsTable.customerPhone, phoneSearch)]
              : []),
          ),
        ),
      )
      // Most recent visit first — "do they already exist?" wants the
      // freshest booking, not the oldest.
      .orderBy(desc(bookingsTable.scheduledFor), desc(bookingsTable.id))
      .limit(PER_KIND_LIMIT),
    db
      .select()
      .from(clientsTable)
      .where(
        and(
          eq(clientsTable.companyId, company.id),
          or(
            ilike(clientsTable.name, namePattern),
            ...(phoneSearch
              ? [
                  phoneContains(clientsTable.phoneE164, phoneSearch),
                  phoneContains(clientsTable.phone, phoneSearch),
                ]
              : []),
          ),
        ),
      )
      .orderBy(clientsTable.name, clientsTable.id)
      .limit(PER_KIND_LIMIT),
    db
      .select()
      .from(teamMembersTable)
      .where(
        and(
          eq(teamMembersTable.companyId, company.id),
          or(
            ilike(teamMembersTable.name, namePattern),
            ...(phoneSearch
              ? [phoneContains(teamMembersTable.phone, phoneSearch)]
              : []),
          ),
        ),
      )
      .orderBy(teamMembersTable.name, teamMembersTable.id)
      .limit(PER_KIND_LIMIT),
  ]);

  const results = [
    ...clients.map((c) => ({
      kind: "client" as const,
      id: c.id,
      name: c.name,
      phone: c.phone ?? c.phoneE164 ?? null,
      detail: joinAddress([c.streetAddress, c.city]),
      date: null,
      status: null,
    })),
    ...leads.map((l) => ({
      kind: "lead" as const,
      id: l.id,
      name:
        [l.firstName ?? "", l.lastName ?? ""].filter(Boolean).join(" ") ||
        "(no name)",
      phone: l.phoneNumber ?? l.phoneE164 ?? null,
      detail: joinAddress([l.streetAddress, l.city]) ?? l.service ?? null,
      date: null,
      status: l.status,
    })),
    ...bookings.map((b) => ({
      kind: "booking" as const,
      id: b.id,
      name: b.customerName,
      phone: b.customerPhone,
      detail: joinAddress([b.customerAddress, b.addressCity]),
      date: b.scheduledFor ? b.scheduledFor.toISOString() : null,
      status: b.status,
    })),
    ...team.map((t) => ({
      kind: "team" as const,
      id: t.id,
      name: t.name,
      phone: t.phone ?? null,
      detail: t.role,
      date: null,
      status: t.active ? "active" : "inactive",
    })),
  ];

  res.json(SearchDirectoryResponse.parse({ results }));
});

export default router;
