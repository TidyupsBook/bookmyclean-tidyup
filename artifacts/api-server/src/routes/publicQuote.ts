import { Router, type IRouter } from "express";
import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  bookingsTable,
  companiesTable,
  servicesTable,
  activityTable,
  type Booking,
  type Company,
} from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  GetPublicQuoteParams,
  ApprovePublicQuoteParams,
  PayPublicQuoteParams,
  RefreshPublicQuotePaymentParams,
} from "@workspace/api-zod";
import { computeQuoteTotals, formatAppointment } from "../lib/quotes";
import { publicBaseUrl } from "../lib/publicUrl";
import { getUncachableStripeClient } from "../lib/stripeClient";
import { logger } from "../lib/logger";

/**
 * The customer's own view of their quote.
 *
 * Deliberately NOT behind requireAuth: the customer is tapping a link in a text
 * message and will never have an account. The token in the URL is the
 * authorisation, so it must be unguessable and the response must carry only
 * what belongs on that customer's estimate — never a company-wide listing and
 * never anything keyed by a guessable booking id.
 */
const router: IRouter = Router();

/** 128 bits of randomness, URL-safe. Long enough that guessing is hopeless. */
export function newQuoteToken(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * Bookings created before share links existed — or priced but never sent —
 * have no token yet. Mint one on first need rather than backfilling every row,
 * and reuse it forever after so a link already in a customer's phone keeps
 * working.
 */
export async function ensureQuoteToken(booking: Booking): Promise<string> {
  if (booking.quoteToken) return booking.quoteToken;
  const token = newQuoteToken();
  await db
    .update(bookingsTable)
    .set({ quoteToken: token })
    .where(eq(bookingsTable.id, booking.id));
  booking.quoteToken = token;
  return token;
}

export function quoteUrl(token: string): string {
  return `${publicBaseUrl()}/quote/${token}`;
}

/** Date only, in the company's timezone — "August 4, 2026". */
function formatDay(when: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone,
    }).format(when);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(when);
  }
}

/**
 * Deposits are taken in Canadian dollars — the tax and fee defaults this app
 * ships with are Alberta's, and the only accounts on it are Canadian.
 */
const DEPOSIT_CURRENCY = "cad";

/** The deposit the customer owes, in cents, or null when nothing is due. */
function depositCents(company: Company, booking: Booking): number | null {
  const totals =
    booking.quoteSentTotals ?? computeQuoteTotals(company, booking);
  // Fall back to the full total when the company takes no deposit, so the pay
  // button still collects something rather than erroring on a $0 session.
  const amount = totals.deposit > 0 ? totals.deposit : totals.total;
  const cents = Math.round(amount * 100);
  // Stripe rejects anything under 50 cents in CAD.
  return cents >= 50 ? cents : null;
}

/**
 * Record a cleared deposit exactly once.
 *
 * The `deposit_paid_at IS NULL` guard settles the winner in the database, so
 * the redirect back from Checkout and the reconcile pass can both run without
 * double-posting to the dispatcher's feed.
 */
async function claimDepositPaid(
  company: Company,
  booking: Booking,
  amountTotalCents: number | null,
): Promise<Booking> {
  const [claimed] = await db
    .update(bookingsTable)
    .set({
      depositPaidAt: new Date(),
      depositPaidAmount:
        amountTotalCents != null ? amountTotalCents / 100 : null,
    })
    .where(
      and(
        eq(bookingsTable.id, booking.id),
        eq(bookingsTable.companyId, company.id),
        isNull(bookingsTable.depositPaidAt),
      ),
    )
    .returning();

  if (!claimed) return booking;

  try {
    const amount =
      amountTotalCents != null
        ? `$${(amountTotalCents / 100).toFixed(2)}`
        : "their deposit";
    await db.insert(activityTable).values({
      companyId: company.id,
      type: "deposit_paid",
      message: `${booking.customerName} paid ${amount} toward ${booking.service}.`,
    });
  } catch (err) {
    // The money is recorded; a missing feed entry must not undo that.
    logger.error(
      { err, bookingId: booking.id },
      "Deposit recorded but the activity entry failed",
    );
  }

  return claimed;
}

/**
 * Promote a booking to paid using the locally synced copy of Stripe's data.
 *
 * Cheap enough to run on every page view because it is one indexed lookup and
 * only happens while a deposit is outstanding. This is what catches the
 * customer who pays and then closes the tab without following the redirect.
 */
