import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { pool, db } from "@workspace/db";
import { logger } from "./logger";

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
export async function runMigrations(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const { existsSync } = await import("node:fs");
  const candidates = [
    path.resolve(here, "..", "migrations"), // production dist/
    path.resolve(here, "..", "..", "..", "lib", "db", "migrations"), // dev src/
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

  const client = await pool.connect();
  try {
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
    client.release();
  }

  logger.info({ migrationsFolder }, "Running database migrations");
  await migrate(db, { migrationsFolder });
  logger.info("Migrations complete");
}
