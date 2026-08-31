import { Router, type IRouter } from "express";
import { clerkClient } from "@clerk/express";
import { GetCurrentUserResponse } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { getCaller } from "../middlewares/requireRole";
import { logger } from "../lib/logger";
import { newCompaniesAllowedForHost } from "../lib/signupMode";
import { requestHost } from "../lib/requestHost";
import { canDispatchLiveCalls } from "../lib/callerRole";

const router: IRouter = Router();

router.use(requireAuth);

/**
 * What the dashboard needs to decide which navigation and actions to show.
 *
 * Deliberately never 403s: an account with no company yet is mid-onboarding,
 * and the setup wizard is what it should be sent to.
 */
router.get("/me", async (req, res): Promise<void> => {
  const caller = await getCaller(req);

  let name = caller.name;
  let email = caller.email;

  // The owner's display details live in Clerk, not our tables. Fetched only
  // here so the authorization path stays a pure database lookup.
  if (!name || !email) {
    try {
      const user = await clerkClient.users.getUser(req.userId!);
      email = email || (user.emailAddresses[0]?.emailAddress ?? "");
      name =
        name ||
        [user.firstName, user.lastName].filter(Boolean).join(" ") ||
        email;
    } catch (err) {
      logger.error({ err }, "[me] Clerk lookup failed; returning bare profile");
    }
  }

  res.json(
    GetCurrentUserResponse.parse({
      role: caller.role,
      teamMemberId: caller.teamMemberId,
      name,
      email,
      companyName: caller.company?.name ?? "",
      pendingCompanyName: caller.pendingCompanyName,
      // Whether the address this request came in on still hands out new
      // companies. Onboarding shows the join-code door alone when it
      // doesn't. Per-host, not per-deployment: the same build answers on the
      // closed live site and on the signup address at once.
      canCreateCompany: newCompaniesAllowedForHost(requestHost(req)),
      // Whether this account may take a booking off a live call — the alert,
      // the microphone panel, and the form-filling. Computed by the same
      // helper the call routes use, so the UI and the API can't disagree.
      canTakeLiveCalls: canDispatchLiveCalls(caller),
    }),
  );
});

export default router;