async function reconcileDeposit(
  company: Company,
  booking: Booking,
): Promise<Booking> {
  if (booking.depositPaidAt || !booking.depositCheckoutSessionId) {
    return booking;
  }
  try {
    const rows = await db.execute<{ amount_total: number | null }>(sql`
      SELECT amount_total
        FROM stripe.checkout_sessions
       WHERE id = ${booking.depositCheckoutSessionId}
         AND payment_status = 'paid'
       LIMIT 1
    `);
    const paid = rows.rows?.[0];
    if (!paid) return booking;
    return await claimDepositPaid(company, booking, paid.amount_total ?? null);
  } catch (err) {
    // The stripe schema may not exist yet if startup sync failed. A customer
    // must still be able to read their quote, so never let this break the page.
    logger.error(
      { err, bookingId: booking.id },
      "Could not reconcile deposit from synced Stripe data",
    );
    return booking;
  }
}

async function buildPublicQuote(company: Company, booking: Booking) {
  // The company writes a description per service ("Kitchen: thorough cleaning
  // of appliances..."), which is the summary the customer expects to read.
  const [service] = await db
    .select()
    .from(servicesTable)
    .where(
      and(
        eq(servicesTable.companyId, company.id),
        eq(servicesTable.name, booking.service),
      ),
    )
    .limit(1);

  // Prefer the frozen copy: this is the page the customer was sent to, so it
  // must show the price they were promised even if the company's rates have
  // moved since.
  const totals =
    booking.quoteSentTotals ?? computeQuoteTotals(company, booking);

  return {
    companyName: company.name,
    customerName: booking.customerName,
    customerAddress: booking.customerAddress,
    service: booking.service,
    serviceDescription: service?.description ?? null,
    scheduledForLabel: formatAppointment(
      booking.scheduledFor,
      company.timezone,
    ),
    totals,
    notes: booking.quoteNotes,
    sentAtLabel: booking.quoteSentAt
      ? formatDay(booking.quoteSentAt, company.timezone)
      : null,
    approved: booking.quoteApprovedAt != null,
    approvedAtLabel: booking.quoteApprovedAt
      ? formatDay(booking.quoteApprovedAt, company.timezone)
      : null,
    depositPaid: booking.depositPaidAt != null,
    depositPaidAmount: booking.depositPaidAmount ?? null,
    depositPaidAtLabel: booking.depositPaidAt
      ? formatDay(booking.depositPaidAt, company.timezone)
      : null,
    // Only offer online payment when there is a chargeable amount left.
    payableAmount:
      booking.depositPaidAt == null
        ? ((c) => (c == null ? null : c / 100))(depositCents(company, booking))
        : null,
  };
}

async function loadByToken(token: string) {
  const [row] = await db
    .select({ booking: bookingsTable, company: companiesTable })
    .from(bookingsTable)
    .innerJoin(companiesTable, eq(companiesTable.id, bookingsTable.companyId))
    .where(eq(bookingsTable.quoteToken, token))
    .limit(1);
  return row;
}

router.get("/quote/:token", async (req, res): Promise<void> => {
  const params = GetPublicQuoteParams.safeParse(req.params);
  if (!params.success) {
    res.status(404).json({ error: "That quote link isn't valid." });
    return;
  }
  const row = await loadByToken(params.data.token);
  if (!row) {
    // Same response for a malformed token and a real one that no longer
    // exists, so the endpoint can't be used to probe which tokens are live.
    res.status(404).json({ error: "That quote link isn't valid." });
    return;
  }
  const booking = await reconcileDeposit(row.company, row.booking);
  res.json(await buildPublicQuote(row.company, booking));
});

/**
 * Open a Stripe Checkout session for the deposit.
 *
 * Hosted Checkout rather than an embedded card form: it brings Apple Pay and
 * Google Pay with it, and keeps card data off this server entirely.
 */
