# Installed-build smoke tests

These flows exercise native capabilities that Expo Go does not contain. The
speech flow is intentionally a device test: it uses the installed
`expo-speech-recognition` module and the device microphone, rather than
replacing the recognizer with a fake.

## One-time setup

Install [Maestro](https://maestro.mobile.dev/) on the workstation running the
test, then create an installed development build:

```bash
# iOS device or simulator
pnpm --filter @workspace/owner-mobile exec expo run:ios --device

# Android device or emulator
pnpm --filter @workspace/owner-mobile exec expo run:android --device
```

The app identifiers are `com.bookmycleaning.ownermobile` on both platforms.
The first native build may take several minutes. Grant microphone permission
when iOS or Android asks for it.

## Run the speech smoke

Run the same flow on both platforms:

```bash
pnpm --filter @workspace/owner-mobile run smoke:ios
pnpm --filter @workspace/owner-mobile run smoke:android
```

Both scripts put Maestro's complete per-flow output in
`build/maestro-results/<platform>`. The physical-device GitHub Actions workflow
uploads that directory when a smoke fails.

## Release approval

Create a GitHub prerelease whose tag points at the immutable candidate commit
and attach these exact assets:

- `owner-mobile-ios.ipa`
- `owner-mobile-android.apk`

Publishing the prerelease starts the **Mobile release** workflow automatically.
The iOS and Android physical-device jobs check out the prerelease tag, download
their platform asset from that prerelease, install it on the configured device,
and run the speech smoke. Each job links the prerelease and records the installed
asset's SHA-256 digest and resolved candidate commit SHA in its run summary.

The iOS runner needs an `IOS_DEVICE_ID` repository variable and the Android
runner needs an `ANDROID_DEVICE_ID` repository variable. Missing variables,
missing assets, installation failures, unavailable runners, timeouts, and smoke
failures all prevent the approval job from running. The candidate remains a
prerelease, which is the blocked status. Only after both device jobs pass does
the approval job promote that same GitHub prerelease to a full release.

The **Physical-device speech smoke** workflow remains manually dispatchable for
diagnostics outside a release. Its prerelease tag is still required, and it
downloads and installs the tagged assets in the same way as the release gate.

The flow expects an owner session already signed in and opens the New booking
screen. With the call audio on speaker, say the following sentence,
pausing briefly at each `|`:

> Hi, this is Jane Doe. | My number is 780-555-0100. | The address is 123 Main
> Street, St. Albert, Alberta T8N 1N3.

The test waits for all three parts in the visible transcript. It then checks
the name, phone, and street fields populated from the booking-draft request.
Those checks catch both lost native result entries and a request that was sent
before the complete sentence was joined. While the flow waits, interrupt the
recognizer with an incoming phone call or another system audio session, then
return to the booking form. The flow verifies that capture paused recoverably
and did not restart itself. It starts listening once more, backgrounds and
returns to the app, and verifies that capture again stopped without restarting.
The Save action is never used; listening is an autofill action, not a booking
creation action.

## Failure diagnostics

The flow has an `onFlowComplete` hook that runs after a pass or failure. If a
wait/assertion fails while the speech capture line is still visible, the hook
copies only that line and emits one machine-readable record to the flow's
`logs/maestro.log`:

```text
SPEECH_SMOKE_DIAGNOSTICS_JSON {"platform":"ios","permission":"granted","recognizerError":"none","lastTranscriptStage":"transcript-received"}
```

The same flow and hook run for Android; the `platform` value is taken from the
installed app's live diagnostics line, not from the transcript. The JSON object
contains only `platform`, `permission`, `recognizerError`, and
`lastTranscriptStage`. It never includes the live transcript or any booking
fields.

Maestro stores the flow artifact bundle, including `logs/maestro.log`, in the
platform-specific output directory configured by the package scripts. The
equivalent direct Maestro commands are:

```bash
maestro test \
  --test-output-dir=build/maestro-results/ios \
  e2e/maestro/speech-smoke.yaml \
  --env PLATFORM=ios

maestro test \
  --test-output-dir=build/maestro-results/android \
  e2e/maestro/speech-smoke.yaml \
  --env PLATFORM=android
```

If the app has already stopped capture or left the booking screen when a
failure occurs, the conditional hook safely skips the record because there is
no current diagnostics snapshot to copy.

On failure, the physical-device workflow searches the output directory for the
record and adds a four-row table to the GitHub Actions run summary. The table
contains only `platform`, `permission`, `recognizerError`, and
`lastTranscriptStage`. If no valid record exists, the summary says that the app
may have crashed or left the diagnostics screen. It never copies surrounding
log output, transcript content, or booking fields into the summary.

If the device transcribes punctuation or “St. Albert” differently, the
sentence should still be spoken exactly as written. The three stable
assertions are deliberately limited to the name, phone, and street values.
