import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Without this, a database that accepts the TCP connection but never
  // completes the handshake leaves every caller waiting forever. During a
  // deploy that silence is fatal and undiagnosable: the container is killed
  // for not opening its port and the logs contain nothing at all. Ten seconds
  // then a real error is always better than an unbounded hang.
  connectionTimeoutMillis: 10_000,
});
export const db = drizzle(pool, { schema });

export * from "./schema";
