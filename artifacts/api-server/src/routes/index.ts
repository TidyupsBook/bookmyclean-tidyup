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
import savedRoutesRouter from "./savedRoutes";
import scheduleRouter from "./schedule";
import staffRouter from "./staff";
import clientMessagesRouter from "./clientMessages";
import staffChatRouter from "./staffChat";
import leadsRouter from "./leads";
import clientsRouter from "./clients";
import callersRouter from "./callers";
import searchRouter from "./search";
import jobberQuotesRouter from "./jobberQuotes";
import jobberInvoicesRouter from "./jobberInvoices";
import publicQuoteRouter from "./publicQuote";
import publicRequestRouter from "./publicRequest";
import customerTagsRouter from "./customerTags";
// Note: the Quo webhook receiver is mounted in app.ts ahead of the JSON body
// parser so it can verify signatures against the raw request bytes.

const router: IRouter = Router();

router.use(healthRouter);
// Unauthenticated by design — the customer's quote link and the public
// request form. Mounted ahead of the dashboard routers purely for
// readability; each router applies its own auth.
router.use(publicQuoteRouter);
router.use(publicRequestRouter);
router.use(companyRouter);
router.use(phoneRouter);
router.use(servicesRouter);
router.use(meRouter);
router.use(teamRouter);
router.use(callsRouter);
router.use(bookingsRouter);
router.use(dashboardRouter);
router.use(mapRouter);
router.use(savedRoutesRouter);
router.use(scheduleRouter);
router.use(staffRouter);
router.use(clientMessagesRouter);
router.use(staffChatRouter);
router.use(leadsRouter);
router.use(clientsRouter);
router.use(callersRouter);
router.use(searchRouter);
router.use(jobberQuotesRouter);
router.use(jobberInvoicesRouter);
router.use(customerTagsRouter);

export default router;
