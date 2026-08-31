/**
 * Boot-time migrations must not leave a mark on the connection pool.
 *
 * The bootstrap step sets a lock timeout and a statement timeout so a deploy
 * fails loudly instead of hanging until the container is killed. Those are
 * session settings, and releasing a client hands the same session back for
 * ordinary request traffic — so a 120s statement timeout escaping into the
 * pool would silently cancel some unrelated query hours later.
 */
import { afterAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.LOG_LEVEL = "silent";
});

import { pool } from "@workspace/db";
import { isPausedDatabaseError, runMigrations } from "./migrate";

afterAll(async () => {
  await pool.end();
});

describe("isPausedDatabaseError", () => {
  it("recognizes a 28000 disabled-endpoint error", () => {
    const err = Object.assign(
      new Error(
        "The endpoint has been disabled. Enable it using the API and retry.",
      ),
      { code: "28000" },
    );
    expect(isPausedDatabaseError(err)).toBe(true);
  });

  it("ignores unrelated connection errors", () => {
    // Same wording, wrong code — the SQLSTATE gates the check.
    const wrongCode = Object.assign(
      new Error("The endpoint has been disabled."),
      { code: "ECONNREFUSED" },
    );
    expect(isPausedDatabaseError(wrongCode)).toBe(false);

    // Right code, different auth failure — message is the secondary signal.
    const wrongMessage = Object.assign(
      new Error("password authentication failed"),
      { code: "28000" },
    );
    expect(isPausedDatabaseError(wrongMessage)).toBe(false);

    expect(isPausedDatabaseError(null)).toBe(false);
    expect(isPausedDatabaseError("28000")).toBe(false);
  });
});

describe("runMigrations", () => {
  it("leaves pooled sessions with default timeouts", async () => {
    // Idempotent: every migration is already applied in the test database, so
    // this exercises the bootstrap and reset path without changing schema.
    await runMigrations();

    const client = await pool.connect();
    try {
      const statement = await client.query<{ statement_timeout: string }>(
        "SHOW statement_timeout",
      );
      const lock = await client.query<{ lock_timeout: string }>(
        "SHOW lock_timeout",
      );
      expect(statement.rows[0]?.statement_timeout).toBe("0");
      expect(lock.rows[0]?.lock_timeout).toBe("0");
    } finally {
      client.release();
    }
  });
});
