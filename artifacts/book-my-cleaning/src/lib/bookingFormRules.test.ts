/**
 * The shared client-side rules all three booking forms lean on.
 *
 * The dashboard new-booking page, the Bookings-page dialog and the phone app
 * each collect a different subset of fields, so `missingBookingFields` only
 * judges the keys a form actually passes — a form that doesn't collect email
 * must not have its Save button held hostage to an email toggle (the server
 * still enforces the full list). And now that names are optional,
 * `bookingDisplayName` is the one answer to "what do we call this booking".
 */
import { describe, expect, it } from "vitest";
import {
  ALL_BOOKING_FORM_FIELD_KEYS,
  BOOKING_FORM_FIELDS,
  bookingDisplayName,
  isBookingFieldRequired,
  missingBookingFields,
} from "@workspace/api-client-react";

describe("missingBookingFields", () => {
  it("finds nothing when the owner requires nothing", () => {
    expect(missingBookingFields([], { name: "", phone: "" })).toEqual([]);
    expect(missingBookingFields(undefined, { name: "" })).toEqual([]);
  });

  it("names required blanks as lowercase labels, in form order", () => {
    expect(
      missingBookingFields(["service", "phone", "name"], {
        name: "  ",
        phone: "",
        service: "",
      }),
    ).toEqual(["name", "phone", "service"]);
  });

  it("only judges the keys the form actually collects", () => {
    // The Bookings dialog has no email box; an email toggle must not be able
    // to make that dialog unsaveable.
    expect(missingBookingFields(["email"], { name: "", phone: "" })).toEqual(
      [],
    );
  });

  it("counts a filled field as filled regardless of other toggles", () => {
    expect(
      missingBookingFields(ALL_BOOKING_FORM_FIELD_KEYS, {
        name: "Jay",
        phone: "780-555-0100",
        email: "jay@example.com",
        address: "5810 Mullen Place",
        service: "Deep clean",
        time: "09:00",
      }),
    ).toEqual([]);
  });
});

describe("isBookingFieldRequired", () => {
  it("mirrors the stored toggle list", () => {
    expect(isBookingFieldRequired(["phone"], "phone")).toBe(true);
    expect(isBookingFieldRequired(["phone"], "name")).toBe(false);
    expect(isBookingFieldRequired(undefined, "name")).toBe(false);
  });
});

describe("bookingDisplayName", () => {
  it("name, else phone, else 'No name' — never a blank", () => {
    expect(
      bookingDisplayName({ customerName: "Jay", customerPhone: "780" }),
    ).toBe("Jay");
    expect(
      bookingDisplayName({ customerName: " ", customerPhone: "780-555-0100" }),
    ).toBe("780-555-0100");
    expect(bookingDisplayName({ customerName: "", customerPhone: "" })).toBe(
      "No name",
    );
    expect(bookingDisplayName({})).toBe("No name");
  });
});

describe("the settings field list", () => {
  it("covers exactly the six toggleable fields", () => {
    expect(BOOKING_FORM_FIELDS.map((f) => f.key)).toEqual([
      "name",
      "phone",
      "email",
      "address",
      "service",
      "time",
    ]);
  });
});
