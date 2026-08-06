import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import quoWebhookRouter, { QUO_WEBHOOK_PATH } from "./routes/quoWebhook";
import jobberWebhookRouter, {
  JOBBER_WEBHOOK_PATH,
} from "./routes/jobberWebhook";
import { WebhookHandlers } from "./lib/webhookHandlers";
import { logger } from "./lib/logger";

export const STRIPE_WEBHOOK_PATH = "/api/stripe/webhook";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

// CORS: explicit allowlist of this app's own origins only. Reflecting every
// origin (`origin: true`) with credentials enabled would let any website make
// authenticated requests with the victim's session cookie and read responses.
const allowedOrigins = new Set<string>(
  [
    ...(process.env.REPLIT_DOMAINS?.split(",") ?? []),
    process.env.REPLIT_DEV_DOMAIN,
  ]
    .map((d) => d?.trim())
    .filter((d): d is string => Boolean(d))
    .map((d) => `https://${d}`),
);

app.use(
  cors({
    credentials: true,
    origin: (origin, callback) => {
      // Non-browser or same-origin requests carry no Origin header; allow
      // them (no CORS headers are needed and none grant anything extra).
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
  }),
);

// Quo signs webhooks over the exact bytes it sent, so this one route must see
// the raw body. The raw parser is scoped to the webhook path only — mounting
// it on all of /api would leave every other route with a Buffer body, since
// body-parser skips once an earlier parser has consumed the request.
app.use(QUO_WEBHOOK_PATH, express.raw({ type: "application/json" }));
app.use("/api", quoWebhookRouter);

// Jobber also signs over the exact raw bytes (HMAC with the client secret).
app.use(JOBBER_WEBHOOK_PATH, express.raw({ type: "application/json" }));
app.use("/api", jobberWebhookRouter);

// Stripe signs over the raw bytes too, so it must be registered before
// express.json(). Scoped to this exact path for the same reason as the others:
// a raw parser mounted on all of /api would leave every route with a Buffer.
app.post(
  STRIPE_WEBHOOK_PATH,
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];
    if (!signature) {
      res.status(400).json({ error: "Missing stripe-signature" });
      return;
    }
    const sig = Array.isArray(signature) ? signature[0]! : signature;
    try {
      await WebhookHandlers.processWebhook(req.body as Buffer, sig);
      res.status(200).json({ received: true });
    } catch (err) {
      logger.error({ err }, "Stripe webhook processing failed");
      res.status(400).json({ error: "Webhook processing error" });
    }
  },
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

app.use("/api", router);

export default app;
