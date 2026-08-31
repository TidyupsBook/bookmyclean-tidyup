import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { pool, db } from "@workspace/db";
import { logger } from "./logger";
import { writeBootFatal } from "./bootFatal";

/**
 * Run pending Drizzle migrations before the HTTP server accepts traffic.
 *
 * Migration state is tracked in `drizzle.__drizzle_migrations`.
 * Drizzle's migrate() skips any entry whose journal `when` timestamp is
 * <= the max `created_at` already in the tracking table.
 *
 * Baseline strategy for databases previously managed with drizzle-kit push:
 *
 * - Migration 0000 (full schema CREATE TABLE): baseline when `companies`
 *   table already exists. The CREATE TABLE would fail on an existing schema,
 *   so we mark 0000 as applied and let migrate() skip it.
 *
 * - Migration 0001 (additive ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT
 *   EXISTS): NEVER baselined. Because every statement in 0001 is idempotent,
 *   migrate() always runs it safely — it is a no-op on fully up-to-date
 *   databases and adds any missing columns on older ones.
 *
 * Fresh installs (no tables at all): no baseline; both migrations run.
 */
/**
 * Recognize the "database is asleep" failure: the platform pauses idle
 * production databases, and connecting to a paused endpoint fails with
 * SQLSTATE 28000 and an "endpoint has been disabled" message. The code is
 * checked first; the message text is only a secondary signal so an upstream
 * wording change does not silence the check.
 */
export function isPausedDatabaseError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (code !== "28000") return false;
  return (
    typeof message === "string" &&
    /endpoint.*(disabled|not active)|disabled.*endpoint/i.test(message)
  );
}

export const PAUSED_DATABASE_MESSAGE =
  "The production database is paused (asleep), so this publish cannot start. " +
  "Open the Database pane, unpause (enable) the database, and publish again.";

/**
 * Hand back a pooled client, retrying a few times before giving up.
 *
 * A deploy boots the new container while the old one is still serving and,
 * sometimes, while the platform is applying a schema change to the same
 * database. A single failed connect at that moment should not cost the whole
 * publish, but an endless wait is worse than a failure — every attempt is
 * logged so the reason ends up in the deploy logs either way.
 */
async function connectWithRetry(attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await pool.connect();
    } catch (err) {
      if (attempt >= attempts) {
        if (isPausedDatabaseError(err)) {
          // One plain line for the deploy log: the raw 28000 error alone reads
          // as gibberish to a non-technical owner. Written synchronously so it
          // survives the immediate exit that follows.
          writeBootFatal(PAUSED_DATABASE_MESSAGE);
          logger.error(PAUSED_DATABASE_MESSAGE);
        }
        logger.error(
          { err, attempt },
          "Could not connect to the database for migrations",
        );
        throw err;
      }
      logger.warn(
        { err, attempt },
        "Database connection failed; retrying before migrations",
      );
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
}

