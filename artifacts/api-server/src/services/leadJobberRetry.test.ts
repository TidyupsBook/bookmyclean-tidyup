/**
 * The automatic retry must be selective: only a due, failed website-form lead
 * for an active Jobber connection may re-enter the existing push queue.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
});

vi.mock("./leadJobberPush", async () => {
  const actual =
    await vi.importActual<typeof import("./leadJobberPush")>(
      "./leadJobberPush",
    );
  return {
    ...actual,
    queueLeadPush: vi.fn(async (_company, lead) => ({
      status: "skipped" as const,
      reason: "test",
      lead,
    })),
  };
});

import { db, pool, companiesTable, leadsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { queueLeadPush } from "./leadJobberPush";
import {
  LEAD_JOBBER_MAX_AUTOMATIC_ATTEMPTS,
  LEAD_JOBBER_RETRY_BASE_DELAY_MS,
  leadJobberRetryDue,
  runLeadJobberRetryCycle,
  startLeadJobberRetry,
} from "./leadJobberRetry";

const mockedQueueLeadPush = vi.mocked(queueLeadPush);
const runId = `${Date.now()}_${process.pid}`;
let companyId: number;
let disconnectedCompanyId: number;
let sequence = 0;

async function makeLead(
  over: Record<string, unknown> = {},
  targetCompanyId: number = companyId,
) {
  sequence += 1;
  const [lead] = await db
    .insert(leadsTable)
    .values({
      companyId: targetCompanyId,
      source: "form",
      externalId: `lead-jobber-retry-${runId}-${sequence}`,
      sourceTab: "Website request form",
      jobberPushError: "Jobber is unavailable",
      jobberPushErrorAt: new Date(
        Date.now() - LEAD_JOBBER_RETRY_BASE_DELAY_MS - 1,
      ),
      jobberPushAttempts: 1,
      ...over,
    })
    .returning();
  return lead!;
}

beforeAll(async () => {
  const [company] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: `lead_retry_owner_${runId}`,
      name: `Lead retry ${runId}`,
      timezone: "America/Edmonton",
      jobberConnected: true,
      jobberAccessToken: "enc",
      jobberRefreshToken: "enc",
    })
    .returning();
  companyId = company!.id;

  const [disconnected] = await db
    .insert(companiesTable)
    .values({
      ownerUserId: `lead_retry_disconnected_${runId}`,
      name: `Lead retry disconnected ${runId}`,
      timezone: "America/Edmonton",
      jobberConnected: false,
    })
    .returning();
  disconnectedCompanyId = disconnected!.id;
});

afterAll(async () => {
  await db.delete(leadsTable).where(eq(leadsTable.companyId, companyId));
  await db
    .delete(leadsTable)
    .where(eq(leadsTable.companyId, disconnectedCompanyId));
  await db.delete(companiesTable).where(eq(companiesTable.id, companyId));
  await db
    .delete(companiesTable)
    .where(eq(companiesTable.id, disconnectedCompanyId));
  await pool.end();
});

beforeEach(async () => {
  mockedQueueLeadPush.mockClear();
  await db.delete(leadsTable).where(eq(leadsTable.companyId, companyId));
  await db
    .delete(leadsTable)
    .where(eq(leadsTable.companyId, disconnectedCompanyId));
});

describe("leadJobberRetry", () => {
  it("re-queues only due, retryable website-form failures", async () => {
    const due = await makeLead();
    await makeLead({
      jobberPushErrorAt: new Date(),
    });
    await makeLead({
      jobberPushAttempts: LEAD_JOBBER_MAX_AUTOMATIC_ATTEMPTS,
    });
    await makeLead({ source: "sheet" });
    await makeLead({ status: "dismissed" });
    await makeLead({ jobberSynced: true });
    await makeLead({}, disconnectedCompanyId);

    const queued = await runLeadJobberRetryCycle();

    expect(queued).toBe(1);
    expect(mockedQueueLeadPush).toHaveBeenCalledTimes(1);
    expect(mockedQueueLeadPush).toHaveBeenCalledWith(
      expect.objectContaining({ id: companyId }),
      expect.objectContaining({ id: due.id }),
    );
  });

  it("uses the failure timestamp and attempt count for bounded exponential backoff", () => {
    const now = Date.now();
    expect(
      leadJobberRetryDue(
        {
          jobberPushErrorAt: new Date(now - LEAD_JOBBER_RETRY_BASE_DELAY_MS),
          jobberPushAttempts: 1,
        },
        now,
      ),
    ).toBe(true);
    expect(
      leadJobberRetryDue(
        {
          jobberPushErrorAt: new Date(now - LEAD_JOBBER_RETRY_BASE_DELAY_MS),
          jobberPushAttempts: 2,
        },
        now,
      ),
    ).toBe(false);
    expect(
      leadJobberRetryDue(
        {
          jobberPushErrorAt: new Date(now - 7 * 24 * 60 * 60 * 1000),
          jobberPushAttempts: LEAD_JOBBER_MAX_AUTOMATIC_ATTEMPTS,
        },
        now,
      ),
    ).toBe(false);
  });

  it("does not start the poller in a dev workspace without a public URL pin", () => {
    const savedPin = process.env.PUBLIC_APP_URL;
    delete process.env.PUBLIC_APP_URL;
    const spy = vi.spyOn(globalThis, "setInterval");
    try {
      startLeadJobberRetry();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      if (savedPin === undefined) delete process.env.PUBLIC_APP_URL;
      else process.env.PUBLIC_APP_URL = savedPin;
    }
  });
});
