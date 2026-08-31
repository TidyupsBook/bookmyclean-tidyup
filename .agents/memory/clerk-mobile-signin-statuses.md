---
name: Clerk future-API sign-in statuses on mobile
description: Why a phone sign-in stalls after a correct password, and what the app must drive itself.
---

`@clerk/expo` ships two different sign-in hooks under one name. The root import gives
the signal API (re-exported from `@clerk/react`, `useSignIn(): SignInSignalValue`); the
older resource API (`create` / `prepareFirstFactor` / `setActive`) lives behind the
`/legacy` subpath. This app uses the root, signal one — reviewers and docs frequently
assume the legacy shape, so pin it with a type-level contract rather than arguing.

The Clerk signal/"future" API (`useSignIn()` → `{ signIn, errors, fetchStatus }`) does
not throw when a password is accepted but the session isn't usable. Every call
answers `{ error }` and mutates `signIn.status`. A screen that only checks
`status === "complete"` looks broken on a phone.

**Rule:** after any sign-in call, re-read `signIn.status` and drive the outstanding
step in-app; only `finalize()` once the status is `complete`.

**Why:** the status that strands new phones is `needs_client_trust` — Clerk wants a
one-time code to trust an unrecognised device. It is not MFA, but Clerk exposes its
options through the *second*-factor list, so it must be handled on the same path as
`needs_second_factor`. Treating it as an unsupported state is what produces a
"sign in on the web dashboard first" dead end for someone whose only device is the phone.

**How to apply:** map the status set (`needs_identifier`, `needs_first_factor`,
`needs_second_factor`, `needs_client_trust`, `needs_new_password`,
`needs_protect_check`, `complete`) plus `supportedFirstFactors` /
`supportedSecondFactors` to a step, in pure code the screen just renders. Sending and
verifying differ by phase: first factor uses `signIn.emailCode` / `signIn.phoneCode`,
second factor uses `signIn.mfa.*`. Re-plan after every step — a first-factor code can
be followed by MFA.

Related: a stored session lives in SecureStore and loads asynchronously, so any gate
that reads `isSignedIn` must wait for `isLoaded`, and Clerk's `status` of `degraded` /
`error` means "can't confirm", never "signed out".
