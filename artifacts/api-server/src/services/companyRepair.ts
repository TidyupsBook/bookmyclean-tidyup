import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@workspace/db";

/**
 * This is deliberately a closed list. The repair must never infer that a
 * company is synthetic from a name, an email, or an owner-id pattern.
 * These fingerprints are the rows reviewed from the live database before the
 * repair was written.
 */
export const TEST_COMPANY_REPAIR_TARGETS = [
  {
    id: 6,
    ownerUserId: "user_seed_test",
    ownerEmail: null,
    name: "Tidyups Cleaning",
  },
  {
    id: 1275,
    ownerUserId: "staff_owner_1786062069286_17849",
    ownerEmail: null,
    name: "Staff Co 1786062069286_17849",
  },
  {
    id: 3728,
    ownerUserId: "jpush_off_1786295902160_6704",
    ownerEmail: null,
    name: "No Jobber Co 1786295902160_6704",
  },
  {
    id: 5872,
    ownerUserId: "leads_owner_1786648915255_27887",
    ownerEmail: null,
    name: "Leads Co 1786648915255_27887",
  },
  {
    id: 5873,
    ownerUserId: "leads_other_owner_1786648915255_27887",
    ownerEmail: null,
    name: "Other Co 1786648915255_27887",
  },
  {
    id: 6734,
    ownerUserId: "jpush_owner_1786759369628_4970",
    ownerEmail: null,
    name: "Jobber Push Co 1786759369628_4970",
  },
  {
    id: 6741,
    ownerUserId: "jcs_owner_1786759376654_5417",
    ownerEmail: null,
    name: "Jobber Sync Co 1786759376654_5417",
  },
  {
    id: 6746,
    ownerUserId: "leads_owner_1786759383757_5465",
    ownerEmail: null,
    name: "Leads Co 1786759383757_5465",
  },
  {
    id: 6747,
    ownerUserId: "leads_other_owner_1786759383757_5465",
    ownerEmail: null,
    name: "Other Co 1786759383757_5465",
  },
  {
    id: 6761,
    ownerUserId: "approve_owner_1786759393191_5537",
    ownerEmail: null,
    name: "Approve Co 1786759393191_5537",
  },
  {
    id: 6770,
    ownerUserId: "intake_owner_1786759402259_5633",
    ownerEmail: null,
    name: "Intake Co 1786759402259_5633",
  },
  {
    id: 6771,
    ownerUserId: "intake_stranger_1786759402259_5633",
    ownerEmail: null,
    name: "Other Co 1786759402259_5633",
  },
  {
    id: 6790,
    ownerUserId: "min_owner_1786759415075_5846",
    ownerEmail: null,
    name: "Minimal Co 1786759415075_5846",
  },
  {
    id: 8350,
    ownerUserId: "user_3Hy5RhrT6H6F8KQXm9Nf018gHmH",
    ownerEmail: "demo+clerk_test@tidyups.ca",
    name: "Sparkle Ridge Cleaning",
  },
  {
    id: 10828,
    ownerUserId: "user_3IByrGClSbN9ULencygdLLD4XoF",
    ownerEmail: "owner-1787252451716@example.com",
    name: "Test Cleaning Co 1787252467950",
  },
  {
    id: 11132,
    ownerUserId: "user_3IC15vijLBynHIWN8pK5JsFq4tr",
    ownerEmail: "qa-quote-a8tzjlno0dxnexw19fsgx@example.com",
    name: "QA Cleaning rophlNXf",
  },
  {
    id: 11841,
    ownerUserId: "user_3IC9sys7smVWtsg1t0ynoheAkSr",
    ownerEmail: "dev.owner@example.com",
    name: "Acme Cleaning Test",
  },
  {
    id: 14767,
    ownerUserId: "jcs_owner_1787364197257_700",
    ownerEmail: null,
    name: "Jobber Sync Co 1787364197257_700",
  },
  {
    id: 15898,
    ownerUserId: "jmc_ownerB_1787422858241_9036",
    ownerEmail: null,
    name: "Jobber Connections Test Co B 1787422858241_9036",
  },
  {
    id: 16729,
    ownerUserId: "jpush_off_1787519559145_14044",
    ownerEmail: null,
    name: "No Jobber Co 1787519559145_14044",
  },
  {
    id: 16730,
    ownerUserId: "jpush_stale_1787519559145_14044",
    ownerEmail: null,
    name: "stale Co 1787519559145_14044",
  },
  {
    id: 16731,
    ownerUserId: "jpush_offjobber_1787519559145_14044",
    ownerEmail: null,
    name: "offjobber Co 1787519559145_14044",
  },
  {
    id: 16760,
    ownerUserId: "leads_owner_1787519583733_14407",
    ownerEmail: null,
    name: "Leads Co 1787519583733_14407",
  },
  {
    id: 16761,
    ownerUserId: "leads_other_owner_1787519583733_14407",
    ownerEmail: null,
    name: "Other Co 1787519583733_14407",
  },
  {
    id: 16763,
    ownerUserId: "messages_owner_1787519587410_14443",
    ownerEmail: null,
    name: "Messages Co 1787519587410_14443",
  },
  {
    id: 16764,
    ownerUserId: "messages_other_1787519587410_14443",
    ownerEmail: null,
    name: "Messages Rival 1787519587410_14443",
  },
  {
    id: 16786,
    ownerUserId: "sal_owner_1787519604480_14587",
    ownerEmail: null,
    name: "SaveAsLead Co 1787519604480_14587",
  },
  {
    id: 16787,
    ownerUserId: "sal_other_owner_1787519604480_14587",
    ownerEmail: null,
    name: "SaveAsLead Other 1787519604480_14587",
  },
  {
    id: 16830,
    ownerUserId: "jpush_off_1787519718621_16550",
    ownerEmail: null,
    name: "No Jobber Co 1787519718621_16550",
  },
  {
    id: 16831,
    ownerUserId: "jpush_stale_1787519718621_16550",
    ownerEmail: null,
    name: "stale Co 1787519718621_16550",
  },
  {
    id: 16832,
    ownerUserId: "jpush_offjobber_1787519718621_16550",
    ownerEmail: null,
    name: "offjobber Co 1787519718621_16550",
  },
  {
    id: 16867,
    ownerUserId: "sal_owner_1787519757009_16827",
    ownerEmail: null,
    name: "SaveAsLead Co 1787519757009_16827",
  },
  {
    id: 16868,
    ownerUserId: "sal_other_owner_1787519757009_16827",
    ownerEmail: null,
    name: "SaveAsLead Other 1787519757009_16827",
  },
  {
    id: 16869,
    ownerUserId: "messages_owner_1787519758096_16839",
    ownerEmail: null,
    name: "Messages Co 1787519758096_16839",
  },
  {
    id: 16870,
    ownerUserId: "messages_other_1787519758096_16839",
    ownerEmail: null,
    name: "Messages Rival 1787519758096_16839",
  },
  {
    id: 16871,
    ownerUserId: "leads_owner_1787519759140_16851",
    ownerEmail: null,
    name: "Leads Co 1787519759140_16851",
  },
  {
    id: 16872,
    ownerUserId: "leads_other_owner_1787519759140_16851",
    ownerEmail: null,
    name: "Other Co 1787519759140_16851",
  },
  {
    id: 17226,
    ownerUserId: "user_3I9zbg8utajNP9DHd4FVVYzUZbI",
    ownerEmail: "owner@example.com",
    name: "Test Cleaning Co",
  },
  {
    id: 17851,
    ownerUserId: "user_3INkucBNr16miCJKrehgfGFkjbw",
    ownerEmail: "test.dispatcher@example.com",
    name: "Test Cleaning Co",
  },
  {
    id: 20277,
    ownerUserId: "user_3IQDduSef55F5wFkH1EyMLYCHsP",
    ownerEmail: "e2e-txmn52fbrqoxf7prx_vja@example.com",
    name: "E2E Cleaning y00YIpbpaDQCJ29KRWPAG",
  },
  {
    id: 25581,
    ownerUserId: "test_authz_owner_1787964468388_85761",
    ownerEmail: null,
    name: "AuthZ Test Co A 1787964468388_85761",
  },
  {
    id: 25582,
    ownerUserId: "test_authz_other_owner_1787964468388_85761",
    ownerEmail: null,
    name: "AuthZ Test Co B 1787964468388_85761",
  },
  {
    id: 25803,
    ownerUserId: "user_3IZGltyAt3eYxZRVvp7woecPp12",
    ownerEmail: "owner-1787964831633@example.com",
    name: "QA Cleaning Co 1787964852311",
  },
] as const;

