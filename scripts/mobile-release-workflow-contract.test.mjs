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
const downloader = readFileSync(
  new URL("./download-private-release-asset.sh", import.meta.url),
  "utf8",
);

test("candidate metadata and both build links reach the device workflow", () => {
  assert.match(
    approval,
    /uses: \.\/\.github\/workflows\/physical-device-speech-smoke\.yml/,
  );
  for (const input of [
    "candidate_ref",
    "expected_candidate_sha",
    "ios_build_url",
    "android_build_url",
  ]) {
    assert.match(approval, new RegExp(`\\n\\s{6}${input}:`));
    assert.match(device, new RegExp(`\\n\\s{6}${input}:`));
    assert.match(device, new RegExp(`inputs\\.${input}`));
  }
  assert.match(
    approval,
    /candidate_sha: \$\{\{ steps\.candidate_metadata\.outputs\.candidate_sha \}\}/,
  );
  assert.match(
    approval,
    /expected_candidate_sha: \$\{\{ needs\.private-asset-downloads\.outputs\.candidate_sha \}\}/,
  );
});

test("both device jobs verify the pinned candidate SHA before installing", () => {
  assert.match(
    approval,
    /id: candidate_metadata[\s\S]*?candidate_sha=\$\(git rev-parse HEAD\)/,
  );

  for (const platform of ["iOS", "Android"]) {
    const verification = new RegExp(
      `- name: Verify ${platform} candidate commit[\\s\\S]*?EXPECTED_CANDIDATE_SHA: \\$\\{\\{ inputs\\.expected_candidate_sha \\}\\}[\\s\\S]*?test -n "\\$EXPECTED_CANDIDATE_SHA" && test "\\$\\(git rev-parse HEAD\\)" = "\\$EXPECTED_CANDIDATE_SHA"[\\s\\S]*?- name: Download and install ${platform} candidate`,
    );
    assert.match(device, verification);
  }
});

test("approval always runs and rejects failed, cancelled, or missing device results", () => {
  assert.match(
    approval,
    /\n\s{4}if: always\(\) && github\.event_name == 'release'/,
  );
  assert.match(
    approval,
    /needs: \[validate-workflows, private-asset-downloads, physical-device-speech\]/,
  );
  assert.match(
    approval,
    /ASSET_DOWNLOAD_RESULT: \$\{\{ needs\.private-asset-downloads\.result \}\}/,
  );
  assert.match(approval, /test "\$ASSET_DOWNLOAD_RESULT" = success/);
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

test("private prerelease assets are fetched before device runners start", () => {
  assert.match(approval, /\n\s{2}private-asset-downloads:/);
  assert.match(
    approval,
    /scripts\/download-private-release-asset\.sh \\\n\s+iOS "\$IOS_BUILD_URL"/,
  );
  assert.match(
    approval,
    /scripts\/download-private-release-asset\.sh \\\n\s+Android "\$ANDROID_BUILD_URL"/,
  );
  assert.match(
    approval,
    /\n\s{2}physical-device-speech:[\s\S]*?needs: \[validate-workflows, private-asset-downloads\]/,
  );

  for (const platform of ["iOS", "Android"]) {
    assert.match(
      device,
      new RegExp(
        `\\.\\./\\.\\./scripts/download-private-release-asset\\.sh \\\\\\n\\s+${platform}`,
      ),
    );
  }
});

test("the shared downloader follows safe redirects and identifies platform failures", () => {
  assert.match(downloader, /--location/);
  assert.doesNotMatch(downloader, /--location-trusted/);
  assert.match(downloader, /Authorization: Bearer \$GH_TOKEN/);
  assert.match(
    downloader,
    /Could not fetch the \$platform private release asset/,
  );
  assert.match(
    downloader,
    /The \$platform private release asset download was empty/,
  );
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
  assert.match(
    approval,
    /scripts\/mobile-release-workflow-contract\.test\.mjs/,
  );
});
