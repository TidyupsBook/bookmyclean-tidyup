import { appendFile, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RECORD_PREFIX = "SPEECH_SMOKE_DIAGNOSTICS_JSON ";
const FIELD_LABELS = [
  ["platform", "Platform"],
  ["permission", "Permission"],
  ["recognizerError", "Recognizer error"],
  ["lastTranscriptStage", "Last transcript stage"],
];
export const ALLOWED_RECOGNIZER_ERRORS = [
  "none",
  "unknown",
  "no-speech",
  "speech-timeout",
  "aborted",
  "not-allowed",
  "service-not-allowed",
  "audio-capture",
  "network",
  "language-not-supported",
  "interrupted",
  "busy",
  "bad-grammar",
  "client",
];
const ALLOWED_VALUES = {
  platform: new Set(["ios", "android"]),
  permission: new Set(["not-requested", "granted", "denied", "error"]),
  recognizerError: new Set(ALLOWED_RECOGNIZER_ERRORS),
  lastTranscriptStage: new Set([
    "not-started",
    "permission-requested",
    "permission-denied",
    "recognizer-starting",
    "listening",
    "transcript-received",
    "recognizer-error",
    "reconnecting",
    "stopped",
    "extraction-requested",
    "extraction-succeeded",
    "extraction-failed",
  ]),
};

async function findFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? findFiles(entryPath) : [entryPath];
    }),
  );
  return nested.flat();
}

export async function readSpeechDiagnostics(outputDirectory) {
  let files;
  try {
    files = await findFiles(outputDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }

  let diagnostic = null;
  for (const file of files
    .filter((file) => path.basename(file) === "maestro.log")
    .sort()) {
    let contents;
    try {
      contents = await readFile(file, "utf8");
    } catch {
      continue;
    }

    for (const line of contents.split(/\r?\n/)) {
      const markerIndex = line.indexOf(RECORD_PREFIX);
      if (markerIndex < 0) continue;
      try {
        const parsed = JSON.parse(
          line.slice(markerIndex + RECORD_PREFIX.length),
        );
        if (
          parsed &&
          FIELD_LABELS.every(
            ([field]) =>
              typeof parsed[field] === "string" &&
              ALLOWED_VALUES[field].has(parsed[field]),
          )
        ) {
          diagnostic = Object.fromEntries(
            FIELD_LABELS.map(([field]) => [field, parsed[field]]),
          );
        }
      } catch {
        // Keep searching: an earlier/truncated marker must not hide a later record.
      }
    }
  }
  return diagnostic;
}

function markdownCell(value) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
}

export function renderSpeechSummary(platform, diagnostic) {
  const heading = `## ${platform} speech-smoke diagnostics\n\n`;
  if (!diagnostic) {
    return (
      heading +
      "No `SPEECH_SMOKE_DIAGNOSTICS_JSON` record was found. The app may have " +
      "crashed or left the diagnostics screen before Maestro's completion hook ran.\n"
    );
  }

  const rows = FIELD_LABELS.map(
    ([field, label]) => `| ${label} | ${markdownCell(diagnostic[field])} |`,
  ).join("\n");
  return `${heading}| Field | Value |\n| --- | --- |\n${rows}\n`;
}

async function main() {
  const [platform, outputDirectory] = process.argv.slice(2);
  if (!platform || !outputDirectory) {
    throw new Error(
      "Usage: node scripts/summarize-speech-smoke.mjs <platform> <output-directory>",
    );
  }

  const diagnostic = await readSpeechDiagnostics(outputDirectory);
  const summary = renderSpeechSummary(platform, diagnostic);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) await appendFile(summaryPath, summary);
  else process.stdout.write(summary);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