export const LIVE_COMPANY_REPAIR_FINGERPRINT = {
  id: 7,
  ownerUserId: "user_3HW7oKOVVPPUX1aEW7XeCxRWfX4",
  ownerEmail: "cleaningserviceyeg@gmail.com",
  name: "Book My Cleaning - Tidyups Venture",
  jobberConnected: true,
  jobberAccountId: "Z2lkOi8vSm9iYmVyL0FjY291bnQvNzE4NTc2",
} as const;

const COMPANY_COUNT_COLUMNS = [
  "activity",
  "booking_time_entries",
  "bookings",
  "booking_assignments",
  "callers",
  "calls",
  "cleaner_locations",
  "client_messages",
  "client_threads",
  "clients",
  "homeowner_pins",
  "jobber_connections",
  "jobber_invoices",
  "jobber_quotes",
  "jobber_webhook_deliveries",
  "lead_sync_state",
  "leads",
  "pending_texts",
  "quo_webhooks",
  "quo_webhook_deliveries",
  "saved_routes",
  "saved_route_stops",
  "services",
  "staff_conversations",
  "staff_conversation_members",
  "staff_messages",
  "staff_devices",
  "team_members",
] as const;

export type CompanyRepairCounts = Record<
  (typeof COMPANY_COUNT_COLUMNS)[number],
  number
