import { writeSync } from "node:fs";
import { inspect } from "node:util";

/**
 * Write a fatal boot-phase error synchronously to stderr.
 *
 * The pino logger runs its transports in worker threads, so any lines still
 * buffered there are lost when the process exits immediately after a fatal
 * error — which is exactly what happens when a migration fails during a
 * publish. The deployment log then shows nothing from the app at all.
 *
 * fs.writeSync(2, ...) bypasses every stream and worker: the bytes are on
 * stderr before this function returns, so they survive an immediate
 * process.exit(1).
 */
const REPORTED = Symbol.for("bootFatal.reported");

/** True when writeBootFatal has already printed this error's full detail. */
export function alreadyReported(err: unknown): boolean {
  return typeof err === "object" && err !== null && REPORTED in err;
}

export function writeBootFatal(message: string, err?: unknown): void {
  const lines = [`FATAL [boot]: ${message}`];
  if (err !== undefined && alreadyReported(err)) {
    // Full detail was printed by an earlier, closer-to-the-cause call; a
    // second copy of the same stack would only bury it.
    lines.push("(error detail above)");
    err = undefined;
  }
  if (err !== undefined) {
    if (typeof err === "object" && err !== null) {
      try {
        Object.defineProperty(err, REPORTED, { value: true });
      } catch {
        // frozen error — fine, worst case it prints twice
      }
    }
    if (err instanceof Error) {
      lines.push(err.stack ?? `${err.name}: ${err.message}`);
      // Postgres errors carry the interesting detail outside .message/.stack.
      const pg = err as Error & {
        code?: unknown;
        detail?: unknown;
        where?: unknown;
      };
      if (pg.code) lines.push(`  code: ${String(pg.code)}`);
      if (pg.detail) lines.push(`  detail: ${String(pg.detail)}`);
      if (pg.where) lines.push(`  where: ${String(pg.where)}`);
      if (err.cause !== undefined) {
        lines.push(`  cause: ${inspect(err.cause, { depth: 4 })}`);
      }
    } else {
      lines.push(inspect(err, { depth: 4 }));
    }
  }
  const text = lines.join("\n") + "\n";
  try {
    writeSync(2, text);
  } catch {
    // Last resort — better an async console.error than nothing at all.
    console.error(text);
  }
}
