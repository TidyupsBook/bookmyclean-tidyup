import { describe, expect, it } from "vitest";
import {
  BLOCKED_MESSAGES,
  canResendCode,
  codeErrorMessage,
  codeStepSubtitle,
  planNextSignInStep,
} from "./sign-in-steps";

describe("planNextSignInStep", () => {
  it("finishes when the sign-in is already complete", () => {
    expect(planNextSignInStep({ status: "complete" })).toEqual({
      kind: "complete",
    });
  });

  it("collects the emailed code when a new device must be trusted", () => {
    expect(
      planNextSignInStep({
        status: "needs_client_trust",
        supportedSecondFactors: [
          { strategy: "email_code", safeIdentifier: "r***@crew.com" },
        ],
      }),
    ).toEqual({
      kind: "code",
      phase: "second",
      channel: "email_code",
      sentTo: "r***@crew.com",
    });
  });

  it("collects a second factor for MFA accounts", () => {
    expect(
      planNextSignInStep({
        status: "needs_second_factor",
        supportedSecondFactors: [{ strategy: "totp" }],
      }),
    ).toEqual({
      kind: "code",
      phase: "second",
      channel: "totp",
      sentTo: null,
    });
  });

  it("prefers the emailed code over an authenticator app", () => {
    const step = planNextSignInStep({
      status: "needs_second_factor",
      supportedSecondFactors: [
        { strategy: "backup_code" },
        { strategy: "totp" },
        { strategy: "email_code", safeIdentifier: "r***@crew.com" },
      ],
    });
    expect(step).toMatchObject({ kind: "code", channel: "email_code" });
  });

  it("drives a first-factor code when the password isn't enough on its own", () => {
    expect(
      planNextSignInStep({
        status: "needs_first_factor",
        supportedFirstFactors: [
          { strategy: "phone_code", safeIdentifier: "+1 ••• ••• 1234" },
        ],
      }),
    ).toEqual({
      kind: "code",
      phase: "first",
      channel: "phone_code",
      sentTo: "+1 ••• ••• 1234",
    });
  });

  it("points a Google-only account at the Google button", () => {
    expect(
      planNextSignInStep({
        status: "needs_first_factor",
        supportedFirstFactors: [{ strategy: "oauth_google" }],
      }),
    ).toEqual({ kind: "blocked", message: BLOCKED_MESSAGES.googleOnly });
  });

  it("never tells anyone to go find the web dashboard", () => {
    const statuses = [
      "needs_identifier",
      "needs_new_password",
      "needs_protect_check",
      "something_new_from_clerk",
    ];
    for (const status of statuses) {
      const step = planNextSignInStep({ status });
      expect(step.kind).toBe("blocked");
      const message = step.kind === "blocked" ? step.message : "";
      expect(message.toLowerCase()).not.toContain("dashboard");
      // Each dead end has to say what the person should actually do.
      expect(message.length).toBeGreaterThan(30);
    }
  });

  it("blocks with a plain-language message when no factor can be collected", () => {
    expect(
      planNextSignInStep({
        status: "needs_second_factor",
        supportedSecondFactors: [],
      }),
    ).toEqual({
      kind: "blocked",
      message: BLOCKED_MESSAGES.noSupportedFactor,
    });
  });
});

describe("code step copy", () => {
  it("only offers a resend for codes the app can send again", () => {
    expect(canResendCode("email_code")).toBe(true);
    expect(canResendCode("phone_code")).toBe(true);
    expect(canResendCode("totp")).toBe(false);
    expect(canResendCode("backup_code")).toBe(false);
  });

  it("names the destination when Clerk gives one", () => {
    expect(codeStepSubtitle("email_code", "r***@crew.com")).toContain(
      "r***@crew.com",
    );
    expect(codeStepSubtitle("email_code", null)).toContain("emailed");
  });
});

describe("codeErrorMessage", () => {
  it("tells the user to retry a wrong code", () => {
    expect(codeErrorMessage({ code: "form_code_incorrect" })).toMatch(
      /didn't match/i,
    );
  });

  it("tells the user to send a new one when the code expired", () => {
    expect(codeErrorMessage({ code: "verification_expired" })).toMatch(
      /expired/i,
    );
  });

  it("falls back to Clerk's own message", () => {
    expect(
      codeErrorMessage({ code: "weird_error", message: "Something specific." }),
    ).toBe("Something specific.");
  });

  it("still says something useful with nothing to go on", () => {
    expect(codeErrorMessage({})).toMatch(/try again/i);
  });
});
