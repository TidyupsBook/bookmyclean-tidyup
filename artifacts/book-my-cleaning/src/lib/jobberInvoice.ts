/**
 * Where "open this booking's invoice" should send the office — and how
 * honest the surrounding copy can be about it.
 *
 * Preference order:
 * 1. The invoice's own web URL, captured from Jobber when it was created.
 * 2. Decoding the GraphQL id (base64 "gid://Jobber/Invoice/123") into
 *    Jobber's numeric link — right for invoices created before we started
 *    storing the URL.
 * 3. The booking's Jobber job/request page — the invoice is one click away
 *    from there, but it is NOT the invoice, and callers must say so.
 *
 * The kind matters as much as the url: a toast that says "the invoice is
 * open" while the tab shows the job page teaches the office to distrust
 * every toast.
 */
export type InvoiceOpenTarget = { url: string; kind: "invoice" | "job" };

export function invoiceOpenTarget(b: {
  jobberInvoiceId?: string | null;
  jobberInvoiceWebUri?: string | null;
  jobberWebUri?: string | null;
}): InvoiceOpenTarget | null {
  if (b.jobberInvoiceWebUri) {
    return { url: b.jobberInvoiceWebUri, kind: "invoice" };
  }
  const id = b.jobberInvoiceId;
  if (id) {
    try {
      const decoded = atob(id).match(/Invoice\/(\d+)/i);
      if (decoded) {
        return {
          url: `https://secure.getjobber.com/invoices/${decoded[1]}`,
          kind: "invoice",
        };
      }
    } catch {
      // Not base64 — fall through to the other options.
    }
    if (/^\d+$/.test(id)) {
      return {
        url: `https://secure.getjobber.com/invoices/${id}`,
        kind: "invoice",
      };
    }
  }
  return b.jobberWebUri ? { url: b.jobberWebUri, kind: "job" } : null;
}
