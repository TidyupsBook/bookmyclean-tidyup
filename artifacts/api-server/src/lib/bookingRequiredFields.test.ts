/**
 * The two halves of "optional unless the owner says otherwise":
 *
 * - `missingRequiredBookingFields` turns the company's toggle list plus a
 *   create payload into the exact set of gaps, as the labels the 400 will
 *   name. Whitespace is not an answer, and a stale key in the stored setting
 *   must never make bookings unsaveable.
 * - `customerLabel` is what every text, feed line and Jobber push calls a
 *   booking now that names are optional: name, else phone, else "No name" —
 *   never a blank.
 */
import { describe, expect, it } from "vitest";
import {
  missingRequiredBookingFields,
  missingFieldsMessage,
} from "./bookingRequiredFields";
import { customerLabel, depositPaidMessage } from "./bookingFormat";

describe("missingRequiredBookingFields", () => {
  it("requires nothing when the owner toggled nothing on", () => {
    expect(missingRequiredBookingFields([], {})).toEqual([]);
  });

  it("names only the required fields that are actually blank", () => {
    expect(
      missingRequiredBookingFields(["name", "phone", "service"], {
        customerName: "Jay",
        customerPhone: "",
        service: "  ",
      }),
    ).toEqual(["phone number", "service"]);
  });

  it("treats whitespace as blank", () => {
    expect(
      missingRequiredBookingFields(["name"], { customerName: "   " }),
    ).toEqual(["name"]);
  });

  it("ignores unknown keys in the stored setting instead of blocking every save", () => {
    expect(missingRequiredBookingFields(["time", "someday-field"], {})).toEqual(
      [],
    );
  });
});

describe("missingFieldsMessage", () => {
  it("reads naturally for one gap and points at the setting", () => {
    const msg = missingFieldsMessage(["phone number"]);
    expect(msg).toContain("phone number");
    expect(msg).toContain("Settings → Booking form");
  });

  it("names every gap at once so fixing the form is one pass", () => {
    const msg = missingFieldsMessage(["name", "service"]);
    expect(msg).toContain("name, service");
  });
});

describe("customerLabel", () => {
  it("prefers the name", () => {
    expect(
      customerLabel({ customerName: " Jay ", customerPhone: "780-555-0100" }),
    ).toBe("Jay");
  });

  it("falls back to the phone number", () => {
    expect(
      customerLabel({ customerName: "", customerPhone: "780-555-0100" }),
    ).toBe("780-555-0100");
  });

  it("never returns a blank", () => {
    expect(customerLabel({ customerName: "  ", customerPhone: "" })).toBe(
      "No name",
    );
  });
});

describe("depositPaidMessage", () => {
  it("uses the customer's name and the dollar amount when both exist", () => {
    expect(
      depositPaidMessage(
        { customerName: "Jane Doe", customerPhone: "780-555-0100" },
        "Deep Clean",
        15000,
      ),
    ).toBe("Jane Doe paid $150.00 toward Deep Clean.");
  });

  it("falls back to the phone number for a nameless booking", () => {
    expect(
      depositPaidMessage(
        { customerName: "", customerPhone: "780-555-0100" },
        "Deep Clean",
        15000,
      ),
    ).toBe("780-555-0100 paid $150.00 toward Deep Clean.");
  });

  it("never leaves a blank where the customer goes, even with no amount", () => {
    expect(
      depositPaidMessage(
        { customerName: " ", customerPhone: "" },
        "Move-out clean",
        null,
      ),
    ).toBe("No name paid their deposit toward Move-out clean.");
  });
});
