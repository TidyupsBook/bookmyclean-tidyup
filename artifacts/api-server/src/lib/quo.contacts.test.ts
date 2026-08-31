import { describe, expect, it, vi, afterEach } from "vitest";
import { createContact, listContacts } from "./quo";

afterEach(() => vi.unstubAllGlobals());

describe("Quo contacts client", () => {
  it("sends Quo's required defaultFields payload exactly", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "contact_1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await createContact("company-key", {
      firstName: "Ada",
      lastName: "Lovelace",
      phone: "+15551234567",
      email: "ada@example.test",
      externalId: "bmc:42:client:9",
      source: "book-my-cleaning",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.quo.com/v1/contacts",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "company-key" }),
        body: JSON.stringify({
          defaultFields: {
            firstName: "Ada",
            lastName: "Lovelace",
            emails: [{ name: "email", value: "ada@example.test" }],
            phoneNumbers: [{ name: "phone", value: "+15551234567" }],
          },
          externalId: "bmc:42:client:9",
          source: "book-my-cleaning",
        }),
      }),
    );
  });

  it("uses required maxResults and externalIds when finding a contact", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetch);
    await listContacts("company-key", ["bmc:42:client:9"]);
    expect(String(fetch.mock.calls[0]![0])).toContain("maxResults=50");
    expect(String(fetch.mock.calls[0]![0])).toContain(
      "externalIds=bmc%3A42%3Aclient%3A9",
    );
  });
});