>;

export type CompanyRepairInventoryRow = {
  id: number;
  ownerUserId: string;
  ownerEmail: string | null;
  name: string;
  jobberConnected: boolean;
  jobberAccountId: string | null;
  createdAt: string;
  counts: CompanyRepairCounts;
};

export type CompanyRepairAudit = {
  reviewDigest: string;
  companies: CompanyRepairInventoryRow[];
  candidateCompanyIds: number[];
  crossCompanyReferences: Array<{ edge: string; count: number }>;
  unreviewedCompanies: {
    count: number;
    totalDependentRows: number;
    inventoryDigest: string;
  };
};

export class CompanyRepairGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanyRepairGuardError";
  }
}

type SqlExecutor = {
  execute(query: SQL): Promise<{ rows: unknown[] }>;
};

const INVENTORY_QUERY = sql`
  SELECT
    c.id,
    c.owner_user_id,
    c.owner_email,
    c.name,
    c.jobber_connected,
    c.jobber_account_id,
    c.created_at::text AS created_at,
    (SELECT count(*) FROM activity x WHERE x.company_id = c.id) AS activity,
    (SELECT count(*) FROM booking_time_entries x WHERE x.company_id = c.id) AS booking_time_entries,
    (SELECT count(*) FROM bookings x WHERE x.company_id = c.id) AS bookings,
    (SELECT count(*) FROM booking_assignments x
       JOIN bookings b ON b.id = x.booking_id
       WHERE b.company_id = c.id) AS booking_assignments,
    (SELECT count(*) FROM callers x WHERE x.company_id = c.id) AS callers,
    (SELECT count(*) FROM calls x WHERE x.company_id = c.id) AS calls,
    (SELECT count(*) FROM cleaner_locations x WHERE x.company_id = c.id) AS cleaner_locations,
    (SELECT count(*) FROM client_messages x WHERE x.company_id = c.id) AS client_messages,
    (SELECT count(*) FROM client_threads x WHERE x.company_id = c.id) AS client_threads,
    (SELECT count(*) FROM clients x WHERE x.company_id = c.id) AS clients,
    (SELECT count(*) FROM homeowner_pins x WHERE x.company_id = c.id) AS homeowner_pins,
    (SELECT count(*) FROM jobber_connections x WHERE x.company_id = c.id) AS jobber_connections,
    (SELECT count(*) FROM jobber_invoices x WHERE x.company_id = c.id) AS jobber_invoices,
    (SELECT count(*) FROM jobber_quotes x WHERE x.company_id = c.id) AS jobber_quotes,
    (SELECT count(*) FROM jobber_webhook_deliveries x WHERE x.company_id = c.id) AS jobber_webhook_deliveries,
    (SELECT count(*) FROM lead_sync_state x WHERE x.company_id = c.id) AS lead_sync_state,
    (SELECT count(*) FROM leads x WHERE x.company_id = c.id) AS leads,
    (SELECT count(*) FROM pending_texts x WHERE x.company_id = c.id) AS pending_texts,
    (SELECT count(*) FROM quo_webhooks x WHERE x.company_id = c.id) AS quo_webhooks,
    (SELECT count(*) FROM quo_webhook_deliveries x WHERE x.company_id = c.id) AS quo_webhook_deliveries,
    (SELECT count(*) FROM saved_routes x WHERE x.company_id = c.id) AS saved_routes,
    (SELECT count(*) FROM saved_route_stops x
       JOIN saved_routes r ON r.id = x.route_id
       WHERE r.company_id = c.id) AS saved_route_stops,
    (SELECT count(*) FROM services x WHERE x.company_id = c.id) AS services,
    (SELECT count(*) FROM staff_conversations x WHERE x.company_id = c.id) AS staff_conversations,
    (SELECT count(*) FROM staff_conversation_members x WHERE x.company_id = c.id) AS staff_conversation_members,
    (SELECT count(*) FROM staff_messages x WHERE x.company_id = c.id) AS staff_messages,
    (SELECT count(*) FROM staff_devices x WHERE x.company_id = c.id) AS staff_devices,
    (SELECT count(*) FROM team_members x WHERE x.company_id = c.id) AS team_members
  FROM companies c
  ORDER BY c.id
`;

