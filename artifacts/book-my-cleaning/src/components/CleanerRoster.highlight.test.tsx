// @vitest-environment jsdom
/**
 * The roster strip is the only way back from a highlighted (dimmed) calendar:
 * the "Show everyone" button must appear exactly while a highlight is active
 * and must fire onClearHighlight, and a cleaner with no map pin must still be
 * clickable when highlighting is wired up. These tests pin that, so a
 * refactor can't strand owners with a dimmed board and no way to clear it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { CleanerRoster } from "./CleanerRoster";

// The current-user hook only picks the localStorage key for the hide list —
// irrelevant here, so it can resolve to nobody.
vi.mock("@workspace/api-client-react", () => ({
  useGetCurrentUser: () => ({ data: undefined }),
}));

/**
 * Ana has a home pin (focusable even without highlighting); Bo has no
 * coordinates at all, so his chip is only clickable when `highlighted`
 * is wired up.
 */
const rosterData = {
  staffHomes: [
    {
      teamMemberId: 7,
      name: "Ana",
      color: "#3b82f6",
      active: true,
      lat: 43.65,
      lng: -79.38,
    },
  ],
  staffWithoutHome: [{ teamMemberId: 9, name: "Bo", active: true }],
} as Parameters<typeof CleanerRoster>[0]["data"];

function renderRoster(props: {
  highlighted?: number | null;
  onClearHighlight?: () => void;
  onFocus?: (c: unknown) => void;
  onShowAll?: () => void;
  onHideAll?: (ids: Iterable<number>) => void;
  hidden?: Set<number>;
}) {
  return render(
    <CleanerRoster
      data={rosterData}
      hidden={props.hidden ?? new Set()}
      onToggle={() => {}}
      onShowAll={props.onShowAll ?? (() => {})}
      onHideAll={props.onHideAll ?? (() => {})}
      onFocus={props.onFocus ?? (() => {})}
      highlighted={props.highlighted}
      onClearHighlight={props.onClearHighlight}
    />,
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("Show everyone button", () => {
  it("does not render when no highlight is active", () => {
    renderRoster({ highlighted: null, onClearHighlight: () => {} });
    expect(
      screen.queryByTestId("button-clear-highlight"),
    ).not.toBeInTheDocument();
  });

  it("does not render when highlighting isn't wired up at all", () => {
    renderRoster({});
    expect(
      screen.queryByTestId("button-clear-highlight"),
    ).not.toBeInTheDocument();
  });

  it("renders while a highlight is active and fires onClearHighlight", () => {
    const onClear = vi.fn();
    renderRoster({ highlighted: 7, onClearHighlight: onClear });
    const btn = screen.getByTestId("button-clear-highlight");
    expect(btn).toHaveTextContent("Show everyone");
    fireEvent.click(btn);
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe("name clicks with highlighting wired up", () => {
  it("a cleaner with no map pin still fires onFocus so they can be highlighted", () => {
    const onFocus = vi.fn();
    renderRoster({ highlighted: null, onFocus });
    const boButton = screen.getByTestId("button-focus-cleaner-9");
    expect(boButton).not.toBeDisabled();
    fireEvent.click(boButton);
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onFocus.mock.calls[0][0]).toMatchObject({
      teamMemberId: 9,
      focus: null,
    });
  });

  it("without highlighting wired up, a pinless cleaner stays unclickable", () => {
    const onFocus = vi.fn();
    renderRoster({ onFocus });
    const boButton = screen.getByTestId("button-focus-cleaner-9");
    expect(boButton).toBeDisabled();
    fireEvent.click(boButton);
    expect(onFocus).not.toHaveBeenCalled();
  });
});

describe("highlighted chip emphasis", () => {
  it("the highlighted cleaner's chip gets the thick border in their color", () => {
    renderRoster({ highlighted: 7, onClearHighlight: () => {} });
    const anaChip = screen.getByTestId("chip-cleaner-7");
    expect(anaChip.className).toContain("border-2");
    expect(anaChip.style.borderColor).toBe("rgb(59, 130, 246)");
    const boChip = screen.getByTestId("chip-cleaner-9");
    expect(boChip.className).not.toContain("border-2");
    expect(boChip.style.borderColor).toBe("");
  });
});

describe("live-location visibility controls", () => {
  it("shows the visible count and fires each bulk action", () => {
    const onShowAll = vi.fn();
    const onHideAll = vi.fn();
    renderRoster({
      hidden: new Set([9]),
      onShowAll,
      onHideAll,
    });

    expect(screen.getByTestId("text-live-cleaner-count")).toHaveTextContent(
      "1 of 2 live shown",
    );
    fireEvent.click(screen.getByTestId("button-show-all-live"));
    expect(onShowAll).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("button-hide-all-live"));
    expect(onHideAll).toHaveBeenCalledTimes(1);
    expect([...onHideAll.mock.calls[0][0]]).toEqual([7, 9]);
  });

  it("names individual checkboxes as live-location controls", () => {
    renderRoster({});
    expect(
      screen.getByRole("checkbox", { name: "Hide Ana's live location" }),
    ).toBeChecked();
  });

  it("collapses without changing visibility and remembers the choice", () => {
    const first = renderRoster({});
    const toggle = screen.getByTestId("button-toggle-cleaner-roster");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("chip-cleaner-7")).toBeVisible();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("chip-cleaner-7")).not.toBeVisible();
    expect(screen.getByTestId("text-live-cleaner-count")).toHaveTextContent(
      "2 of 2 live shown",
    );

    first.unmount();
    renderRoster({});
    expect(screen.getByTestId("button-toggle-cleaner-roster")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
});
