import { useEffect, useRef } from "react";
import { useRoute } from "wouter";
import { CheckCircle2, CreditCard, Loader2, Sparkles } from "lucide-react";
import {
  useGetPublicQuote,
  useApprovePublicQuote,
  usePayPublicQuote,
  useRefreshPublicQuotePayment,
  getGetPublicQuoteQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { formatMoney, formatRate, lineItemTotal } from "@workspace/pricing";
import { Button } from "@/components/ui/button";

/**
 * The page a customer lands on from the link in their quote text.
 *
 * No sign-in, no dashboard chrome, no navigation — someone tapping this is
 * standing in their kitchen deciding whether to book a cleaner. It has one job:
 * show them exactly what they'll pay and let them say yes.
 */
export default function QuotePage() {
  const [, params] = useRoute("/quote/:token");
  const token = params?.token ?? "";
  const queryClient = useQueryClient();

  const {
    data: quote,
    isLoading,
    isError,
  } = useGetPublicQuote(token, {
    query: {
      queryKey: getGetPublicQuoteQueryKey(token),
      enabled: token.length > 0,
    },
  });

  const approve = useApprovePublicQuote({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getGetPublicQuoteQueryKey(token),
        });
      },
    },
  });

  const pay = usePayPublicQuote({
    mutation: {
      onSuccess: (result) => {
        // Hand the customer over to Stripe's hosted page — that's what gives
        // them Apple Pay and Google Pay without us touching card details.
        window.location.href = result.checkoutUrl;
      },
    },
  });

  const refreshPayment = useRefreshPublicQuotePayment({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getGetPublicQuoteQueryKey(token),
        });
      },
    },
  });

  // Coming back from Stripe, confirm the payment with the server before
  // showing anything — ?paid=1 is just a URL the customer could type.
  const checkedReturn = useRef(false);
  const refreshMutate = refreshPayment.mutate;
  useEffect(() => {
    if (!token || checkedReturn.current) return;
    if (!new URLSearchParams(window.location.search).has("paid")) return;
    checkedReturn.current = true;
    refreshMutate({ token });
    // Drop the flag so a refresh doesn't re-run this.
    window.history.replaceState({}, "", window.location.pathname);
  }, [token, refreshMutate]);

  if (isLoading) {
    return (
      <Shell>
        <div className="flex items-center justify-center py-24 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading your
          quote...
        </div>
      </Shell>
    );
  }

  if (isError || !quote) {
    return (
      <Shell>
        <div className="text-center py-20">
          <h1 className="font-serif font-bold text-2xl mb-2">
            We couldn't find that quote
          </h1>
          <p className="text-muted-foreground">
            The link may have expired. Reply to the text you received and we'll
            send a fresh one.
          </p>
        </div>
      </Shell>
    );
  }

  const t = quote.totals;

  return (
    <Shell>
      <div className="bg-card border border-border rounded-2xl overflow-hidden shadow-xl">
        <div className="brand-gradient h-1.5" />

        <div className="p-6 sm:p-8">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-2 text-brand-pink">
                <Sparkles className="w-4 h-4" />
                <span className="text-xs font-semibold uppercase tracking-widest">
                  Your estimate
                </span>
              </div>
              <h1 className="font-serif font-bold text-2xl sm:text-3xl mt-2">
                {quote.companyName}
              </h1>
            </div>
            {quote.sentAtLabel && (
              <div className="text-right text-sm">
                <div className="text-muted-foreground">Sent</div>
                <div className="font-medium">{quote.sentAtLabel}</div>
              </div>
            )}
          </div>

          <div className="mt-6 pt-6 border-t border-border">
            <div className="font-semibold text-lg">{quote.customerName}</div>
            {quote.customerAddress && (
              <div className="text-muted-foreground text-sm mt-0.5">
                {quote.customerAddress}
              </div>
            )}
            <div className="text-muted-foreground text-sm mt-2">
              {quote.scheduledForLabel}
            </div>
          </div>

          {quote.serviceDescription && (
            <div className="mt-6 pt-6 border-t border-border">
              <h2 className="font-serif font-bold text-lg mb-3">
                {quote.service} summary
              </h2>
              <div className="text-sm text-muted-foreground whitespace-pre-line leading-relaxed">
                {quote.serviceDescription}
              </div>
            </div>
          )}

          <div className="mt-6 pt-6 border-t border-border">
            {t.lineItems.length > 0 && (
              <div className="hidden sm:grid grid-cols-[1fr_auto_auto_auto] gap-x-6 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground pb-2">
                <span />
                <span className="text-right w-12">Qty</span>
                <span className="text-right w-24">Unit price</span>
                <span className="text-right w-24">Total</span>
              </div>
            )}
            {t.lineItems.map((item, i) => (
              <div
                key={i}
                className="grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_auto_auto_auto] gap-x-6 gap-y-1 py-3 border-t border-border/60 items-baseline"
              >
                <span className="font-medium">{item.name}</span>
                <span className="text-right w-12 tabular-nums text-muted-foreground hidden sm:block">
                  {item.quantity}
                </span>
                <span className="text-right w-24 tabular-nums text-muted-foreground hidden sm:block">
                  {formatMoney(item.unitPrice)}
                </span>
                <span className="text-right sm:w-24 tabular-nums font-medium">
                  {formatMoney(lineItemTotal(item))}
                </span>
                {/* Phones get the maths on its own line rather than a squashed table. */}
                {item.quantity !== 1 && (
                  <span className="sm:hidden col-span-2 text-xs text-muted-foreground -mt-1">
                    {item.quantity} x {formatMoney(item.unitPrice)}
                  </span>
                )}
              </div>
            ))}

            <div className="border-t border-border mt-2 pt-4 space-y-2 text-sm">
              <TotalRow label="Subtotal" value={formatMoney(t.subtotal)} />
              {t.taxRate > 0 && (
                <TotalRow
                  label={`${t.taxLabel} (${formatRate(t.taxRate)})`}
                  value={formatMoney(t.taxAmount)}
                />
              )}
              {t.feesRate > 0 && (
                <TotalRow
                  label={`${t.feesLabel} (${formatRate(t.feesRate)})`}
                  value={formatMoney(t.feesAmount)}
                />
              )}
              <div className="flex justify-between items-baseline pt-3 mt-1 border-t border-border">
                <span className="font-serif font-bold text-lg">Total</span>
                <span className="font-bold text-2xl tabular-nums">
                  {formatMoney(t.total)}
                </span>
              </div>
            </div>
          </div>

          {quote.depositPaid ? (
            <div className="mt-6 flex items-center gap-3 rounded-xl border border-green-500/25 bg-green-500/10 p-4">
              <CheckCircle2 className="w-5 h-5 text-green-400 shrink-0" />
              <div>
                <div className="font-semibold text-green-300">
                  Deposit paid
                  {quote.depositPaidAmount != null
                    ? ` — ${formatMoney(quote.depositPaidAmount)}`
                    : ""}
                </div>
                <div className="text-sm text-muted-foreground">
                  {quote.depositPaidAtLabel
                    ? `Received ${quote.depositPaidAtLabel}. `
                    : ""}
                  Your spot is secured.
                </div>
              </div>
            </div>
          ) : (
            t.deposit > 0 && (
              <div className="mt-6 rounded-xl border border-brand-pink/25 bg-brand-pink/5 p-4">
                <div className="flex justify-between items-baseline gap-4 flex-wrap">
                  <span className="font-semibold">
                    Deposit to secure your spot
                  </span>
                  <span className="font-bold text-lg tabular-nums text-brand-pink">
                    {formatMoney(t.deposit)}
                  </span>
                </div>

                {quote.payableAmount != null && (
                  <>
                    <Button
                      className="w-full mt-3"
                      disabled={pay.isPending || refreshPayment.isPending}
                      onClick={() => pay.mutate({ token })}
                    >
                      {pay.isPending ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Opening secure checkout...
                        </>
                      ) : (
                        <>
                          <CreditCard className="w-4 h-4" />
                          Pay {formatMoney(quote.payableAmount)} deposit
                        </>
                      )}
                    </Button>
                    {pay.isError && (
                      <p className="text-sm text-destructive mt-2 text-center">
                        We couldn't open the payment page. Please try again.
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground text-center mt-2">
                      Card, Apple Pay or Google Pay. Processed securely by
                      Stripe.
                    </p>
                  </>
                )}

                {/* Interac isn't available through Stripe in Canada, so the
                    company's own e-transfer address stays on the page. */}
                {t.depositEmail && (
                  <p className="text-sm text-muted-foreground mt-3 pt-3 border-t border-brand-pink/15">
                    Prefer e-transfer? Send to{" "}
                    <span className="text-foreground">{t.depositEmail}</span>
                  </p>
                )}
              </div>
            )
          )}

          {quote.notes && (
            <div className="mt-6 text-sm text-muted-foreground whitespace-pre-line">
              {quote.notes}
            </div>
          )}

          <div className="mt-8">
            {quote.approved ? (
              <div className="flex items-center gap-3 rounded-xl border border-green-500/25 bg-green-500/10 p-4">
                <CheckCircle2 className="w-5 h-5 text-green-400 shrink-0" />
                <div>
                  <div className="font-semibold text-green-300">
                    Approved
                    {quote.approvedAtLabel
                      ? ` on ${quote.approvedAtLabel}`
                      : ""}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Thanks! We'll be in touch to confirm the details.
                  </div>
                </div>
              </div>
            ) : (
              <>
                <Button
                  size="lg"
                  className="w-full"
                  disabled={approve.isPending}
                  onClick={() => approve.mutate({ token })}
                >
                  {approve.isPending ? "Approving..." : "Approve this quote"}
                </Button>
                {approve.isError && (
                  <p className="text-sm text-destructive mt-2 text-center">
                    That didn't go through. Please try again.
                  </p>
                )}
                <p className="text-xs text-muted-foreground text-center mt-3">
                  Approving lets us know you're happy to go ahead. It doesn't
                  charge you anything.
                </p>
              </>
            )}
          </div>
        </div>
      </div>

      <p className="text-center text-xs text-muted-foreground mt-6">
        Questions? Just reply to the text we sent you.
      </p>
    </Shell>
  );
}

function TotalRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-baseline">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground py-8 px-4">
      <div className="max-w-2xl mx-auto">{children}</div>
    </div>
  );
}