const TARGET_COMPANY_IDS = TEST_COMPANY_REPAIR_TARGETS.map(
  (candidate) => candidate.id,
);
const TARGET_COMPANY_ID_SQL = sql.raw(TARGET_COMPANY_IDS.join(", "));

const CROSS_COMPANY_REFERENCE_QUERY = sql`
  WITH target_companies(id) AS (
    SELECT unnest(ARRAY[${TARGET_COMPANY_ID_SQL}]::integer[])
  ),
  refs AS (
    SELECT 'booking_assignments.team_member_id' AS edge,
      b.company_id AS child_company_id, tm.company_id AS parent_company_id
    FROM booking_assignments x
    JOIN bookings b ON b.id = x.booking_id
    JOIN team_members tm ON tm.id = x.team_member_id
    UNION ALL
    SELECT 'booking_time_entries.booking_id',
      x.company_id, b.company_id
    FROM booking_time_entries x
    JOIN bookings b ON b.id = x.booking_id
    UNION ALL
    SELECT 'booking_time_entries.team_member_id',
      x.company_id, tm.company_id
    FROM booking_time_entries x
    JOIN team_members tm ON tm.id = x.team_member_id
    UNION ALL
    SELECT 'leads.converted_booking_id',
      x.company_id, b.company_id
    FROM leads x
    JOIN bookings b ON b.id = x.converted_booking_id
    UNION ALL
    SELECT 'saved_route_stops.linked_booking_id',
      r.company_id, b.company_id
    FROM saved_route_stops x
    JOIN saved_routes r ON r.id = x.route_id
    JOIN bookings b ON b.id = x.linked_booking_id
    UNION ALL
    SELECT 'calls.caller_id',
      x.company_id, ca.company_id
    FROM calls x
    JOIN callers ca ON ca.id = x.caller_id
    UNION ALL
    SELECT 'leads.call_id',
      x.company_id, c.company_id
    FROM leads x
    JOIN calls c ON c.id = x.call_id
    UNION ALL
    SELECT 'client_messages.thread_id',
      x.company_id, t.company_id
    FROM client_messages x
    JOIN client_threads t ON t.id = x.thread_id
    UNION ALL
    SELECT 'callers.client_id',
      x.company_id, cl.company_id
    FROM callers x
    JOIN clients cl ON cl.id = x.client_id
    UNION ALL
    SELECT 'cleaner_locations.team_member_id',
      x.company_id, tm.company_id
    FROM cleaner_locations x
    JOIN team_members tm ON tm.id = x.team_member_id
    UNION ALL
    SELECT 'cleaner_locations.device_id',
      x.company_id, d.company_id
    FROM cleaner_locations x
    JOIN staff_devices d ON d.id = x.device_id
    UNION ALL
    SELECT 'saved_routes.team_member_id',
      x.company_id, tm.company_id
    FROM saved_routes x
    JOIN team_members tm ON tm.id = x.team_member_id
    UNION ALL
    SELECT 'staff_conversation_members.conversation_id',
      x.company_id, c.company_id
    FROM staff_conversation_members x
    JOIN staff_conversations c ON c.id = x.conversation_id
    UNION ALL
    SELECT 'staff_conversation_members.member_id',
      x.company_id, tm.company_id
    FROM staff_conversation_members x
    JOIN team_members tm ON tm.id = x.member_id
    UNION ALL
    SELECT 'staff_conversations.created_by_member_id',
      x.company_id, tm.company_id
    FROM staff_conversations x
    JOIN team_members tm ON tm.id = x.created_by_member_id
    UNION ALL
    SELECT 'staff_devices.team_member_id',
      x.company_id, tm.company_id
    FROM staff_devices x
    JOIN team_members tm ON tm.id = x.team_member_id
    UNION ALL
    SELECT 'staff_messages.conversation_id',
      x.company_id, c.company_id
    FROM staff_messages x
    JOIN staff_conversations c ON c.id = x.conversation_id
    UNION ALL
    SELECT 'staff_messages.member_id',
      x.company_id, tm.company_id
    FROM staff_messages x
    JOIN team_members tm ON tm.id = x.member_id
    UNION ALL
    SELECT 'team_members.jobber_connection_id',
      x.company_id, jc.company_id
    FROM team_members x
    JOIN jobber_connections jc ON jc.id = x.jobber_connection_id
  )
  SELECT edge, count(*) AS count
  FROM refs r
  WHERE
    (EXISTS (SELECT 1 FROM target_companies t WHERE t.id = r.child_company_id))
    <>
    (EXISTS (SELECT 1 FROM target_companies t WHERE t.id = r.parent_company_id))
  GROUP BY edge
  ORDER BY edge
`;

