import { describe, it, expect } from "vitest";
import type { Call } from "@workspace/db";
import { buildBookingDraft, buildDraftFromText } from "./bookingDraft";

function call(overrides: Partial<Call> = {}): Call {
  return {
    id: 1,
    companyId: 1,
    callerName: "Jay Patel",
    callerPhone: "+17809206391",
    status: "completed",
    serviceRequested: null,
    preferredTime: null,
    startedAt: new Date("2026-08-06T15:00:00Z"),
    durationSeconds: 120,
    isTest: false,
    bookingId: null,
    direction: "inbound",
    summary: null,
    quoCallId: "quo_1",
    recordingUrl: null,
    transcript: [],
    extractedAnswers: [],
    createdAt: new Date("2026-08-06T15:00:00Z"),
    ...overrides,
  } as unknown as Call;
}

function said(...lines: string[]) {
  return lines.map((text) => ({
    speaker: "caller" as const,
    text,
    offsetSeconds: 0,
  }));
}

describe("buildDraftFromText", () => {
  it("reads the details a caller usually gives", () => {
    const draft = buildDraftFromText(
      "Hi, I need a deep clean at 5810 Mullen Place, postal code T6R 0V4. " +
        "It's a 3 bedroom, 2 bath place. Could you come next Tuesday? We have a dog.",
    );

    expect(draft.customerAddress).toBe("5810 Mullen Place");
    expect(draft.addressPostal).toBe("T6R 0V4");
    expect(draft.service).toBe("Deep Clean");
    expect(draft.bedrooms).toBe(3);
    expect(draft.bathrooms).toBe(2);
    expect(draft.preferredTime).toMatch(/next tuesday/i);
    expect(draft.internalNotes).toContain("dog");
    expect(draft.callId).toBeNull();
  });

  it("reads a US ZIP code", () => {
    const draft = buildDraftFromText(
      "I'm at 12 Oak Street, Portland, zip code 97201.",
    );
    expect(draft.customerAddress).toBe("12 Oak Street");
    expect(draft.addressPostal).toBe("97201");
  });

  it("reads a ZIP+4", () => {
    expect(buildDraftFromText("the zip is 97201-1234").addressPostal).toBe(
      "97201-1234",
    );
  });

  it("prefers a Canadian postal code when both shapes appear", () => {
    expect(
      buildDraftFromText("it's T6R 0V4, not 90210 like the show").addressPostal,
    ).toBe("T6R 0V4");
  });

  it("does not read a five-digit house number as a ZIP", () => {
    const draft = buildDraftFromText("I'm at 12345 Oak Street");
    expect(draft.customerAddress).toBe("12345 Oak Street");
    expect(draft.addressPostal).toBeNull();
  });

  it("does not read a ZIP out of a phone number", () => {
    const draft = buildDraftFromText("call me at 7809206391");
    expect(draft.addressPostal).toBeNull();
    expect(draft.customerPhone).toBe("(780) 920-6391");
  });

  it("understands spelled-out numbers", () => {
    const draft = buildDraftFromText(
      "It's a three bedroom, two bathroom house",
    );
    expect(draft.bedrooms).toBe(3);
    expect(draft.bathrooms).toBe(2);
  });

  it("returns nothing rather than guessing", () => {
    const draft = buildDraftFromText("Hi, are you open today? Thanks, bye.");
    expect(draft.customerAddress).toBeNull();
    expect(draft.bedrooms).toBeNull();
    expect(draft.service).toBeNull();
    // "today" is a real answer about timing, so it is allowed through.
    expect(draft.filledFields).toEqual(["preferredTime"]);
  });

  it("never reports a field it did not fill", () => {
    const draft = buildDraftFromText("Nothing useful here at all.");
    expect(draft.filledFields).toEqual([]);
  });

  it("picks up the name and number the caller says out loud", () => {
    const draft = buildDraftFromText(
      "Hi, my name is Sarah Johnson and my number is 780-920-6391.",
    );
    expect(draft.customerName).toBe("Sarah Johnson");
    expect(draft.customerPhone).toBe("(780) 920-6391");
  });

  it("reads a number however it was said", () => {
    for (const spoken of [
      "call me back on (780) 920 6391",
      "it's 1-780-920-6391",
      "7809206391 is the best number",
    ]) {
      expect(buildDraftFromText(spoken).customerPhone).toBe("(780) 920-6391");
    }
  });

  it("does not mistake a house number or a price for a phone number", () => {
    const draft = buildDraftFromText(
      "It's 5810 Mullen Place and my budget is about 250 dollars.",
    );
    expect(draft.customerPhone).toBeNull();
  });

  it("does not invent a customer out of an ordinary sentence", () => {
    for (const spoken of [
      "I'm looking for a deep clean",
      "It's a 3 bedroom 2 bath",
      "I'm just wondering about pricing",
      "I'm not sure yet",
      "This is for my mother's place",
      "I'm calling about a quote",
      "It's the townhouse on the corner",
      "This is going to be a big job",
      "I am hoping for something this week",
    ]) {
      expect(buildDraftFromText(spoken).customerName).toBeNull();
    }
  });

  it("still hears a name that ends the sentence", () => {
    expect(buildDraftFromText("Hi, this is Sarah.").customerName).toBe("Sarah");
    expect(buildDraftFromText("I'm Sarah Johnson").customerName).toBe(
      "Sarah Johnson",
    );
    expect(buildDraftFromText("my name is uh Dave Chen").customerName).toBe(
      "Dave Chen",
    );
  });

  it("trims the filler off a spoken name", () => {
    expect(buildDraftFromText("This is Dave calling").customerName).toBe(
      "Dave",
    );
    expect(buildDraftFromText("hi this is sarah here").customerName).toBe(
      "Sarah",
    );
  });
});

