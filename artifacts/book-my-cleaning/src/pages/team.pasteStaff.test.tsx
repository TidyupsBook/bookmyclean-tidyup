// @vitest-environment jsdom
/**
 * A pasted line with no name must show up in the preview as a problem row —
 * "No name — skipped" — never as "New". The server refuses such rows, so a
 * green "New" badge here would be a promise the submit can't keep. The rows
 * are shown in paste order so the owner can find and fix the bad line.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { PasteStaffCard } from "./team";

// jsdom has no layout engine, so scrollIntoView doesn't exist there.
window.HTMLElement.prototype.scrollIntoView = () => {};

afterEach(() => cleanup());

function paste(text: string) {
  render(
    <PasteStaffCard
      team={[]}
      submitting={false}
      onClose={() => {}}
      onSubmit={() => {}}
    />,
  );
  fireEvent.change(screen.getByTestId("input-paste-staff"), {
    target: { value: text },
  });
}

describe("PasteStaffCard blank-name rows", () => {
  it("labels a nameless line 'No name — skipped', never 'New'", () => {
    paste("Jane Doe, jane@example.com\n, nameless@example.com, 555-0100");

    const first = screen.getByTestId("row-paste-preview-0");
    const second = screen.getByTestId("row-paste-preview-1");
    expect(first).toHaveTextContent("Jane Doe");
    expect(first).toHaveTextContent("New");

    expect(second).toHaveTextContent("No name — skipped");
    expect(second).toHaveTextContent("(no name)");
    // The line stays identifiable by what it did carry.
    expect(second).toHaveTextContent("nameless@example.com");
    expect(second).not.toHaveTextContent("New");
  });

  it("treats a whitespace-only name as blank too", () => {
    paste("   , someone@example.com");
    expect(screen.getByTestId("row-paste-preview-0")).toHaveTextContent(
      "No name — skipped",
    );
  });

  it("counts nameless lines in the summary and keeps submit disabled when nothing lands", () => {
    paste(", a@example.com\n, b@example.com");
    expect(screen.getByTestId("preview-paste-staff")).toHaveTextContent(
      "2 without a name will be skipped",
    );
    expect(screen.getByTestId("button-submit-paste-staff")).toBeDisabled();
  });

  it("submits only the named rows, in order", () => {
    const onSubmit = vi.fn();
    render(
      <PasteStaffCard
        team={[]}
        submitting={false}
        onClose={() => {}}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByTestId("input-paste-staff"), {
      target: { value: "Jane Doe\n, skip@example.com\nSam Lee" },
    });
    fireEvent.click(screen.getByTestId("button-submit-paste-staff"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submitted = onSubmit.mock.calls[0]![0] as { name: string }[];
    expect(submitted.map((r) => r.name)).toEqual(["Jane Doe", "Sam Lee"]);
  });
});