function numberValue(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new CompanyRepairGuardError(
      "Company inventory returned an invalid count",
    );
  }
  return parsed;
}

async function readInventory(
  executor: SqlExecutor,
): Promise<CompanyRepairInventoryRow[]> {
  const result = await executor.execute(INVENTORY_QUERY);
  return (result.rows as Array<Record<string, unknown>>).map((row) => {
    const counts = {} as CompanyRepairCounts;
    for (const column of COMPANY_COUNT_COLUMNS) {
      counts[column] = numberValue(row[column]);
    }
    return {
      id: numberValue(row.id),
      ownerUserId: String(row.owner_user_id),
      ownerEmail: row.owner_email === null ? null : String(row.owner_email),
      name: String(row.name),
      jobberConnected: row.jobber_connected === true,
      jobberAccountId:
        row.jobber_account_id === null ? null : String(row.jobber_account_id),
      createdAt: String(row.created_at),
      counts,
    };
  });
}

function candidateMatchesRow(
  row: Pick<
    CompanyRepairInventoryRow,
    "id" | "ownerUserId" | "ownerEmail" | "name"
  >,
  candidate: (typeof TEST_COMPANY_REPAIR_TARGETS)[number],
): boolean {
  return (
    row.id === candidate.id &&
    row.ownerUserId === candidate.ownerUserId &&
    row.ownerEmail === candidate.ownerEmail &&
    row.name === candidate.name
  );
}

function candidateIdsPresent(companies: CompanyRepairInventoryRow[]): number[] {
  return TEST_COMPANY_REPAIR_TARGETS.filter((candidate) =>
    companies.some((row) => candidateMatchesRow(row, candidate)),
  )
    .map((candidate) => candidate.id)
    .sort((a, b) => a - b);
}

