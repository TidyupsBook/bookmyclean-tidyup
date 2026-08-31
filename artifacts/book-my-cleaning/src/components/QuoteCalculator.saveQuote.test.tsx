// @vitest-environment jsdom
/**
 * The early save that lives with the quote numbers.
 *
 * A live call often produces a price before it produces an address or a day.
 * The Save quote button exists so the priced call can be kept the moment the
 * numbers are in — but only then: with no price there is nothing worth an
 * extra button, and with no customer name there is nobody to hang the quote
 * on, so the button says what it is waiting for instead of failing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  QuoteCalculator,
  emptyQuoteDraft,
  type QuoteDraft,
} from "./QuoteCalculator";
import type { QuoteRates } from "@workspace/pricing";

const rates: QuoteRates = {
  rateSolo: 55,
  rateTeam: 90,
  fuelSurcharge: 10,
  taxLabel: "GST",
  taxRate: 0.05,
  feesLabel: "Fees",
  feesRate: 0,
  depositAmount: 50,
};

const priced: QuoteDraft = {
  ...emptyQuoteDraft,
  hours: 3,
  crewLabel: "2 cleaners",
  hourlyRate: 90,
};

afterEach(cleanup);

function renderCalc(
  props: Partial<React.ComponentProps<typeof QuoteCalculator>> = {},
) {
  return render(
    <QuoteCalculator
      value={priced}
      onChange={() => {}}
      rates={rates}
      serviceName="Deep clean"
      {...props}
    />,
  );
}

describe("Save quote with the calculator", () => {
  it("applies an exact service-table price as one flat unit", () => {
    const onChange = vi.fn();
    renderCalc({
      value: emptyQuoteDraft,
      onChange,
      serviceName: "Move-Out Cleaning",
      catalogPrice: 400,
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Use service-table price/i }),
    );
    expect(onChange).toHaveBeenCalledWith({
      ...emptyQuoteDraft,
      hours: 1,
      crewLabel: "flat rate",
      hourlyRate: 400,
    });
  });

  it("offers the save once the quote is priced, and fires the host's save", () => {
    const onSaveQuote = vi.fn();
    renderCalc({ onSaveQuote, canSaveQuote: true });

    const button = screen.getByTestId("button-save-quote");
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onSaveQuote).toHaveBeenCalledTimes(1);
    // And says the one thing that stops a mid-call panic: nothing is texted.
    expect(
      screen.getByText(/Nothing is sent to the customer/),
    ).toBeInTheDocument();
  });

  it("waits for a customer name, and says so", () => {
    const onSaveQuote = vi.fn();
    renderCalc({ onSaveQuote, canSaveQuote: false });

    expect(screen.getByTestId("button-save-quote")).toBeDisabled();
    expect(
      screen.getByText("Needs the customer's name first."),
    ).toBeInTheDocument();
  });

  it("shows no save at all before there are quote numbers to keep", () => {
    renderCalc({
      value: emptyQuoteDraft,
      onSaveQuote: vi.fn(),
      canSaveQuote: true,
    });
    expect(screen.queryByTestId("button-save-quote")).not.toBeInTheDocument();
  });

  it("stays out of pages that don't pass a save at all", () => {
    renderCalc();
    expect(screen.queryByTestId("button-save-quote")).not.toBeInTheDocument();
  });

  it("won't double-save while one save is in flight", () => {
    const onSaveQuote = vi.fn();
    renderCalc({ onSaveQuote, canSaveQuote: true, saveQuoteBusy: true });
    expect(screen.getByTestId("button-save-quote")).toBeDisabled();
  });
});
