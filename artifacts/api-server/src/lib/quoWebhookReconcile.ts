/**
 * Re-point Quo webhooks at the current public base URL.
 *
 * Webhooks are registered when the owner picks their lines, with whatever
 * base URL the server had at that moment. When the canonical domain changes
 * (or is pinned for the first time), every existing registration still points
 * at the old host — Quo keeps delivering there, and whether those events
 * arrive depends on the old host continuing to answer. This boot pass walks
 * every stored webhook and re-registers any whose URL no longer matches
 * `publicWebhookUrl()`, using the same create-then-swap-then-delete order as
 * the owner-facing flow so a failure leaves the company on its previous
 * working setup rather than none.
 *
 * Best-effort per company: one company's dead Quo key must not stop the
 * others from being moved.
 */
import { eq, inArray } from "drizzle-orm";
import { db, companiesTable, quoWebhooksTable } from "@workspace/db";
import { companyQuoKey } from "./company";
import { ownsWebhookHost, publicWebhookUrl } from "./publicUrl";
import * as quo from "./quo";
import { logger } from "./logger";

export async function reconcileQuoWebhookUrls(): Promise<void> {
  // Only migrate toward an explicitly pinned canonical domain. Without the
  // pin, publicWebhookUrl() falls back to whatever host this process happens
  // to run on — re-registering every company's hooks against an inferred
  // workspace/dev hostname would be a mass move to the wrong place.
  if (!process.env.PUBLIC_APP_URL?.trim()) return;
  const url = publicWebhookUrl();

  const hooks = await db.select().from(quoWebhooksTable);
  const staleCompanyIds = [
    ...new Set(hooks.filter((h) => h.url !== url).map((h) => h.companyId)),
  ];
  if (staleCompanyIds.length === 0) return;

  const companies = await db
    .select()
    .from(companiesTable)
    .where(inArray(companiesTable.id, staleCompanyIds));

  for (const company of companies) {
    const apiKey = companyQuoKey(company);
    const numberIds = company.quoNumberIds;
    if (!apiKey || numberIds.length === 0) {
      logger.warn(
        { companyId: company.id },
        "Quo webhooks point at an old host but the company has no usable key or lines; leaving as-is",
      );
      continue;
    }

    const label = `bookmycleaning-${company.id}`;
    // allSettled rather than all so every hook that DID get created is known
    // and can be rolled back — a rejected Promise.all would lose track of the
    // successes and leave duplicate registrations delivering twice.
    const attempts = await Promise.allSettled([
      quo.createCallWebhook(apiKey, url, numberIds, `${label}-calls`),
      quo.createTranscriptWebhook(
        apiKey,
        url,
        numberIds,
        `${label}-transcripts`,
      ),
      quo.createSummaryWebhook(apiKey, url, numberIds, `${label}-summaries`),
      quo.createMessageWebhook(apiKey, url, numberIds, `${label}-messages`),
    ]);
    const created = attempts
      .filter(
        (a): a is PromiseFulfilledResult<quo.QuoWebhookRecord> =>
          a.status === "fulfilled",
      )
      .map((a) => a.value);
    const failure = attempts.find(
      (a): a is PromiseRejectedResult => a.status === "rejected",
    );
    if (failure) {
      logger.error(
        { companyId: company.id, err: (failure.reason as Error)?.message },
        "Could not re-register Quo webhooks on the new domain; keeping the old registration",
      );
      // Roll back every hook that did get created, so a partial pass doesn't
      // leave duplicate deliveries.
      await Promise.allSettled(
        created.map((w) => quo.deleteWebhook(apiKey, w.id)),
      );
      continue;
    }

    const previous = hooks.filter((h) => h.companyId === company.id);

    await db.transaction(async (tx) => {
      await tx
        .delete(quoWebhooksTable)
        .where(eq(quoWebhooksTable.companyId, company.id));
      await tx.insert(quoWebhooksTable).values(
        created.map((w) => ({
          companyId: company.id,
          quoWebhookId: w.id,
          signingKey: w.key,
          events: w.events,
          url: w.url,
        })),
      );
    });

    // Old hooks go only after the new ones are committed; a failure here
    // leaves a harmless duplicate on Quo's side rather than a gap.
    for (const hook of previous) {
      // A cloned database carries the other environment's registrations;
      // deleting those ids would sever ITS live ingestion. Drop only rows
      // whose URL host this environment answers for — the foreign hook stays
      // alive on Quo's side, and only our local record of it goes away.
      if (!ownsWebhookHost(hook.url)) {
        logger.warn(
          { companyId: company.id, id: hook.quoWebhookId, url: hook.url },
          "Left another environment's Quo webhook alive; removed only its local row",
        );
        continue;
      }
      try {
        await quo.deleteWebhook(apiKey, hook.quoWebhookId);
      } catch (err) {
        logger.warn(
          {
            companyId: company.id,
            id: hook.quoWebhookId,
            err: (err as Error).message,
          },
          "Could not delete superseded Quo webhook",
        );
      }
    }

    logger.info(
      { companyId: company.id, url },
      "Quo webhooks re-registered on the canonical domain",
    );
  }
}