function reviewDigest(
  companies: CompanyRepairInventoryRow[],
  crossCompanyReferences: Array<{ edge: string; count: number }>,
  unreviewedCompanies: CompanyRepairAudit["unreviewedCompanies"],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        companies,
        crossCompanyReferences,
        unreviewedCompanies,
      }),
    )
    .digest("hex");
}

export function isAuthorizedLiveRepairOwner(
  company: {
    id: number;
    ownerUserId: string;
    ownerEmail: string | null;
    name: string;
    jobberConnected: boolean;
    jobberAccountId: string | null;
  },
  userId: string,
): boolean {
  return (
    userId === LIVE_COMPANY_REPAIR_FINGERPRINT.ownerUserId &&
    company.id === LIVE_COMPANY_REPAIR_FINGERPRINT.id &&
    company.ownerUserId === LIVE_COMPANY_REPAIR_FINGERPRINT.ownerUserId &&
    company.ownerEmail === LIVE_COMPANY_REPAIR_FINGERPRINT.ownerEmail &&
    company.name === LIVE_COMPANY_REPAIR_FINGERPRINT.name &&
    company.jobberConnected ===
      LIVE_COMPANY_REPAIR_FINGERPRINT.jobberConnected &&
    company.jobberAccountId === LIVE_COMPANY_REPAIR_FINGERPRINT.jobberAccountId
  );
}

export async function getCompanyRepairAudit(
  executor: SqlExecutor = db,
): Promise<CompanyRepairAudit> {
  // Enumerate every company and every dependent count, but retain identities
  // only for the protected company and exact reviewed deletion targets.
  const fullInventory = await readInventory(executor);
  const reviewedIds = new Set<number>([
    LIVE_COMPANY_REPAIR_FINGERPRINT.id,
    ...TARGET_COMPANY_IDS,
  ]);
  const companies = fullInventory.filter((company) =>
    reviewedIds.has(company.id),
  );
  const unreviewedInventory = fullInventory
    .filter((company) => !reviewedIds.has(company.id))
    .map(({ id, createdAt, counts }) => ({ id, createdAt, counts }));
  const unreviewedCompanies = {
    count: unreviewedInventory.length,
    totalDependentRows: unreviewedInventory.reduce(
      (total, company) =>
        total +
        Object.values(company.counts).reduce(
          (companyTotal, count) => companyTotal + count,
          0,
        ),
      0,
    ),
    inventoryDigest: createHash("sha256")
      .update(JSON.stringify(unreviewedInventory))
      .digest("hex"),
  };
  const crossResult = await executor.execute(CROSS_COMPANY_REFERENCE_QUERY);
  const crossCompanyReferences = (
    crossResult.rows as Array<Record<string, unknown>>
  ).map((row) => ({
    edge: String(row.edge),
    count: numberValue(row.count),
  }));
  return {
    reviewDigest: reviewDigest(
      companies,
      crossCompanyReferences,
      unreviewedCompanies,
    ),
    companies,
    candidateCompanyIds: candidateIdsPresent(companies),
    crossCompanyReferences,
    unreviewedCompanies,
  };
}

function candidateWhere(alias = "c"): SQL {
  return sql.join(
    TEST_COMPANY_REPAIR_TARGETS.map(
      (candidate) => sql`(
        ${sql.raw(`${alias}."id"`)} = ${candidate.id}
        AND ${sql.raw(`${alias}."owner_user_id"`)} = ${candidate.ownerUserId}
        AND ${sql.raw(`${alias}."owner_email"`)} IS NOT DISTINCT FROM ${candidate.ownerEmail}
        AND ${sql.raw(`${alias}."name"`)} = ${candidate.name}
      )`,
    ),
    sql` OR `,
  );
}

