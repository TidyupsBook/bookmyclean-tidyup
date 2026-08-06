import { Router, type IRouter } from "express";
import { clerkClient } from "@clerk/express";
import { GetCurrentUserResponse } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { getCaller } from "../middlewares/requireRole";
import { logger } from "../lib/logger";

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
    }),
  );
});

export default router;
