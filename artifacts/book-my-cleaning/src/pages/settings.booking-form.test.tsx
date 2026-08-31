// @vitest-environment jsdom
/**
 * BookingFormSettings (web) — regression guard.
 *
 * Required-fields toggles:
 * 1. Every entry in BOOKING_FORM_FIELDS renders a toggle on the page.
 * 2. Flipping one toggle passes exactly that field key change to the next
 *    save, leaving every other key untouched.
 *
 * Take-booking window chips:
 * 3. The chip matching company.recentCallWindowMinutes is highlighted.
 * 4. Clicking a different chip calls updateCompany with recentCallWindowMinutes.
 * 5. A failed save reverts to the previous chip.
 *
 * If a field is added to BOOKING_FORM_FIELDS without updating the component,
 * test 1 catches it. If the save handler starts sending wrong keys, test 2
 * catches it. Tests 3–5 guard the window setting against silent drift.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ---- Mocks -----------------------------------------------------------------

const updateMutate = vi.fn();

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...real,
    useUpdateCompany: () => ({ mutate: updateMutate, isPending: false }),
    getGetCompanyQueryKey: () => ["/company"],
  };
});

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// ---- Import after mocks ----------------------------------------------------

import {
  BOOKING_FORM_FIELDS,
  CALL_WINDOW_CHOICES,
} from "@workspace/api-client-react";
import { BookingFormSettings } from "./settings";

// ---- Helpers ---------------------------------------------------------------

function makeCompany(requiredFields: string[] = []) {
  return { bookingRequiredFields: requiredFields };
}

beforeEach(() => {
  updateMutate.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---- Tests -----------------------------------------------------------------

describe("BookingFormSettings (web)", () => {
  it("renders a toggle for every entry in BOOKING_FORM_FIELDS", () => {
    render(<BookingFormSettings company={makeCompany()} />);

    for (const field of BOOKING_FORM_FIELDS) {
      expect(
        screen.getByTestId(`switch-require-${field.key}`),
        `Missing toggle for field "${field.key}"`,
      ).toBeInTheDocument();
    }
  });

  it("enabling a toggle adds only that key to the save call", () => {
    // Start with no fields required.
    render(<BookingFormSettings company={makeCompany([])} />);

    // Flip the first field (e.g. "name") on.
    const firstField = BOOKING_FORM_FIELDS[0];
    fireEvent.click(screen.getByTestId(`switch-require-${firstField.key}`));

    expect(updateMutate).toHaveBeenCalledOnce();
    const [{ data }] = updateMutate.mock.calls[0];
    // Exactly one key was added — the one we toggled.
    expect(data.bookingRequiredFields).toEqual([firstField.key]);
  });

  it("disabling a toggle removes only that key from the save call", () => {
    // Start with every field required.
    const allKeys = BOOKING_FORM_FIELDS.map((f) => f.key);
    render(<BookingFormSettings company={makeCompany([...allKeys])} />);

    // Flip the last field off.
    const lastField = BOOKING_FORM_FIELDS[BOOKING_FORM_FIELDS.length - 1];
    fireEvent.click(screen.getByTestId(`switch-require-${lastField.key}`));

    expect(updateMutate).toHaveBeenCalledOnce();
    const [{ data }] = updateMutate.mock.calls[0];
    // Every key except the one we removed is still in the list.
    expect(data.bookingRequiredFields).not.toContain(lastField.key);
    expect(data.bookingRequiredFields).toHaveLength(allKeys.length - 1);
    for (const f of BOOKING_FORM_FIELDS.slice(0, -1)) {
      expect(data.bookingRequiredFields).toContain(f.key);
    }
  });
});

// ---- Take-booking window chip tests ----------------------------------------

function makeCompanyWithWindow(
  windowMinutes: number,
  requiredFields: string[] = [],
) {
  return {
    bookingRequiredFields: requiredFields,
    recentCallWindowMinutes: windowMinutes,
  };
}

describe("BookingFormSettings — Take-booking window chip (web)", () => {
  it("highlights the chip that matches the server value", () => {
    render(<BookingFormSettings company={makeCompanyWithWindow(60)} />);

    // The 60-min chip carries bg-primary when selected.
    expect(screen.getByTestId("window-choice-60").className).toContain(
      "bg-primary",
    );
    // Every other chip must NOT be highlighted.
    for (const m of CALL_WINDOW_CHOICES) {
      if (m === 60) continue;
      expect(screen.getByTestId(`window-choice-${m}`).className).not.toContain(
        "bg-primary",
      );
    }
  });

  it("defaults to the 30-min chip when the company has no stored value", () => {
    // makeCompany() omits recentCallWindowMinutes — server default kicks in.
    render(<BookingFormSettings company={makeCompany()} />);

    expect(screen.getByTestId("window-choice-30").className).toContain(
      "bg-primary",
    );
  });

  it("clicking a different chip calls updateCompany with recentCallWindowMinutes", () => {
    render(<BookingFormSettings company={makeCompanyWithWindow(30)} />);

    fireEvent.click(screen.getByTestId("window-choice-60"));

    expect(updateMutate).toHaveBeenCalledOnce();
    const [{ data }] = updateMutate.mock.calls[0];
    expect(data.recentCallWindowMinutes).toBe(60);
    // The required-fields key must NOT appear in a window save.
    expect(data).not.toHaveProperty("bookingRequiredFields");
  });

  it("clicking the already-selected chip does nothing", () => {
    render(<BookingFormSettings company={makeCompanyWithWindow(30)} />);

    fireEvent.click(screen.getByTestId("window-choice-30"));

    expect(updateMutate).not.toHaveBeenCalled();
  });

  it("reverts to the previous chip when the save fails", () => {
    let capturedOnError: ((error: unknown) => void) | undefined;
    updateMutate.mockImplementation(
      (_args: unknown, { onError }: { onError: (err: unknown) => void }) => {
        capturedOnError = onError;
      },
    );

    render(<BookingFormSettings company={makeCompanyWithWindow(30)} />);

    // Optimistic update: clicking 60 should immediately highlight it.
    fireEvent.click(screen.getByTestId("window-choice-60"));
    expect(screen.getByTestId("window-choice-60").className).toContain(
      "bg-primary",
    );
    expect(screen.getByTestId("window-choice-30").className).not.toContain(
      "bg-primary",
    );

    // Server rejects the save — should revert to 30.
    act(() => capturedOnError!(new Error("Network error")));

    expect(screen.getByTestId("window-choice-30").className).toContain(
      "bg-primary",
    );
    expect(screen.getByTestId("window-choice-60").className).not.toContain(
      "bg-primary",
    );
  });
});
