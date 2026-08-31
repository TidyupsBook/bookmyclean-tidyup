/**
 * Works out what a half-finished Clerk sign-in still needs.
 *
 * The password can be accepted while the session is not yet usable: Clerk may
 * still want a second factor, or want to trust this device (a brand new phone)
 * before it hands over a session. The app drives those steps itself — the old
 * behaviour was to give up and tell people to go find a computer, which is a
 * dead end when the phone is the only device they have on the job.
 *
 * Pure on purpose: the screen only renders what this returns.
 */

/** How the outstanding code reaches the user. */
export type CodeChannel = "email_code" | "phone_code" | "totp" | "backup_code";

export type SignInStep =
  | { kind: "complete" }
  | {
      kind: "code";
      /** Which verification slot the code is answering. */
      phase: "first" | "second";
      channel: CodeChannel;
      /** Masked address/number Clerk says the code goes to, when it says. */
      sentTo: string | null;
    }
  | { kind: "blocked"; message: string };

type FactorLike = {
  strategy: string;
  safeIdentifier?: string | null;
};

export type SignInSnapshot = {
  status: string | null | undefined;
  supportedFirstFactors?: readonly FactorLike[] | null;
  supportedSecondFactors?: readonly FactorLike[] | null;
};

/**
 * Codes we can collect, best first. The emailed code comes first because every
 * account has an email address; the authenticator app and backup codes only
 * exist for people who deliberately set them up.
 */
const FIRST_FACTOR_ORDER: CodeChannel[] = ["email_code", "phone_code"];
const SECOND_FACTOR_ORDER: CodeChannel[] = [
  "email_code",
  "phone_code",
  "totp",
  "backup_code",
];

/**
 * Plain-language dead ends. None of them name the web dashboard on its own —
 * each says what the person actually has to do next.
 */
export const BLOCKED_MESSAGES = {
  needsIdentifier:
    "We couldn't start sign-in with that email. Check the address and try again.",
  googleOnly:
    "This account signs in with Google. Tap “Continue with Google” below.",
  noSupportedFactor:
    "This account needs a sign-in method this app doesn't offer yet. Ask your office to switch you to an email-and-password login, then sign in here.",
  needsNewPassword:
    "Your password has expired and needs replacing before you can sign in. Set a new one, then come back and sign in with it.",
  needsProtectCheck:
    "We couldn't finish a security check on this device. Check your connection and try again — if it keeps happening, ask your office to re-invite you.",
  unknown:
    "Sign-in couldn't be finished on this device. Check your connection and try again — if it keeps happening, ask your office to re-invite you.",
} as const;

function pickFactor(
  factors: readonly FactorLike[] | null | undefined,
  order: CodeChannel[],
): FactorLike | null {
  if (!factors?.length) return null;
  for (const strategy of order) {
    const match = factors.find((factor) => factor.strategy === strategy);
    if (match) return match;
  }
  return null;
}

function codeStep(phase: "first" | "second", factor: FactorLike): SignInStep {
  return {
    kind: "code",
    phase,
    channel: factor.strategy as CodeChannel,
    sentTo: factor.safeIdentifier ?? null,
  };
}

/** Whether the account can only get in through an SSO provider. */
function isSsoOnly(factors: readonly FactorLike[] | null | undefined): boolean {
  if (!factors?.length) return false;
  return factors.every(
    (factor) =>
      factor.strategy.startsWith("oauth_") ||
      factor.strategy === "enterprise_sso",
  );
}

/**
 * Given the state of a sign-in attempt, say what the screen should do next.
 */
export function planNextSignInStep(signIn: SignInSnapshot): SignInStep {
  switch (signIn.status) {
    case "complete":
      return { kind: "complete" };

    case "needs_identifier":
      return { kind: "blocked", message: BLOCKED_MESSAGES.needsIdentifier };

    case "needs_first_factor": {
      const factor = pickFactor(
        signIn.supportedFirstFactors,
        FIRST_FACTOR_ORDER,
      );
      if (factor) return codeStep("first", factor);
      if (isSsoOnly(signIn.supportedFirstFactors)) {
        return { kind: "blocked", message: BLOCKED_MESSAGES.googleOnly };
      }
      return { kind: "blocked", message: BLOCKED_MESSAGES.noSupportedFactor };
    }

    // A new phone is "untrusted" until one code clears; Clerk models that with
    // the same second-factor list as MFA, so both go down the same path.
    case "needs_second_factor":
    case "needs_client_trust": {
      const factor = pickFactor(
        signIn.supportedSecondFactors,
        SECOND_FACTOR_ORDER,
      );
      if (factor) return codeStep("second", factor);
      return { kind: "blocked", message: BLOCKED_MESSAGES.noSupportedFactor };
    }

    case "needs_new_password":
      return { kind: "blocked", message: BLOCKED_MESSAGES.needsNewPassword };

    case "needs_protect_check":
      return { kind: "blocked", message: BLOCKED_MESSAGES.needsProtectCheck };

    default:
      return { kind: "blocked", message: BLOCKED_MESSAGES.unknown };
  }
}

/** Heading shown above the code box. */
export function codeStepTitle(channel: CodeChannel): string {
  switch (channel) {
    case "email_code":
      return "Check your email";
    case "phone_code":
      return "Check your texts";
    case "totp":
      return "Open your authenticator app";
    case "backup_code":
      return "Use a backup code";
  }
}

/** Sub-heading: where the code came from, when we know. */
export function codeStepSubtitle(
  channel: CodeChannel,
  sentTo: string | null,
): string {
  switch (channel) {
    case "email_code":
      return sentTo
        ? `Enter the code we sent to ${sentTo}`
        : "Enter the code we just emailed you";
    case "phone_code":
      return sentTo
        ? `Enter the code we texted to ${sentTo}`
        : "Enter the code we just texted you";
    case "totp":
      return "Enter the 6-digit code from your authenticator app";
    case "backup_code":
      return "Enter one of the backup codes you saved";
  }
}

/** Codes we sent can be sent again; codes the user generates cannot. */
export function canResendCode(channel: CodeChannel): boolean {
  return channel === "email_code" || channel === "phone_code";
}

/**
 * Turns a Clerk verification failure into something worth reading. A wrong
 * code has to look like "try again", never like a stuck screen.
 */
export function codeErrorMessage(error: {
  code?: string;
  message?: string;
}): string {
  switch (error.code) {
    case "verification_expired":
    case "verification_failed":
      return "That code has expired. Send a new one and try again.";
    case "form_code_incorrect":
    case "verification_invalid":
      return "That code didn't match. Check it and try again, or send a new one.";
    case "too_many_requests":
      return "Too many tries. Wait a minute, then send a new code.";
    default:
      return (
        error.message ??
        "That code didn't work. Check it and try again, or send a new one."
      );
  }
}
