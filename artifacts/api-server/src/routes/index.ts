import { Router, type IRouter } from "express";
import healthRouter from "./health";
import companyRouter from "./company";
import phoneRouter from "./phone";
import servicesRouter from "./services";
import teamRouter from "./team";
import meRouter from "./me";
import callsRouter from "./calls";
import bookingsRouter from "./bookings";
import dashboardRouter from "./dashboard";
import mapRouter from "./map";
import scheduleRouter from "./schedule";
import staffRouter from "./staff";
import publicQuoteRouter from "./publicQuote";
// Note: the Quo webhook receiver is mounted in app.ts ahead of the JSON body
// parser so it can verify signatures against the raw request bytes.

const router: IRouter = Router();

router.use(healthRouter);
// Unauthenticated by design — the customer's quote link. Mounted ahead of the
// dashboard routers purely for readability; each router applies its own auth.
router.use(publicQuoteRouter);
router.use(companyRouter);
router.use(phoneRouter);
router.use(servicesRouter);
router.use(meRouter);
router.use(teamRouter);
router.use(callsRouter);
router.use(bookingsRouter);
router.use(dashboardRouter);
router.use(mapRouter);
router.use(scheduleRouter);
router.use(staffRouter);

export default router;
