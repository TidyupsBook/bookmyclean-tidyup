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
import { HEALTHZ_PATH } from "./routes/health";
import quoWebhookRouter, { QUO_WEBHOOK_PATH } from "./routes/quoWebhook";
import jobberWebhookRouter, {
  JOBBER_WEBHOOK_PATH,
} from "./routes/jobberWebhook";
import { WebhookHandlers } from "./lib/webhookHandlers";
import { canonicalHostRedirect } from "./middlewares/canonicalHost";
import { logger } from "./lib/logger";

export const STRIPE_WEBHOOK_PATH = "/api/stripe/webhook";
export const JOBBER_OAUTH_CALLBACK_PATH = "/api/company/jobber/callback";

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

// The deployment healthcheck probes bare `/api` on a non-canonical host.
// Answer it before the canonical-host redirect: a 301 sends the checker out
// to the public domain (where it times out), and falling through to the
// authenticated router returns 401 — either way the platform counts the
// deploy unhealthy. Registered app-level and first so no middleware can get
// in front of it.
app.get("/api", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// Fold every alias host (the default .replit.app domain, bookcleaning.app once
// it is linked here) into the canonical domain. No-op unless PUBLIC_APP_URL is
// pinned, which only production sets. Webhook receivers and the OAuth callback
// are exempt: third parties call those on whatever host they were registered
// with, and a bounced signed POST is a silently dropped event. The health
// probe is exempt too: the deployment checker calls it on a non-canonical
// host (localhost) and a 301 makes it follow the redirect out to the public
// domain and time out — the platform then declares the app unhealthy and
// restart-loops the whole deployment.
app.use(
  canonicalHostRedirect([
    QUO_WEBHOOK_PATH,
    JOBBER_WEBHOOK_PATH,
    STRIPE_WEBHOOK_PATH,
    JOBBER_OAUTH_CALLBACK_PATH,
    HEALTHZ_PATH,
  ]),
);

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

// Allow any origin for browser clients and the app's own API consumers.
// This intentionally reflects the request's Origin header while credentials
// remain enabled so the app can be reached from arbitrary frontends.
app.use(
  cors({
    credentials: true,
    origin: true,
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
