import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The boot pass that moves Quo webhooks onto the canonical domain must be a
 * strict no-op without an explicit pin, and a partial registration failure
 * must clean up after itself — otherwise a domain change either mass-moves
 * hooks to an inferred dev host or leaves duplicates delivering twice.
 */

type HookRow = {
  companyId: number;
  quoWebhookId: string;
  signingKey: string;
  events: string[];
  url: string;
};

let hooks: HookRow[];
let companies: Array<{ id: number; quoNumberIds: string[] }>;

vi.mock("@workspace/db", () => {
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const rows = async () =>
          table === "HOOKS" ? [...hooks] : [...companies];
        return {
          where: rows,
          then: (resolve: (r: unknown[]) => void) => void rows().then(resolve),
        };
      },
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        delete: () => ({
          where: async () => {
            hooks = hooks.filter((h) => h.companyId !== txCompanyId);
          },
        }),
        insert: () => ({
          values: async (vals: HookRow[]) => {
            hooks.push(...vals);
          },
        }),
      };
      return fn(tx);
    },
  };
  return {
    db,
    companiesTable: "COMPANIES",
    quoWebhooksTable: "HOOKS",
  };
});

// The delete in the transaction needs to know which company is in play; the
// mocked `eq` records it.
let txCompanyId: number;
vi.mock("drizzle-orm", () => ({
  eq: (_a: unknown, b: unknown) => {
    txCompanyId = b as number;
    return { eq: b };
  },
  inArray: (_a: unknown, b: unknown) => ({ inArray: b }),
}));

const companyQuoKey = vi.fn((): string | null => "test-key");
vi.mock("./company", () => ({
  companyQuoKey: (...args: unknown[]) => companyQuoKey(...(args as [])),
}));