async function deleteCompanyData(executor: SqlExecutor): Promise<void> {
  // These two grandchildren must be removed before their company-scoped
  // parents. Every statement repeats the complete candidate fingerprint.
  await executor.execute(sql`
    DELETE FROM "booking_assignments"
    WHERE "booking_id" IN (
      SELECT b."id"
      FROM "bookings" b
      JOIN "companies" c ON c."id" = b."company_id"
      WHERE ${candidateWhere()}
    )
  `);
  await executor.execute(sql`
    DELETE FROM "saved_route_stops"
    WHERE "route_id" IN (
      SELECT r."id"
      FROM "saved_routes" r
      JOIN "companies" c ON c."id" = r."company_id"
      WHERE ${candidateWhere()}
    )
  `);

  // Messages and memberships refer to their threads/conversations, so they
  // are explicitly cleared before those parent rows.
  await executor.execute(sql`
    DELETE FROM "client_messages"
    WHERE "company_id" IN (
      SELECT c."id" FROM "companies" c WHERE ${candidateWhere()}
    )
  `);
  await executor.execute(sql`
    DELETE FROM "staff_messages"
    WHERE "company_id" IN (
      SELECT c."id" FROM "companies" c WHERE ${candidateWhere()}
    )
  `);
  await executor.execute(sql`
    DELETE FROM "staff_conversation_members"
    WHERE "company_id" IN (
      SELECT c."id" FROM "companies" c WHERE ${candidateWhere()}
    )
  `);

  const companyScopedTables = [
    "activity",
    "lead_sync_state",
    "leads",
    "pending_texts",
    "booking_time_entries",
    "bookings",
    "calls",
    "callers",
    "cleaner_locations",
    "client_threads",
    "clients",
    "homeowner_pins",
    "jobber_invoices",
    "jobber_quotes",
    "jobber_webhook_deliveries",
    "quo_webhooks",
    "quo_webhook_deliveries",
    "saved_routes",
    "services",
    "staff_conversations",
    "staff_devices",
    "team_members",
    "jobber_connections",
  ];
  for (const table of companyScopedTables) {
    await executor.execute(sql`
      DELETE FROM ${sql.raw(`"${table}"`)}
      WHERE "company_id" IN (
        SELECT c."id" FROM "companies" c WHERE ${candidateWhere()}
      )
    `);
  }

  await executor.execute(sql`
    DELETE FROM "companies" c
    WHERE ${candidateWhere()}
  `);
}

function assertLiveCompanyUnchanged(
  before: CompanyRepairInventoryRow,
  after: CompanyRepairInventoryRow | undefined,
): void {
  if (!after || JSON.stringify(before) !== JSON.stringify(after)) {
    throw new CompanyRepairGuardError(
      "The live Book My Cleaning company changed during the repair",
    );
  }
}

