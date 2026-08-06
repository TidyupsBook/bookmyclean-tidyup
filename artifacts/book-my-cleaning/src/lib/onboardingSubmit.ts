/**
 * Orchestrates the onboarding submit: create the company, then (if the owner
 * gave one) save the notification number via the existing update endpoint.
 *
 * Kept free of React so the create-then-update flow — including the failed
 * number-save path — is unit-testable. Re-running after a failed number save
 * is safe: company creation is idempotent server-side (returns the existing
 * company).
 */
export type OnboardingSubmitResult =
  { outcome: "done" } | { outcome: "number_save_failed"; error: unknown };

export async function runOnboardingSubmit(deps: {
  createCompany: () => Promise<unknown>;
  saveNotificationNumber: (notificationNumber: string) => Promise<unknown>;
  notificationNumber: string;
}): Promise<OnboardingSubmitResult> {
  // A create failure propagates — the caller's mutation state handles it.
  await deps.createCompany();

  const number = deps.notificationNumber.trim();
  if (!number) return { outcome: "done" };

  try {
    await deps.saveNotificationNumber(number);
    return { outcome: "done" };
  } catch (error) {
    // Don't swallow this: the owner just typed the number so outage texts
    // reach them from day one. The caller must surface it and let them retry.
    return { outcome: "number_save_failed", error };
  }
}
