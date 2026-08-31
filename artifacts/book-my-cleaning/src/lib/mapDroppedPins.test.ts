import { describe, expect, it } from "vitest";
import {
  DROPPED_PIN_COLORS,
  droppedPinColor,
  droppedPinOrdinal,
} from "./mapDroppedPins";

describe("dropped pin visual identities", () => {
  it("numbers pins by stable id order rather than API order", () => {
    const pins = [{ id: 40 }, { id: 10 }, { id: 25 }];
    expect(droppedPinOrdinal(pins, 10)).toBe(1);
    expect(droppedPinOrdinal(pins, 25)).toBe(2);
    expect(droppedPinOrdinal(pins, 40)).toBe(3);
    expect(droppedPinOrdinal([...pins].reverse(), 25)).toBe(2);
  });

  it("gives neighbouring pins visibly different colours and cycles safely", () => {
    const firstPass = DROPPED_PIN_COLORS.map((_, index) =>
      droppedPinColor(index + 1),
    );
    expect(new Set(firstPass).size).toBe(DROPPED_PIN_COLORS.length);
    expect(droppedPinColor(DROPPED_PIN_COLORS.length + 1)).toBe(
      droppedPinColor(1),
    );
    expect(droppedPinColor(0)).toBe(droppedPinColor(1));
  });
});
