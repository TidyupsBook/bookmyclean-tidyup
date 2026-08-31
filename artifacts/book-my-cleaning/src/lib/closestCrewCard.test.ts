import { describe, expect, it } from "vitest";
import { closestCrewHtml } from "./closestCrewCard";
import { nearestCleaners, formatKm } from "./nearest";
import { colorForTeamMember } from "./mapMarkers";

const EDMONTON = { lat: 53.5461, lng: -113.4938 };
const NOW = Date.parse("2026-08-08T12:00:00Z");

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

/** Names in card order — one match per row, so order is the render order. */
function namesInOrder(html: string): string[] {
  return [...html.matchAll(/data-crew-name[^>]*>([^<]+)</g)].map((m) =>
    m[1]!.trim(),
  );
}

/** The rendered distance strings, in card order. */
function distancesInOrder(html: string): string[] {
  return [...html.matchAll(/color:#111">([^<]+)<\/span>/g)].map((m) => m[1]!);
}

describe("closestCrewHtml — the live-visibility label", () => {
  const staffHomes = [
    home(1, "Ann", 53.5462, -113.4939), // nearest
    home(2, "Bo", 53.6, -113.6),
    home(3, "Cy", 53.7, -113.9), // farthest
  ];
  const ranked = nearestCleaners(EDMONTON, { staffHomes }, NOW);

  it("labels exactly the members in the hide set, never the visible ones", () => {
    const html = closestCrewHtml(ranked, new Set([2]));
    // Each crew line starts with the same flex wrapper — split on it to
    // inspect one row at a time. Rows are found by the rendered name token
    // ">Bo<", never the bare name: the inline marker SVGs contain "viewBox",
    // which contains "Bo", so a bare-substring match lands on the wrong row.
    const rows = html.split(`<div style="display:flex`).slice(1);
    const annRow = rows.find((r) => r.includes(">Ann<"))!;
    const boRow = rows.find((r) => r.includes(">Bo<"))!;
    const cyRow = rows.find((r) => r.includes(">Cy<"))!;
    expect(boRow).toContain("· live hidden");
    expect(annRow).not.toContain("live hidden");
    expect(cyRow).not.toContain("live hidden");
  });

  it("shows no label at all when nobody is hidden", () => {
    expect(closestCrewHtml(ranked, new Set())).not.toContain("live hidden");
  });

  it("keeps ranking order and distances identical with and without the hide set", () => {
    // Hiding is a display preference, not an availability filter: the hidden
    // nearest cleaner must keep her exact rank and distance, only gaining
    // the label. If a refactor filters or reorders by the hide set, the
    // order or the distances here diverge.
    const withHide = closestCrewHtml(ranked, new Set([1, 3]));
    const without = closestCrewHtml(ranked, new Set());

    expect(namesInOrder(withHide)).toEqual(["Ann", "Bo", "Cy"]);
    expect(namesInOrder(withHide)).toEqual(namesInOrder(without));
    expect(distancesInOrder(withHide)).toEqual(distancesInOrder(without));
    expect(distancesInOrder(withHide)).toEqual(
      ranked.map((c) => formatKm(c.km)),
    );
  });

  it("renders nothing when there is no ranked crew", () => {
    expect(closestCrewHtml([], new Set([1]))).toBe("");
  });

  it("lists the whole crew, nearest first, not just the top few", () => {
    const many = nearestCleaners(
      EDMONTON,
      { staffHomes: [...staffHomes, home(4, "Dee", 53.8, -114.0)] },
      NOW,
    );
    const html = closestCrewHtml(many, new Set());
    expect(namesInOrder(html)).toEqual(["Ann", "Bo", "Cy", "Dee"]);
  });

  it("paints each member in their own colour and tags only the leader as closest", () => {
    const html = closestCrewHtml(ranked, new Set());
    for (const member of ranked) {
      expect(html).toContain(
        colorForTeamMember(member.teamMemberId, member.color),
      );
    }
    // "(closest)" rides on the first row only. ">Bo<" rather than "Bo":
    // the SVGs' viewBox attribute would match the bare name first.
    expect(html.match(/\(closest\)/g)).toHaveLength(1);
    const firstRowEnd = html.indexOf(">Bo<");
    expect(html.slice(0, firstRowEnd)).toContain("(closest)");
  });

  it("renders non-destructive compare buttons when requested", () => {
    const html = closestCrewHtml(ranked, new Set(), { compare: true });
    for (const member of ranked) {
      expect(html).toContain(`data-crew-compare="${member.teamMemberId}"`);
    }
    expect(html).toContain("Select a cleaner to draw this distance on the map");
    expect(html).not.toContain("/bookings/new");
  });

  it("keeps booking as a separate, plainly labelled action", () => {
    const html = closestCrewHtml(ranked, new Set(), {
      compare: true,
      bookHref: (cleaner) =>
        `/bookings/new?rebookId=7&assign=${cleaner.teamMemberId}`,
    });
    for (const member of ranked) {
      expect(html).toContain(`data-crew-compare="${member.teamMemberId}"`);
      expect(html).toContain(`data-crew-book="${member.teamMemberId}"`);
      expect(html).toContain(
        `href="/bookings/new?rebookId=7&amp;assign=${member.teamMemberId}"`,
      );
      expect(html).toContain(`aria-label="Book ${member.name}"`);
    }
    expect(html).toContain(
      "Select a cleaner to compare, or use Book to start a booking.",
    );
  });

  it("renders plain rows when comparison is unavailable", () => {
    const html = closestCrewHtml(ranked, new Set());
    expect(html).not.toContain("data-crew-compare");
    expect(html).not.toContain("/bookings/new");
    expect(html).not.toContain("Select a cleaner");
  });

  it("escapes a hostile name instead of rendering it as markup", () => {
    const spiky = nearestCleaners(
      EDMONTON,
      { staffHomes: [home(9, 'Smith & Sons <Ltd> "Inc"', 53.55, -113.5)] },
      NOW,
    );
    const html = closestCrewHtml(spiky, new Set());
    expect(html).toContain("Smith &amp; Sons &lt;Ltd&gt; &quot;Inc&quot;");
    expect(html).not.toContain("<Ltd>");
  });
});