export async function runMigrations(): Promise<void> {
  // First line out of the process on every boot. If a deploy ever dies before
  // this appears, the failure is in module loading, not in the database.
  logger.info("Starting database migrations");

  const here = path.dirname(fileURLToPath(import.meta.url));
  const { existsSync } = await import("node:fs");
  const candidates = [
    path.resolve(here, "..", "migrations"), // production dist/
    path.resolve(here, "..", "..", "..", "lib", "db", "migrations"), // dev src/
    // Same repo layout, one level deeper: this module is under src/lib when a
    // test or a runner imports it directly rather than through the bundle.
    path.resolve(here, "..", "..", "..", "..", "lib", "db", "migrations"),
  ];
  const migrationsFolder = candidates.find(existsSync);
  if (!migrationsFolder) {
    throw new Error(
      `Drizzle migrations folder not found. Tried:\n${candidates.join("\n")}`,
    );
  }

  // Read the Drizzle journal to get migration timestamps.
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  type JournalEntry = { idx: number; tag: string; when: number };
  type Journal = { entries: JournalEntry[] };
  const journal: Journal = JSON.parse(await readFile(journalPath, "utf8"));

  const byTag = Object.fromEntries(journal.entries.map((e) => [e.tag, e]));

  // Getting a connection is the first thing this process does that can fail
  // slowly. A deploy gives the container about a minute to open its port, so a
  // database that is briefly unreachable (or busy applying a schema change
  // pushed by the same publish) must be retried and, above all, reported —
  // otherwise the deploy dies in silence.
  const client = await connectWithRetry();
  try {
    // Never wait indefinitely on a lock held by something else — a publish that
    // is mid-schema-change can hold one. Failing after 20s produces a log line
    // and a clean non-zero exit, which is diagnosable; blocking does not.
    await client.query(`SET lock_timeout = '20s'`);
    await client.query(`SET statement_timeout = '120s'`);

    // Bootstrap the migration tracking table in the drizzle schema.
    await client.query(`CREATE SCHEMA IF NOT EXISTS drizzle`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS drizzle."__drizzle_migrations" (
        id         serial  PRIMARY KEY,
        hash       text    NOT NULL,
        created_at bigint
      )
    `);

    // How many migrations have been recorded already?
    const { rows: countRows } = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM drizzle."__drizzle_migrations"`,
    );

    if (Number(countRows[0]?.count ?? 0) > 0) {
      // Migrations are already tracked — migrate() will apply any pending ones.
      logger.info("Migration tracking active; applying any pending migrations");
    } else {
      // No migration records yet. If the schema was previously set up via
      // drizzle-kit push, baseline only migration 0000 (the initial CREATE
      // TABLE script) to prevent it from failing on existing tables.
      // Migration 0001 is intentionally NOT baselined — it is fully idempotent
      // (all ADD COLUMN IF NOT EXISTS) and safe to run on any database state.
      const { rows: companiesRows } = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'companies'
        ) AS exists`,
      );

      if (companiesRows[0]?.exists) {
        const m0 = byTag["0000_spooky_spot"];
        if (m0) {
          logger.info(
            { tag: m0.tag },
            "Existing schema detected — baselining initial CREATE TABLE migration",
          );
          await client.query(
            `INSERT INTO drizzle."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
            [m0.tag, m0.when],
          );
        }
        // 0001 (additive upgrade) is intentionally left un-baselined so
        // migrate() always runs its idempotent ADD COLUMN IF NOT EXISTS
        // statements and brings any database up to the full current schema.
      }
    }
  } finally {
    // These timeouts were set on a session, and releasing a client hands that
    // same session back to the pool for ordinary request traffic. Left in
    // place, a 120s statement timeout would eventually cancel some unrelated
    // query on a busy connection. Reset them, and if the reset itself fails,
    // destroy the connection rather than return a mutated session.
    try {
      await client.query(`RESET lock_timeout`);
      await client.query(`RESET statement_timeout`);
      client.release();
    } catch (err) {
      logger.warn(
        { err },
        "Discarding migration connection after failed reset",
      );
      client.release(true);
    }
  }

  // Name every migration that is about to run BEFORE running it, in plain
  // synchronous stderr writes: if the process dies mid-apply, the deploy log
  // still shows exactly which files were pending. Drizzle applies entries in
  // journal order, skipping any whose `when` is <= the max created_at already
  // recorded, so the pending set is computable up front.
  const { rows: appliedRows } = await pool.query<{ max: string | null }>(
    `SELECT MAX(created_at) AS max FROM drizzle."__drizzle_migrations"`,
  );
  const appliedThrough = Number(appliedRows[0]?.max ?? 0);
  const pending = journal.entries.filter((e) => e.when > appliedThrough);

  if (pending.length === 0) {
    logger.info("No pending migrations");
  } else {
    logger.info(
      { pending: pending.map((e) => e.tag) },
      "Pending migrations to apply",
    );
  }

  logger.info({ migrationsFolder }, "Running database migrations");
  try {
    await migrate(db, { migrationsFolder });
  } catch (err) {
    // Work out which file failed: drizzle applies each migration in its own
    // transaction and records it on success, so the first entry still absent
    // from the tracking table is the one that blew up. Best effort — if even
    // this query fails, fall back to naming the whole pending set.
    let failedTag = pending.map((e) => e.tag).join(", ") || "(unknown)";
    try {
      const { rows } = await pool.query<{ max: string | null }>(
        `SELECT MAX(created_at) AS max FROM drizzle."__drizzle_migrations"`,
      );
      const nowThrough = Number(rows[0]?.max ?? 0);
      const firstUnapplied = journal.entries.find((e) => e.when > nowThrough);
      if (firstUnapplied) failedTag = firstUnapplied.tag;
    } catch {
      // keep the pending-set fallback
    }
    writeBootFatal(
      `Database migration failed while applying "${failedTag}" ` +
        `(from ${migrationsFolder})`,
      err,
    );
    throw err;
  }
  logger.info("Migrations complete");
}
