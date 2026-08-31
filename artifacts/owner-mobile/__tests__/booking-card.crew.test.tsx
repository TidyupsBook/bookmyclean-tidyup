// @vitest-environment jsdom
/**
 * Crew names on the schedule's booking cards: who's on the job, at a glance.
 * Every role sees the names — cleaners lose the money (showPricing=false),
 * never their colleagues — and a booking with nobody assigned shows no empty
 * crew row.
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

vi.mock("@expo/vector-icons", () => ({ Feather: () => null }));

vi.mock("expo-haptics", () => ({
  selectionAsync: vi.fn(),
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: "success" },
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { BookingCard } from "@/components/Bookings";
import type { Booking } from "@workspace/api-client-react";

const TZ = "America/Edmonton";

function booking(over: Partial<Booking> = {}): Booking {
  return {
    id: 7,
    customerName: "Dana Reed",
    customerPhone: "555-0100",
    service: "Deep clean",
    status: "confirmed",
    scheduledFor: "2026-08-10T14:00:00.000Z",
    customerAddress: "12 Main St, Calgary",
    crew: [],
    ...over,
  } as Booking;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("BookingCard crew names", () => {
  it("shows the assigned cleaners on the card", () => {
    const { getByText } = render(
      <BookingCard
        booking={booking({
          crew: [
            { id: 1, name: "Sergine", role: "cleaner" },
            { id: 2, name: "Joseph", role: "cleaner" },
          ],
        })}
        timezone={TZ}
      />,
    );
    expect(getByText("Sergine, Joseph")).toBeTruthy();
  });

  it("still shows the crew when pricing is hidden (cleaner view)", () => {
    const { getByText, queryByTestId } = render(
      <BookingCard
        booking={booking({
          crew: [{ id: 1, name: "Sergine", role: "cleaner" }],
        })}
        timezone={TZ}
        showPricing={false}
      />,
    );
    expect(getByText("Sergine")).toBeTruthy();
    expect(queryByTestId("booking-crew-7")).toBeTruthy();
  });

  it("renders no crew row when nobody is assigned", () => {
    const { queryByTestId } = render(
      <BookingCard booking={booking()} timezone={TZ} />,
    );
    expect(queryByTestId("booking-crew-7")).toBeNull();
  });
});
