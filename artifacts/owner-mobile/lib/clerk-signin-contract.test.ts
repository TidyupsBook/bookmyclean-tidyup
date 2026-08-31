/**
 * Pins the sign-in code to the Clerk API this app actually installs.
 *
 * `@clerk/expo` ships two sign-in hooks: the signal API re-exported from
 * `@clerk/react` (what the app's root import gives you) and the older resource
 * API parked behind the `/legacy` subpath. They are not interchangeable — the
 * signal resource has `password()`, `emailCode`, `mfa` and `finalize()`, the
 * legacy one has `create()` / `prepareFirstFactor()` / `setActive()`.
 *
 * The assignments below are checked by `tsc` against the installed types, so
 * swapping the import to `@clerk/expo/legacy` — or upgrading to a Clerk that
 * drops these members — fails typecheck instead of failing on a phone.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { useSignIn } from "@clerk/expo";
import type { SignInSnapshot } from "./sign-in-steps";

type SignInResource = ReturnType<typeof useSignIn>["signIn"];

/** The planner reads exactly these fields off the real resource. */
const _snapshotAcceptsTheRealResource = (
  signIn: SignInResource,
): SignInSnapshot => signIn;

/** Every call the sign-in screen makes, resolved against the installed types. */
const _callsTheScreenMakes = (signIn: SignInResource) => [
  signIn.password,
  signIn.finalize,
  signIn.reset,
  signIn.emailCode.sendCode,
  signIn.emailCode.verifyCode,
  signIn.phoneCode.sendCode,
  signIn.phoneCode.verifyCode,
  signIn.mfa.sendEmailCode,
  signIn.mfa.verifyEmailCode,
  signIn.mfa.sendPhoneCode,
  signIn.mfa.verifyPhoneCode,
  signIn.mfa.verifyTOTP,
  signIn.mfa.verifyBackupCode,
];

/** The statuses the planner switches on all exist in the installed types. */
const _statusesWeHandle: SignInResource["status"][] = [
  "needs_identifier",
  "needs_first_factor",
  "needs_second_factor",
  "needs_client_trust",
  "needs_new_password",
  "complete",
];

void _snapshotAcceptsTheRealResource;
void _callsTheScreenMakes;
void _statusesWeHandle;

describe("installed Clerk sign-in API", () => {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("@clerk/expo/package.json");
  const root = dirname(pkgPath);

  it("takes useSignIn from the signal API, not the legacy subpath", () => {
    const hooks = readFileSync(join(root, "dist/hooks/index.d.ts"), "utf8");
    expect(hooks).toMatch(/useSignIn[\s\S]*from '@clerk\/react'/);
    expect(hooks).not.toContain("@clerk/react/legacy");
  });

  it("bundles a clerk-js that implements the device-trust flow", () => {
    // The strings only exist in the signal implementation; if a future bump
    // drops them, the phone can't finish a new-device sign-in.
    // clerk-js is @clerk/expo's own dependency, so read it from beside it.
    const clerkJs = readFileSync(
      join(root, "../clerk-js/dist/clerk.mjs"),
      "utf8",
    );
    expect(clerkJs).toContain("needs_client_trust");
    expect(clerkJs).toContain("verifyBackupCode");
  });
});
