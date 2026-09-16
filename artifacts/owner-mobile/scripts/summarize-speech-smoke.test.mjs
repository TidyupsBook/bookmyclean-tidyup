import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ALLOWED_RECOGNIZER_ERRORS,
  readSpeechDiagnostics,
  renderSpeechSummary,
} from "./summarize-speech-smoke.mjs";

test("renders only the four approved diagnostic fields", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "speech-smoke-"));
  const logs = path.join(output, "flow", "logs");
  await mkdir(logs, { recursive: true });
  await writeFile(
    path.join(logs, "maestro.log"),
    [
      "other output",
      'SPEECH_SMOKE_DIAGNOSTICS_JSON {"platform":"ios","permission":"granted","recognizerError":"interrupted","lastTranscriptStage":"transcript-received","transcript":"private customer words","name":"Jane Doe"}',
    ].join("\n"),
  );

  const diagnostic = await readSpeechDiagnostics(output);
  const summary = renderSpeechSummary("iOS", diagnostic);

  assert.match(summary, /Platform \| ios/);
  assert.match(summary, /Permission \| granted/);
  assert.match(summary, /Recognizer error \| interrupted/);
  assert.match(summary, /Last transcript stage \| transcript-received/);
  assert.doesNotMatch(
    summary,
    /private customer words|Jane Doe|transcript \|/i,
  );
});

test("reports a missing record clearly", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "speech-smoke-"));
  await writeFile(path.join(output, "maestro.log"), "app process stopped");

  const summary = renderSpeechSummary(
    "Android",
    await readSpeechDiagnostics(output),
  );

  assert.match(summary, /No `SPEECH_SMOKE_DIAGNOSTICS_JSON` record was found/);
  assert.match(summary, /crashed or left the diagnostics screen/);
});

test("reports a missing output directory clearly", async () => {
  const diagnostic = await readSpeechDiagnostics(
    path.join(os.tmpdir(), "missing-speech-smoke-output"),
  );
  assert.equal(diagnostic, null);
});

test("rejects customer text hidden in any approved field", async () => {
  for (const field of [
    "platform",
    "permission",
    "recognizerError",
    "lastTranscriptStage",
  ]) {
    const output = await mkdtemp(path.join(os.tmpdir(), "speech-smoke-"));
    const record = {
      platform: "android",
      permission: "granted",
      recognizerError: "none",
      lastTranscriptStage: "listening",
      [field]: "Jane Doe at 123 Main Street",
    };
    await writeFile(
      path.join(output, "maestro.log"),
      `SPEECH_SMOKE_DIAGNOSTICS_JSON ${JSON.stringify(record)}`,
    );

    assert.equal(await readSpeechDiagnostics(output), null);
  }
});

test("ignores markers outside Maestro logs", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "speech-smoke-"));
  await writeFile(
    path.join(output, "other.log"),
    'SPEECH_SMOKE_DIAGNOSTICS_JSON {"platform":"ios","permission":"granted","recognizerError":"none","lastTranscriptStage":"listening"}',
  );

  assert.equal(await readSpeechDiagnostics(output), null);
});

test("accepts every recognizer error code emitted by the installed module", () => {
  assert.deepEqual(
    new Set(ALLOWED_RECOGNIZER_ERRORS),
    new Set([
      "none",
      "aborted",
      "audio-capture",
      "interrupted",
      "bad-grammar",
      "language-not-supported",
      "network",
      "no-speech",
      "not-allowed",
      "service-not-allowed",
      "busy",
      "client",
      "speech-timeout",
      "unknown",
    ]),
  );
});