describe("buildBookingDraft", () => {
  it("prefers what was already extracted from the transcript", () => {
    const draft = buildBookingDraft(
      call({
        serviceRequested: "Move-out clean",
        preferredTime: "Friday morning",
        transcript: said("It's 12 Oak Street, three bedrooms, 1 bath"),
        extractedAnswers: [
          { field: "address", value: "999 Stored Avenue" },
          { field: "home size", value: "4 bedroom" },
          { field: "pets", value: "two dogs" },
        ],
      }) as Call,
    );

    expect(draft.customerAddress).toBe("999 Stored Avenue");
    expect(draft.bedrooms).toBe(4);
    // Nothing stored for bathrooms, so it falls back to the transcript.
    expect(draft.bathrooms).toBe(1);
    expect(draft.service).toBe("Move-out clean");
    expect(draft.preferredTime).toBe("Friday morning");
    expect(draft.internalNotes).toContain("Pets: two dogs");
    expect(draft.callId).toBe(1);
  });

  it("falls back to the transcript when nothing was extracted", () => {
    const draft = buildBookingDraft(
      call({
        transcript: said("I'd like a standard clean at 12 Oak Street"),
      }) as Call,
    );
    expect(draft.customerAddress).toBe("12 Oak Street");
    expect(draft.service).toBe("Standard Clean");
  });

  it("drops placeholder caller identities", () => {
    const draft = buildBookingDraft(
      call({ callerName: "Unknown", callerPhone: "Unknown" }) as Call,
    );
    expect(draft.customerName).toBeNull();
    expect(draft.customerPhone).toBeNull();
    expect(draft.filledFields).not.toContain("customerName");
  });

  it("uses what a blocked caller said instead of the missing caller ID", () => {
    const draft = buildBookingDraft(
      call({
        callerName: "Unknown",
        callerPhone: "Restricted",
        transcript: said("Hi, this is Sarah Johnson, reach me at 780-920-6391"),
      }) as Call,
    );
    expect(draft.customerName).toBe("Sarah Johnson");
    expect(draft.customerPhone).toBe("(780) 920-6391");
  });

  it("keeps the real caller ID over anything said on the call", () => {
    const draft = buildBookingDraft(
      call({
        transcript: said("This is Sarah Johnson, my cell is 780-920-6391"),
      }) as Call,
    );
    expect(draft.customerName).toBe("Jay Patel");
    expect(draft.customerPhone).toBe("+17809206391");
  });

  it("ignores what the receptionist said, only the caller", () => {
    const draft = buildBookingDraft(
      call({
        transcript: [
          {
            speaker: "ai" as const,
            text: "Our office is at 100 Sona Street",
            offsetSeconds: 0,
          },
          ...said("Sure, my place is 12 Oak Street"),
        ],
      }) as Call,
    );
    expect(draft.customerAddress).toBe("12 Oak Street");
  });

  it("puts the call summary in the crew notes", () => {
    const draft = buildBookingDraft(
      call({ summary: "Caller wants a quote before Friday." }) as Call,
    );
    expect(draft.internalNotes).toContain(
      "Call summary: Caller wants a quote before Friday.",
    );
  });
});
