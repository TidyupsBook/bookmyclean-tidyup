// @vitest-environment jsdom
/**
 * The "Who's closest" panel and the roster strip's hide set.
 *
 * These tests pin the third copy of the "live hidden" label — the one
 * rendered as JSX in the ClosestCrew panel row (the other two, in the marker
 * info cards, share closestCrewCard.ts and are pinned by its own tests):
 *
 *  - the label appears exactly for members in the hide set, never for the
 *    visible ones;
 *  - hiding someone changes nothing about the ranking — same order, same
 *    distances — because hiding is a display preference, not an availability
 *    filter.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ClosestCrew } from "./map";

const EDMONTON = { lat: 53.5461, lng: -113.4938 };

function home(teamMemberId: number, name: string, lat: number, lng: number) {
  return {
    teamMemberId,
    name,
    color: null,
    roleLabel: "Cleaner",
    address: `${name} street`,
    lat,
    lng,
    active: true,
  };
}

const mapData = {
  staffHomes: [
    home(1, "Ann", 53.5462, -113.4939), // nearest — and the one we hide
    home(2, "Bo", 53.6, -113.6),
    home(3, "Cy", 53.7, -113.9), // farthest
  ],
} as any;

const target = {
  label: "123 Test Ave",
  address: null,
  lat: EDMONTON.lat,
  lng: EDMONTON.lng,
  origin: "search" as const,
};

function renderPanel(
  hiddenCleaners: Set<number>,
  onCompare = vi.fn(),
  canBook = false,
  searchProps: Record<string, unknown> = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ClosestCrew
        target={target}
        mapData={mapData}
        hiddenCleaners={hiddenCleaners}
        onSearch={() => {}}
        onClear={() => {}}
        onCompare={onCompare}
        canBook={canBook}
        {...searchProps}
      />
    </QueryClientProvider>,
  );
}

/** One { name, distance, hidden } record per row, in render order. */
function readRows(container: HTMLElement) {
  const list = within(container).getByTestId("list-closest-crew");
  return Array.from(list.querySelectorAll("li")).map((li) => {
    const text = li.textContent ?? "";
    return {
      hidden: text.includes("· live hidden"),
      name: text.includes("Ann") ? "Ann" : text.includes("Bo") ? "Bo" : "Cy",
      distance: text.match(/([\d.]+ (?:m|km))/)?.[1] ?? "",
    };
  });
}

afterEach(cleanup);

describe("ClosestCrew panel — live visibility and comparison", () => {
  it("labels exactly the hidden members and nobody else", () => {
    const { container } = renderPanel(new Set([1]));
    const rows = readRows(container);
    expect(rows.find((r) => r.name === "Ann")!.hidden).toBe(true);
    expect(rows.find((r) => r.name === "Bo")!.hidden).toBe(false);
    expect(rows.find((r) => r.name === "Cy")!.hidden).toBe(false);
    // The testid the label carries, pinned so a refactor can't drop it.
    expect(within(container).getByTestId("text-hidden-cleaner-1")).toBeTruthy();
  });

  it("shows no label when nobody is hidden", () => {
    const { container } = renderPanel(new Set());
    expect(readRows(container).every((r) => !r.hidden)).toBe(true);
  });

  it("keeps order and distances identical with and without the hide set", () => {
    const withHide = renderPanel(new Set([1, 3]));
    const rowsHidden = readRows(withHide.container);
    withHide.unmount();
    const without = renderPanel(new Set());
    const rowsShown = readRows(without.container);

    // The nearest cleaner stays first even while hidden — hiding never
    // reorders or drops anyone, and every distance is unchanged.
    expect(rowsHidden.map((r) => r.name)).toEqual(["Ann", "Bo", "Cy"]);
    expect(rowsHidden.map((r) => r.name)).toEqual(rowsShown.map((r) => r.name));
    expect(rowsHidden.map((r) => r.distance)).toEqual(
      rowsShown.map((r) => r.distance),
    );
  });

  it("compares a cleaner to the selected address without a booking link", () => {
    const onCompare = vi.fn();
    const { container } = renderPanel(new Set(), onCompare);
    const ann = within(container).getByTestId("button-compare-cleaner-1");
    expect(ann.getAttribute("aria-label")).toBe(
      "Compare Ann with 123 Test Ave",
    );
    fireEvent.click(ann);
    expect(onCompare).toHaveBeenCalledTimes(1);
    expect(onCompare.mock.calls[0][0]).toMatchObject({
      teamMemberId: 1,
      name: "Ann",
      source: "home",
      lat: 53.5462,
      lng: -113.4939,
    });
    expect(onCompare.mock.calls[0][1]).toEqual(target);
    expect(container.querySelector('a[href^="/bookings/new"]')).toBeNull();
  });

  it("keeps booking behind a separate, explicit control for dispatch", () => {
    const onCompare = vi.fn();
    const { container } = renderPanel(new Set(), onCompare, true);
    const compare = within(container).getByTestId("button-compare-cleaner-1");
    const book = within(container).getByTestId("link-book-cleaner-1");

    expect(book.textContent).toBe("Book");
    expect(book.getAttribute("aria-label")).toBe("Book Ann");
    expect(book.getAttribute("href")).toBe("/bookings/new?assign=1");

    fireEvent.click(compare);
    expect(onCompare).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).not.toBe("/bookings/new");
  });

  it("keeps multiple searched destinations available until explicitly removed", () => {
    const onSelectSearch = vi.fn();
    const onRemoveSearch = vi.fn();
    const onClearSearches = vi.fn();
    const searchedTargets = [
      { ...target, searchId: 1, ordinal: 1 },
      {
        ...target,
        label: "456 Second Street",
        lat: 53.5,
        lng: -113.6,
        searchId: 2,
        ordinal: 2,
      },
    ];
    const { container } = renderPanel(new Set(), vi.fn(), false, {
      searchedTargets,
      onSelectSearch,
      onRemoveSearch,
      onClearSearches,
    });

    const history = within(container).getByTestId("searched-destinations");
    expect(history.textContent).toContain("123 Test Ave");
    expect(history.textContent).toContain("456 Second Street");
    expect(history.textContent).toContain("S1");
    expect(history.textContent).toContain("S2");

    fireEvent.click(
      within(history).getByRole("button", { name: "S2 456 Second Street" }),
    );
    expect(onSelectSearch).toHaveBeenCalledWith(searchedTargets[1]);

    fireEvent.click(
      within(history).getByRole("button", {
        name: "Remove searched pin 1",
      }),
    );
    expect(onRemoveSearch).toHaveBeenCalledWith(1);

    fireEvent.click(within(history).getByText("Clear all"));
    expect(onClearSearches).toHaveBeenCalledTimes(1);
  });
});
