import { and, eq } from "drizzle-orm";
import {
  db,
  bookingsTable,
  callsTable,
  clientsTable,
  jobberInvoicesTable,
  leadsTable,
} from "@workspace/db";
import { toE164 } from "./quo";

export type CustomerTag = "client" | "good_lead" | "bad_lead" | "spam" | null;
export type CustomerTagKind =
  "lead" | "call" | "booking" | "invoice" | "client";

type Target = { kind: CustomerTagKind; id: number };

function normalizedPhone(value: string | null | undefined): string | null {
  return toE164(value ?? "");
}

/**
 * A phone number is the only identity shared by all five surfaces. Updating
 * every matching local row keeps existing lead/call tags compatible while
 * making the verdict follow the customer into bookings, invoices and Clients.
 * Rows with no usable phone are updated only by their own kind/id.
 */
export async function setCustomerTag(
  companyId: number,
  target: Target,
  tag: CustomerTag,
): Promise<void> {
  const phones = new Set<string>();
  let targetPhone: string | null = null;

  if (target.kind === "lead") {
    const [row] = await db
      .select({ phone: leadsTable.phoneE164 })
      .from(leadsTable)
      .where(
        and(eq(leadsTable.id, target.id), eq(leadsTable.companyId, companyId)),
      );
    targetPhone = normalizedPhone(row?.phone);
  } else if (target.kind === "call") {
    const [row] = await db
      .select({ phone: callsTable.callerPhone })
      .from(callsTable)
      .where(
        and(eq(callsTable.id, target.id), eq(callsTable.companyId, companyId)),
      );
    targetPhone = normalizedPhone(row?.phone);
  } else if (target.kind === "booking") {
    const [row] = await db
      .select({ phone: bookingsTable.customerPhone })
      .from(bookingsTable)
      .where(
        and(
          eq(bookingsTable.id, target.id),
          eq(bookingsTable.companyId, companyId),
        ),
      );
    targetPhone = normalizedPhone(row?.phone);
  } else if (target.kind === "invoice") {
    const [row] = await db
      .select({ phone: jobberInvoicesTable.clientPhone })
      .from(jobberInvoicesTable)
      .where(
        and(
          eq(jobberInvoicesTable.id, target.id),
          eq(jobberInvoicesTable.companyId, companyId),
        ),
      );
    targetPhone = normalizedPhone(row?.phone);
  } else {
    const [row] = await db
      .select({ phone: clientsTable.phoneE164 })
      .from(clientsTable)
      .where(
        and(
          eq(clientsTable.id, target.id),
          eq(clientsTable.companyId, companyId),
        ),
      );
    targetPhone = normalizedPhone(row?.phone);
  }
  if (targetPhone) phones.add(targetPhone);

  const updateByPhone = async (
    table:
      | typeof leadsTable
      | typeof callsTable
      | typeof bookingsTable
      | typeof clientsTable
      | typeof jobberInvoicesTable,
    phoneColumn: any,
  ) => {
    if (!targetPhone) return;
    const rows = await db
      .select({ id: table.id, phone: phoneColumn })
      .from(table)
      .where(eq(table.companyId, companyId));
    await Promise.all(
      rows
        .filter(
          (row) =>
            normalizedPhone(row.phone) &&
            phones.has(normalizedPhone(row.phone)!),
        )
        .map((row) =>
          db
            .update(table)
            .set({ tag })
            .where(and(eq(table.id, row.id), eq(table.companyId, companyId))),
        ),
    );
  };

  await updateByPhone(leadsTable, leadsTable.phoneE164);
  await updateByPhone(callsTable, callsTable.callerPhone);
  await updateByPhone(bookingsTable, bookingsTable.customerPhone);
  await updateByPhone(clientsTable, clientsTable.phoneE164);
  await updateByPhone(jobberInvoicesTable, jobberInvoicesTable.clientPhone);

  if (target.kind === "lead" && !targetPhone)
    await db
      .update(leadsTable)
      .set({ tag })
      .where(
        and(eq(leadsTable.id, target.id), eq(leadsTable.companyId, companyId)),
      );
  if (target.kind === "call" && !targetPhone)
    await db
      .update(callsTable)
      .set({ tag })
      .where(
        and(eq(callsTable.id, target.id), eq(callsTable.companyId, companyId)),
      );
  if (target.kind === "booking" && !targetPhone)
    await db
      .update(bookingsTable)
      .set({ tag })
      .where(
        and(
          eq(bookingsTable.id, target.id),
          eq(bookingsTable.companyId, companyId),
        ),
      );
  if (target.kind === "invoice" && !targetPhone)
    await db
      .update(jobberInvoicesTable)
      .set({ tag })
      .where(
        and(
          eq(jobberInvoicesTable.id, target.id),
          eq(jobberInvoicesTable.companyId, companyId),
        ),
      );
  if (target.kind === "client" && !targetPhone)
    await db
      .update(clientsTable)
      .set({ tag })
      .where(
        and(
          eq(clientsTable.id, target.id),
          eq(clientsTable.companyId, companyId),
        ),
      );
}
