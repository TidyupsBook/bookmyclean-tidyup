import { describe, expect, it } from "vitest";
import { invoiceOpenTarget } from "./jobberInvoice";

describe("invoiceOpenTarget", () => {
  it("prefers the stored invoice web URL over everything else", () => {
    // The URL Jobber itself handed us is the only one we never had to
    // guess — decoding must not even be attempted when it exists.
    expect(
      invoiceOpenTarget({
        jobberInvoiceWebUri: "https://secure.getjobber.com/invoices/987",
        jobberInvoiceId: btoa("gid://Jobber/Invoice/111"),
        jobberWebUri: "https://secure.getjobber.com/work_orders/5",
      }),
    ).toEqual({
      url: "https://secure.getjobber.com/invoices/987",
      kind: "invoice",
    });
  });

  it("decodes a base64 GraphQL id for invoices created before the URL was stored", () => {
    expect(
      invoiceOpenTarget({ jobberInvoiceId: btoa("gid://Jobber/Invoice/123") }),
    ).toEqual({
      url: "https://secure.getjobber.com/invoices/123",
      kind: "invoice",
    });
  });

  it("accepts a plain numeric id", () => {
    expect(invoiceOpenTarget({ jobberInvoiceId: "456" })).toEqual({
      url: "https://secure.getjobber.com/invoices/456",
      kind: "invoice",
    });
  });

  it("falls back to the job page — and says so — when the id is undecodable", () => {
    // atob succeeds on this string but yields no Invoice path, so the only
    // honest destination is the booking's job page, labelled as such.
    expect(
      invoiceOpenTarget({
        jobberInvoiceId: "aGVsbG8=",
        jobberWebUri: "https://secure.getjobber.com/work_orders/5",
      }),
    ).toEqual({
      url: "https://secure.getjobber.com/work_orders/5",
      kind: "job",
    });
  });

  it("returns null when there is nowhere real to send anyone", () => {
    expect(invoiceOpenTarget({ jobberInvoiceId: "not/base64!!" })).toBeNull();
    expect(invoiceOpenTarget({})).toBeNull();
  });
});
