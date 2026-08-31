// @vitest-environment jsdom
/**
 * Every notification type has its own badge color so a glance says WHAT is
 * waiting: red = phone calls, pink = customer texts, purple = team chat,
 * orange = leads. These tests pin the tone → class mapping (a refactor
 * that collapses them back to one color silently defeats the feature) and
 * the badge's show/hide/cap rules.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { UnreadBadge, type UnreadTone } from "./unread-badge";

afterEach(cleanup);

describe("UnreadBadge", () => {
  it.each([
    ["calls", "bg-red-600"],
    ["messages", "bg-pink-600"],
    ["chat", "bg-purple-600"],
    ["leads", "bg-orange-700"],
  ] as Array<[UnreadTone, string]>)(
    "%s tone gets its own color (%s)",
    (tone, expectedClass) => {
      render(<UnreadBadge count={2} tone={tone} testId={`badge-${tone}`} />);
      expect(screen.getByTestId(`badge-${tone}`)).toHaveClass(expectedClass);
    },
  );

  it("no two tones share a color", () => {
    const tones: UnreadTone[] = ["calls", "messages", "chat", "leads"];
    for (const tone of tones) {
      render(<UnreadBadge count={1} tone={tone} testId={`badge-${tone}`} />);
    }
    const classNames = tones.map(
      (tone) => screen.getByTestId(`badge-${tone}`).className,
    );
    expect(new Set(classNames).size).toBe(tones.length);
  });

  it("renders nothing at zero and caps at 99+", () => {
    render(<UnreadBadge count={0} tone="messages" testId="badge-zero" />);
    expect(screen.queryByTestId("badge-zero")).not.toBeInTheDocument();

    render(<UnreadBadge count={150} tone="messages" testId="badge-capped" />);
    expect(screen.getByTestId("badge-capped")).toHaveTextContent("99+");
  });
});