router.post("/quote/:token/pay", async (req, res): Promise<void> => {
  const params = PayPublicQuoteParams.safeParse(req.params);
  if (!params.success) {
    res.status(404).json({ error: "That quote link isn't valid." });
    return;
  }
  const row = await loadByToken(params.data.token);
  if (!row) {
    res.status(404).json({ error: "That quote link isn't valid." });
    return;
  }
  const { company } = row;
  const booking = await reconcileDeposit(company, row.booking);

  if (booking.depositPaidAt) {
    res.status(409).json({ error: "This deposit has already been paid." });
    return;
  }

  const cents = depositCents(company, booking);
  if (cents == null) {
    res
      .status(400)
      .json({ error: "There's nothing to pay on this quote right now." });
    return;
  }

  const link = quoteUrl(params.data.token);

  try {
    const stripe = await getUncachableStripeClient();
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      // An inline price, not a catalog Price: every booking's deposit is a
      // different number derived from that job's own quote, so there is no
      // reusable product to point at and minting one Price per booking would
      // fill the company's Stripe catalog with single-use entries.
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: DEPOSIT_CURRENCY,
            unit_amount: cents,
            product_data: {
              name: `Deposit — ${booking.service}`,
              description: `${company.name} · ${booking.customerAddress}`,
            },
          },
        },
      ],
      success_url: `${link}?paid=1`,
      cancel_url: link,
      // Lets a human match a payment back to a job from the Stripe dashboard.
      metadata: {
        bookingId: String(booking.id),
        companyId: String(company.id),
        customerName: booking.customerName,
      },
    });

    if (!session.url) {
      throw new Error("Stripe returned a session without a checkout URL");
    }

    await db
      .update(bookingsTable)
      .set({ depositCheckoutSessionId: session.id })
      .where(eq(bookingsTable.id, booking.id));

    res.json({ checkoutUrl: session.url });
  } catch (err) {
    logger.error(
      { err, bookingId: booking.id },
      "Could not start a deposit checkout session",
    );
    res.status(502).json({
      error: "We couldn't start the payment. Please try again in a moment.",
    });
  }
});

/**
 * Confirm payment straight from Stripe after the customer is redirected back.
 *
 * The redirect itself proves nothing — the customer controls that URL — so the
 * session is re-read from Stripe. This exists alongside the synced-table
 * reconcile purely for immediacy: the customer should see "paid" the instant
 * they land, not whenever the webhook catches up.
 */
router.post(
  "/quote/:token/payment/refresh",
  async (req, res): Promise<void> => {
    const params = RefreshPublicQuotePaymentParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "That quote link isn't valid." });
      return;
    }
    const row = await loadByToken(params.data.token);
    if (!row) {
      res.status(404).json({ error: "That quote link isn't valid." });
      return;
    }
    const { company } = row;
    let booking = row.booking;

    if (!booking.depositPaidAt && booking.depositCheckoutSessionId) {
      try {
        const stripe = await getUncachableStripeClient();
        const session = await stripe.checkout.sessions.retrieve(
          booking.depositCheckoutSessionId,
        );
        if (session.payment_status === "paid") {
          booking = await claimDepositPaid(
            company,
            booking,
            session.amount_total ?? null,
          );
        }
      } catch (err) {
        // Fall through to the synced-table path rather than erroring: the
        // webhook will land shortly even if this live read failed.
        logger.error(
          { err, bookingId: booking.id },
          "Live Stripe payment check failed",
        );
        booking = await reconcileDeposit(company, booking);
      }
    }

    res.json(await buildPublicQuote(company, booking));
  },
);

router.post("/quote/:token/approve", async (req, res): Promise<void> => {
  const params = ApprovePublicQuoteParams.safeParse(req.params);
  if (!params.success) {
    res.status(404).json({ error: "That quote link isn't valid." });
    return;
  }
  const row = await loadByToken(params.data.token);
  if (!row) {
    res.status(404).json({ error: "That quote link isn't valid." });
    return;
  }
  const { booking, company } = row;

  // Approving twice is not an error — customers double-tap, and phones
  // prefetch links. The `quote_approved_at IS NULL` guard makes the winner
  // decidable in the database rather than in a read-then-write race, so two
  // simultaneous taps can't both move the timestamp or both post to the
  // dispatcher's feed.
  const [claimed] = await db
    .update(bookingsTable)
    .set({
      quoteApprovedAt: new Date(),
      // An approved quote is a confirmed job as far as the dispatcher board is
      // concerned — but never drag a finished or cancelled job back.
      ...(booking.status === "pending" ? { status: "confirmed" } : {}),
    })
    .where(
      and(
        eq(bookingsTable.id, booking.id),
        eq(bookingsTable.companyId, company.id),
        isNull(bookingsTable.quoteApprovedAt),
      ),
    )
    .returning();

  if (!claimed) {
    // Already approved — show them the same confirmed page, not an error.
    const fresh = await loadByToken(params.data.token);
    res.json(await buildPublicQuote(company, fresh?.booking ?? booking));
    return;
  }

  try {
    await db.insert(activityTable).values({
      companyId: company.id,
      type: "quote_approved",
      message: `${booking.customerName} approved their quote.`,
    });
  } catch (err) {
    // The approval itself is recorded; a missing feed entry must not make the
    // customer think their tap failed.
    logger.error(
      { err, bookingId: booking.id },
      "Quote approved but the activity entry failed",
    );
  }

  res.json(await buildPublicQuote(company, claimed));
});

export default router;
