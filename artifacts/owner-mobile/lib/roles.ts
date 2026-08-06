import type { CurrentUserRole } from "@workspace/api-client-react";

/**
 * Whether a signed-in user may see business operations detail — quote
 * pricing, deposits, and Jobber sync state. Cleaners get the job essentials
 * (when, where, who) and nothing about the money.
 */
export function canSeeBusinessDetails(
  role: CurrentUserRole | undefined,
): boolean {
  // Unknown role means "not proven allowed" — never default open.
  if (!role) return false;
  return role !== "cleaner";
}
