import { describe, it, expect } from "vitest";
import { redactForCrew, HIDDEN } from "./crewRedaction";

describe("redactForCrew", () => {
  it("masks a phone number in a quote message", () => {
    expect(redactForCrew("Quote texted to Jane Doe at +15551234567.")).toBe(
      `Quote texted to Jane Doe at ${HIDDEN}.`,
    );
  });

  it("masks every phone format a dispatcher might type", () => {
    for (const phone of [
      "+15551234567",
      "15551234567",
      "5551234567",
      "555-123-4567",
      "555.123.4567",
      "555/123-4567",
      "555 123 4567",
      "(555) 123-4567",
      "(555)123-4567",
      "+1 555 123 4567",
      "+1-555-123-4567",
      "+44 20 7123 4567",
    ]) {
      expect(redactForCrew(`Call from ${phone}.`)).toBe(`Call from ${HIDDEN}.`);
    }
  });

  it("masks every dollar format", () => {
    for (const amount of [
      "$150",
      "$150.00",
      "$1,250",
      "$1,250.00",
      "$1 250",
      "$1,250,000.99",
      "$.99",
      "$ 80.50",
    ]) {
      expect(redactForCrew(`Jane paid ${amount} today.`)).toBe(
        `Jane paid ${HIDDEN} today.`,
      );
    }
  });

  it("masks an amount without swallowing the words after it", () => {
    expect(redactForCrew("Jane Doe paid $150.00 toward Deep Clean.")).toBe(
      `Jane Doe paid ${HIDDEN} toward Deep Clean.`,
    );
    expect(redactForCrew("Deposit of $80 received for 3 rooms.")).toBe(
      `Deposit of ${HIDDEN} received for 3 rooms.`,
    );
  });

  it("masks both in one message", () => {
    expect(
      redactForCrew("Texted Jane at +1 555 123 4567 about the $80 deposit."),
    ).toBe(`Texted Jane at ${HIDDEN} about the ${HIDDEN} deposit.`);
  });

  // The whole point of the structured patterns: crew still need the schedule.
  it("leaves dates, times and short numbers intact", () => {
    for (const message of [
      "Rescheduled to 2026-08-06.",
      "Rescheduled to 2026-08-06 12:30.",
      "New time texted to Jane Doe: Wed, Aug 12, 2:00 PM.",
      "Moved from 08/06/2026 to 08/13/2026.",
      "Sona captured a 3 bed, 2 bath request.",
      "Jobber sync failed: HTTP 502 after 3 attempts.",
      "Booking 10024 confirmed.",
      "Cleaned 1,200 sq ft.",
    ]) {
      expect(redactForCrew(message)).toBe(message);
    }
  });

  it("leaves the customer name and service alone", () => {
    const message = "Booking added by hand for Jane Doe — Deep Clean.";
    expect(redactForCrew(message)).toBe(message);
  });

  it("does not chew a phone number out of a longer digit run", () => {
    const message = "Reference 12345678901234 logged.";
    expect(redactForCrew(message)).toBe(message);
  });

  it("is a no-op on a message with nothing sensitive", () => {
    expect(redactForCrew("Jane Doe approved their quote.")).toBe(
      "Jane Doe approved their quote.",
    );
  });
});
