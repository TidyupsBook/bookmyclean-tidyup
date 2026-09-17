import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const approval = readFileSync(
  new URL("../.github/workflows/mobile-release-approval.yml", import.meta.url),
  "utf8",
);
const device = readFileSync(
  new URL(
    "../.github/workflows/physical-device-speech-smoke.yml",
    import.meta.url,
  ),
  "utf8",
);

test("candidate ref and both build links reach the device workflow", () => {
  assert.match(
    approval,
    /uses: \.\/\.github\/workflows\/physical-device-speech-smoke\.yml/,
  );
  for (const input of ["candidate_ref", "ios_build_url", "android_build_url"]) {
    assert.match(approval, new RegExp(`\\n\\s{6}${input}:`));
    assert.match(device, new RegExp(`\\n\\s{6}${input}:`));
    assert.match(device, new RegExp(`inputs\\.${input}`));
  }
});

test("approval always runs and rejects failed, cancelled, or missing device results", () => {
  assert.match(
    approval,
    /\n\s{4}if: always\(\) && github\.event_name == 'release'/,
  );
  assert.match(
    approval,
    /needs: \[validate-workflows, physical-device-speech\]/,
  );
  assert.match(
    approval,
    /IOS_RESULT: \$\{\{ needs\.physical-device-speech\.outputs\.ios_result \}\}/,
  );
  assert.match(
    approval,
    /ANDROID_RESULT: \$\{\{ needs\.physical-device-speech\.outputs\.android_result \}\}/,
  );
  assert.match(approval, /test "\$IOS_RESULT" = success/);
  assert.match(approval, /test "\$ANDROID_RESULT" = success/);

  assert.match(device, /\n\s{2}results:\n[\s\S]*?\n\s{4}if: always\(\)/);
  assert.match(device, /ios_result: \$\{\{ needs\.ios\.result \}\}/);
  assert.match(device, /android_result: \$\{\{ needs\.android\.result \}\}/);
});

test("CI syntax validation covers both mobile workflows", () => {
  assert.match(approval, /\n\s{2}pull_request:/);
  assert.match(approval, /uses: docker:\/\/rhysd\/actionlint:1\.7\.12/);
  assert.match(
    approval,
    /run: node --test scripts\/mobile-release-workflow-contract\.test\.mjs/,
  );
  assert.match(approval, /\.github\/workflows\/mobile-release-approval\.yml/);
  assert.match(
    approval,
    /\.github\/workflows\/physical-device-speech-smoke\.yml/,
  );
});