const createCallWebhook = vi.fn();
const createTranscriptWebhook = vi.fn();
const createSummaryWebhook = vi.fn();
const createMessageWebhook = vi.fn();
const deleteWebhook = vi.fn(async (_key: string, _id: string) => {});
vi.mock("./quo", () => ({
  get createCallWebhook() {
    return createCallWebhook;
  },
  get createTranscriptWebhook() {
    return createTranscriptWebhook;
  },
  get createSummaryWebhook() {
    return createSummaryWebhook;
  },
  get createMessageWebhook() {
    return createMessageWebhook;
  },
  get deleteWebhook() {
    return deleteWebhook;
  },
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { reconcileQuoWebhookUrls } from "./quoWebhookReconcile";

const PIN = "https://bookmycleaning.net";
const NEW_URL = `${PIN}/api/webhooks/quo`;
const OLD_URL = "https://old-host.replit.app/api/webhooks/quo";

function record(id: string, url = NEW_URL) {
  return { id, key: `sign-${id}`, events: ["e"], url };
}

beforeEach(() => {
  vi.clearAllMocks();
  companyQuoKey.mockReturnValue("test-key");
  process.env.PUBLIC_APP_URL = PIN;
  companies = [{ id: 1, quoNumberIds: ["PN1"] }];
  hooks = [
    {
      companyId: 1,
      quoWebhookId: "old-1",
      signingKey: "s",
      events: ["e"],
      url: OLD_URL,
    },
    {
      companyId: 1,
      quoWebhookId: "old-2",
      signingKey: "s",
      events: ["e"],
      url: OLD_URL,
    },
  ];
  createCallWebhook.mockResolvedValue(record("new-call"));
  createTranscriptWebhook.mockResolvedValue(record("new-transcript"));
  createSummaryWebhook.mockResolvedValue(record("new-summary"));
  createMessageWebhook.mockResolvedValue(record("new-message"));
});

describe("reconcileQuoWebhookUrls", () => {
  it("does nothing at all without an explicit PUBLIC_APP_URL pin", async () => {
    delete process.env.PUBLIC_APP_URL;
    process.env.REPLIT_DEV_DOMAIN = "workspace.replit.dev";
    await reconcileQuoWebhookUrls();
    expect(createCallWebhook).not.toHaveBeenCalled();
    expect(deleteWebhook).not.toHaveBeenCalled();
    expect(hooks.map((h) => h.quoWebhookId)).toEqual(["old-1", "old-2"]);
  });

  it("re-registers stale hooks on the pinned URL, then removes the old ones", async () => {
    await reconcileQuoWebhookUrls();
    expect(createCallWebhook).toHaveBeenCalledWith(
      "test-key",
      NEW_URL,
      ["PN1"],
      "bookmycleaning-1-calls",
    );
    expect(hooks).toHaveLength(4);
    expect(hooks.every((h) => h.url === NEW_URL)).toBe(true);
    expect(deleteWebhook).toHaveBeenCalledWith("test-key", "old-1");
    expect(deleteWebhook).toHaveBeenCalledWith("test-key", "old-2");
  });

  it("leaves companies already on the pinned URL untouched", async () => {
    hooks = hooks.map((h) => ({ ...h, url: NEW_URL }));
    await reconcileQuoWebhookUrls();
    expect(createCallWebhook).not.toHaveBeenCalled();
    expect(deleteWebhook).not.toHaveBeenCalled();
  });

  it("rolls back every created hook when one registration fails, keeping the old setup", async () => {
    createSummaryWebhook.mockRejectedValue(new Error("quo 500"));
    await reconcileQuoWebhookUrls();
    // The three that succeeded were cleaned up on Quo's side...
    expect(deleteWebhook).toHaveBeenCalledWith("test-key", "new-call");
    expect(deleteWebhook).toHaveBeenCalledWith("test-key", "new-transcript");
    expect(deleteWebhook).toHaveBeenCalledWith("test-key", "new-message");
    // ...and the old registration was neither swapped out nor deleted.
    expect(hooks.map((h) => h.quoWebhookId)).toEqual(["old-1", "old-2"]);
    expect(deleteWebhook).not.toHaveBeenCalledWith("test-key", "old-1");
    expect(deleteWebhook).not.toHaveBeenCalledWith("test-key", "old-2");
  });

  it("skips a company with no usable key without touching its registration", async () => {
    companyQuoKey.mockReturnValue(null);
    await reconcileQuoWebhookUrls();
    expect(createCallWebhook).not.toHaveBeenCalled();
    expect(createTranscriptWebhook).not.toHaveBeenCalled();
    expect(createSummaryWebhook).not.toHaveBeenCalled();
    expect(createMessageWebhook).not.toHaveBeenCalled();
    expect(deleteWebhook).not.toHaveBeenCalled();
    expect(hooks.map((h) => h.quoWebhookId)).toEqual(["old-1", "old-2"]);
  });

  it("skips a company with no selected lines without touching its registration", async () => {
    companies = [{ id: 1, quoNumberIds: [] }];
    await reconcileQuoWebhookUrls();
    expect(createCallWebhook).not.toHaveBeenCalled();
    expect(deleteWebhook).not.toHaveBeenCalled();
    expect(hooks.map((h) => h.quoWebhookId)).toEqual(["old-1", "old-2"]);
  });

  it("re-registers cloned rows without killing the other environment's hooks", async () => {
    // A freshly provisioned production database carries the dev workspace's
    // webhook rows. Re-registering on the pinned domain must not delete the
    // dev registration — that is the workspace's live ingestion, not a stale
    // copy of production's.
    const DEV_URL = "https://abc-123.riker.replit.dev/api/webhooks/quo";
    hooks = hooks.map((h) => ({ ...h, url: DEV_URL }));
    await reconcileQuoWebhookUrls();
    expect(hooks).toHaveLength(4);
    expect(hooks.every((h) => h.url === NEW_URL)).toBe(true);
    expect(deleteWebhook).not.toHaveBeenCalledWith("test-key", "old-1");
    expect(deleteWebhook).not.toHaveBeenCalledWith("test-key", "old-2");
  });

  it("only deletes the old hooks after the new rows are committed", async () => {
    const order: string[] = [];
    createCallWebhook.mockImplementation(async () => {
      order.push("create");
      return record("new-call");
    });
    deleteWebhook.mockImplementation(async (_key: string, id: string) => {
      order.push(
        `delete-${id}:${hooks.some((h) => h.url === NEW_URL) ? "after-swap" : "before-swap"}`,
      );
    });
    await reconcileQuoWebhookUrls();
    expect(order).toEqual([
      "create",
      "delete-old-1:after-swap",
      "delete-old-2:after-swap",
    ]);
  });
});