export async function lockCompanyRepairTables(tx: SqlExecutor): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('company-test-data-repair'))`,
  );
  await tx.execute(sql`
    LOCK TABLE
      "companies",
      "activity",
      "booking_assignments",
      "booking_time_entries",
      "bookings",
      "callers",
      "calls",
      "cleaner_locations",
      "client_messages",
      "client_threads",
      "clients",
      "homeowner_pins",
      "jobber_connections",
      "jobber_invoices",
      "jobber_quotes",
      "jobber_webhook_deliveries",
      "lead_sync_state",
      "leads",
      "pending_texts",
      "quo_webhooks",
      "quo_webhook_deliveries",
      "saved_route_stops",
      "saved_routes",
      "services",
      "staff_conversation_members",
      "staff_conversations",
      "staff_devices",
      "staff_messages",
      "team_members"
    IN SHARE ROW EXCLUSIVE MODE
  `);
}

export async function repairTestCompaniesInTransaction(
  tx: SqlExecutor,
  reviewedBy: string,
  expectedReviewDigest: string,
  requestedCompanyIds: number[],
): Promise<{
  reviewedBy: string;
  reviewDigest: string;
  deletedCompanyIds: number[];
  before: CompanyRepairAudit;
  after: CompanyRepairAudit;
  auditId: number;
  completedAt: string;
}> {
  await lockCompanyRepairTables(tx);

  const before = await getCompanyRepairAudit(tx);
  if (before.reviewDigest !== expectedReviewDigest) {
    throw new CompanyRepairGuardError(
      "The reviewed company inventory is stale; request a new review",
    );
  }

  const requested = [...new Set(requestedCompanyIds)].sort((a, b) => a - b);
  if (
    requested.length === 0 ||
    requested.some((id) => !before.candidateCompanyIds.includes(id)) ||
    requested.length !== before.candidateCompanyIds.length ||
    requested.some((id, index) => id !== before.candidateCompanyIds[index])
  ) {
    throw new CompanyRepairGuardError(
      "The requested companies do not exactly match the reviewed synthetic set",
    );
  }
  if (before.crossCompanyReferences.length !== 0) {
    throw new CompanyRepairGuardError(
      "A reviewed synthetic company has a cross-company reference; no data was removed",
    );
  }

  const liveBefore = before.companies.find(
    (company) => company.id === LIVE_COMPANY_REPAIR_FINGERPRINT.id,
  );
  if (
    !liveBefore ||
    liveBefore.ownerUserId !== LIVE_COMPANY_REPAIR_FINGERPRINT.ownerUserId ||
    liveBefore.ownerEmail !== LIVE_COMPANY_REPAIR_FINGERPRINT.ownerEmail ||
    liveBefore.name !== LIVE_COMPANY_REPAIR_FINGERPRINT.name ||
    liveBefore.jobberConnected !==
      LIVE_COMPANY_REPAIR_FINGERPRINT.jobberConnected ||
    liveBefore.jobberAccountId !==
      LIVE_COMPANY_REPAIR_FINGERPRINT.jobberAccountId
  ) {
    throw new CompanyRepairGuardError(
      "The protected live company fingerprint does not match",
    );
  }

  for (const candidate of TEST_COMPANY_REPAIR_TARGETS) {
    const row = before.companies.find((company) => company.id === candidate.id);
    if (!row || !candidateMatchesRow(row, candidate)) {
      throw new CompanyRepairGuardError(
        `Synthetic company ${candidate.id} no longer matches its reviewed fingerprint`,
      );
    }
  }

  await deleteCompanyData(tx);

  const after = await getCompanyRepairAudit(tx);
  assertLiveCompanyUnchanged(
    liveBefore,
    after.companies.find(
      (company) => company.id === LIVE_COMPANY_REPAIR_FINGERPRINT.id,
    ),
  );
  if (after.candidateCompanyIds.length !== 0) {
    throw new CompanyRepairGuardError(
      "At least one reviewed synthetic company remained after the repair",
    );
  }
  if (after.crossCompanyReferences.length !== 0) {
    throw new CompanyRepairGuardError(
      "A cross-company reference remained after the repair",
    );
  }

  const requestedCompanyIdsSql = sql.raw(`ARRAY[${requested.join(", ")}]`);
  const auditInsert = await tx.execute(sql`
    INSERT INTO "company_repair_audits" (
      "repair_key",
      "performed_by",
      "review_digest",
      "target_company_ids",
      "before_snapshot",
      "after_snapshot"
    )
    VALUES (
      'remove-stale-test-companies-2026-08',
      ${reviewedBy},
      ${expectedReviewDigest},
      ${requestedCompanyIdsSql},
      ${JSON.stringify(before)}::jsonb,
      ${JSON.stringify(after)}::jsonb
    )
    ON CONFLICT ("repair_key") DO NOTHING
    RETURNING "id", "completed_at"::text AS "completed_at"
  `);
  const auditRow = (
    auditInsert.rows as Array<{ id: unknown; completed_at: unknown }>
  )[0];
  if (!auditRow) {
    throw new CompanyRepairGuardError(
      "This production company cleanup already has a completed audit record",
    );
  }

  return {
    reviewedBy,
    reviewDigest: expectedReviewDigest,
    deletedCompanyIds: before.candidateCompanyIds,
    before,
    after,
    auditId: numberValue(auditRow.id),
    completedAt: String(auditRow.completed_at),
  };
}

export async function repairTestCompanies(
  reviewedBy: string,
  expectedReviewDigest: string,
  requestedCompanyIds: number[],
): ReturnType<typeof repairTestCompaniesInTransaction> {
  return db.transaction(async (tx) => {
    return repairTestCompaniesInTransaction(
      tx,
      reviewedBy,
      expectedReviewDigest,
      requestedCompanyIds,
    );
  });
}
