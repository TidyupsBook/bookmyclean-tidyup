// @vitest-environment jsdom
/**
 * BookingFormSettingsScreen (mobile) — regression guard.
 *
 * Required-fields toggles:
 * 1. Every entry in BOOKING_FORM_FIELDS renders a toggle on the screen.
 * 2. Flipping one toggle passes exactly that field key change to the next
 *    save, leaving every other key untouched.
 *
 * Take-booking window chips:
 * 3. The chip matching recentCallWindowMinutes is shown selected.
 * 4. Tapping a different chip calls updateCompany with recentCallWindowMinutes.
 * 5. A failed save reverts to the previous chip.
 *
 * If a field is added to BOOKING_FORM_FIELDS without updating the screen,
 * test 1 catches it. If the save handler sends wrong keys, test 2 catches it.
 * Tests 3–5 guard the window setting on mobile against silent drift.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

// ---- Expo / RN stubs -------------------------------------------------------

vi.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// react-native-web renders Switch as a styled <div> that uses pointer events
// internally — fireEvent.click does not reach onValueChange. Replace it with a
// plain <button> so click reliably triggers the handler in jsdom tests.
vi.mock("react-native", async (importOriginal) => {
  const real = await importOriginal<typeof import("react-native")>();
  const React = await import("react");
  return {
    ...real,
    Switch: ({
      testID,
      value,
      onValueChange,
    }: {
      testID?: string;
      value: boolean;
      onValueChange: (v: boolean) => void;
    }) =>
      React.createElement("button", {
        "data-testid": testID,
        "aria-checked": value,
        onClick: () => onValueChange(!value),
      }),
  };
});

vi.mock("@/components/Brand", () => ({
  BrandHeaderTitle: () => null,
}));

vi.mock("@/components/StateViews", () => ({
  LoadingView: () => null,
  ErrorView: () => null,
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({ back: vi.fn() }),
}));

// ---- API hooks stub --------------------------------------------------------

const updateMutate = vi.fn();

const hooks = vi.hoisted(() => ({
  me: {
    data: { role: "owner" } as unknown,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  company: {
    data: { bookingRequiredFields: [] } as unknown,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...real,
    useGetCurrentUser: () => hooks.me,
    useGetCompany: () => hooks.company,
    useUpdateCompany: () => ({ mutate: updateMutate, isPending: false }),
    getGetCompanyQueryKey: () => ["/company"],
  };
});

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

// ---- Import after mocks ----------------------------------------------------

import {
  BOOKING_FORM_FIELDS,
  CALL_WINDOW_CHOICES,
} from "@workspace/api-client-react";
import BookingFormSettingsScreen from "@/app/booking-form-settings";

// ---- Helpers ---------------------------------------------------------------

beforeEach(() => {
  hooks.me.data = { role: "owner" };
  hooks.me.isLoading = false;
  hooks.me.isError = false;
  hooks.company.data = { bookingRequiredFields: [] };
  hooks.company.isLoading = false;
  hooks.company.isError = false;
  updateMutate.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---- Tests -----------------------------------------------------------------

describe("BookingFormSettingsScreen (mobile)", () => {
  it("renders a toggle for every entry in BOOKING_FORM_FIELDS", () => {
    render(<BookingFormSettingsScreen />);

    for (const field of BOOKING_FORM_FIELDS) {
      expect(
        screen.getByTestId(`switch-require-${field.key}`),
        `Missing toggle for field "${field.key}"`,
      ).toBeTruthy();
    }
  });

  it("enabling a toggle adds only that key to the save call", () => {
    hooks.company.data = { bookingRequiredFields: [] };
    render(<BookingFormSettingsScreen />);

    // Flip the first field (e.g. "name") on.
    // react-native-web renders Switch as a <input type="checkbox">, so
    // fireEvent.change with { target: { checked: true } } is the correct trigger.
    const firstField = BOOKING_FORM_FIELDS[0];
    fireEvent.click(screen.getByTestId(`switch-require-${firstField.key}`));

    expect(updateMutate).toHaveBeenCalledOnce();
    const [{ data }] = updateMutate.mock.calls[0];
    expect(data.bookingRequiredFields).toEqual([firstField.key]);
  });

  it("disabling a toggle removes only that key from the save call", () => {
    const allKeys = BOOKING_FORM_FIELDS.map((f) => f.key);
    hooks.company.data = { bookingRequiredFields: [...allKeys] };
    render(<BookingFormSettingsScreen />);

    // Flip the last field off.
    const lastField = BOOKING_FORM_FIELDS[BOOKING_FORM_FIELDS.length - 1];
    fireEvent.click(screen.getByTestId(`switch-require-${lastField.key}`));

    expect(updateMutate).toHaveBeenCalledOnce();
    const [{ data }] = updateMutate.mock.calls[0];
    expect(data.bookingRequiredFields).not.toContain(lastField.key);
    expect(data.bookingRequiredFields).toHaveLength(allKeys.length - 1);
    for (const f of BOOKING_FORM_FIELDS.slice(0, -1)) {
      expect(data.bookingRequiredFields).toContain(f.key);
    }
  });
});

// ---- Take-booking window chip tests ----------------------------------------

describe("BookingFormSettingsScreen — Take-booking window chip (mobile)", () => {
  it("renders a chip for every value in the shared CALL_WINDOW_CHOICES preset", () => {
    hooks.company.data = {
      bookingRequiredFields: [],
      recentCallWindowMinutes: 30,
    };
    render(<BookingFormSettingsScreen />);

    for (const m of CALL_WINDOW_CHOICES) {
      expect(
        screen.getByTestId(`window-choice-${m}`),
        `Missing chip for ${m} min`,
      ).toBeTruthy();
    }
  });

  it("marks the chip matching recentCallWindowMinutes as selected", () => {
    hooks.company.data = {
      bookingRequiredFields: [],
      recentCallWindowMinutes: 60,
    };
    render(<BookingFormSettingsScreen />);

    // react-native-web renders Pressable as a div; the selected chip carries a
    // backgroundColor style from styles.chipSelected. We check the aria-label
    // or accessible name is not needed — what matters is that ONLY the 60-min
    // chip has the selected style class applied. The safest cross-platform signal
    // is that the element exists and the save guard lets the current value pass.
    // We verify selection by confirming a tap on the same chip triggers no save.
    fireEvent.click(screen.getByTestId("window-choice-60"));
    expect(updateMutate).not.toHaveBeenCalled();

    // Tapping a different chip must trigger a save — confirming only 60 is
    // treated as already selected.
    fireEvent.click(screen.getByTestId("window-choice-30"));
    expect(updateMutate).toHaveBeenCalledOnce();
  });

  it("defaults to 30 min when the company has no stored value", () => {
    hooks.company.data = { bookingRequiredFields: [] };
    render(<BookingFormSettingsScreen />);

    // 30 is the default — tapping it must be a no-op.
    fireEvent.click(screen.getByTestId("window-choice-30"));
    expect(updateMutate).not.toHaveBeenCalled();

    // Any other chip triggers a save.
    fireEvent.click(screen.getByTestId("window-choice-60"));
    expect(updateMutate).toHaveBeenCalledOnce();
  });

  it("tapping a different chip calls updateCompany with recentCallWindowMinutes", () => {
    hooks.company.data = {
      bookingRequiredFields: [],
      recentCallWindowMinutes: 30,
    };
    render(<BookingFormSettingsScreen />);

    fireEvent.click(screen.getByTestId("window-choice-120"));

    expect(updateMutate).toHaveBeenCalledOnce();
    const [{ data }] = updateMutate.mock.calls[0];
    expect(data.recentCallWindowMinutes).toBe(120);
    // Must not accidentally touch the required-fields list.
    expect(data).not.toHaveProperty("bookingRequiredFields");
  });

  it("reverts to the previous chip when the save fails", () => {
    let capturedOnError: ((err: unknown) => void) | undefined;
    updateMutate.mockImplementation(
      (_args: unknown, { onError }: { onError: (err: unknown) => void }) => {
        capturedOnError = onError;
      },
    );

    hooks.company.data = {
      bookingRequiredFields: [],
      recentCallWindowMinutes: 30,
    };
    render(<BookingFormSettingsScreen />);

    // Tap 60 — optimistic update; 60 becomes the effective value.
    fireEvent.click(screen.getByTestId("window-choice-60"));

    // After the optimistic update, 60 should now be treated as current
    // (tapping it again does nothing).
    updateMutate.mockReset();
    fireEvent.click(screen.getByTestId("window-choice-60"));
    expect(updateMutate).not.toHaveBeenCalled();

    // Server rejects — revert to 30; tapping 60 should trigger a save again.
    act(() => capturedOnError!(new Error("Network error")));
    updateMutate.mockReset();
    fireEvent.click(screen.getByTestId("window-choice-60"));
    expect(updateMutate).toHaveBeenCalledOnce();
  });
});
