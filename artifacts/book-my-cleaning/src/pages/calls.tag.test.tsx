// @vitest-environment jsdom
/**
 * The call detail's tag strip: one tap sets the verdict, tapping the active
 * tag clears it, and — the part a refactor could silently break — the tag
 * and notes saves each merge only their own field into the cached call
 * detail. A slow notes save that settles after a tag update must never
 * clobber the fresh tag with the stale one its response captured, and vice
 * versa.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type TagVars = { id: number; data: { tag: string | null } };
type NotesVars = { id: number; data: { notes: string } };
type PerCallOptions = {
  onSuccess: (detail: unknown) => void;
  onError?: () => void;
  onSettled?: () => void;
};

// Mutations are recorded and completed manually so each test controls when
// (and with what payload) the server "responds".
let tagCalls: { vars: TagVars; options: PerCallOptions }[] = [];
let notesCalls: { vars: NotesVars; options: PerCallOptions }[] = [];

vi.mock("@workspace/api-client-react", () => ({
  useUpdateCallTag: () => ({
    mutate: (vars: TagVars, options: PerCallOptions) => {
      tagCalls.push({ vars, options });
    },
    isPending: false,
  }),
  useUpdateCallNotes: () => ({
    mutate: (vars: NotesVars, options: PerCallOptions) => {
      notesCalls.push({ vars, options });
    },
    isPending: false,
  }),
  getGetCallQueryKey: (id: number) => ["/api/calls", id],
  getListCallsQueryKey: () => ["/api/calls"],
}));

import { CallTagRow, CallNotesPad } from "./calls";

let queryClient: QueryClient;

function mountTagRow(tag: string | null = null, callId = 7) {
  queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <CallTagRow callId={callId} tag={tag} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  tagCalls = [];
  notesCalls = [];
  vi.useRealTimers();
});

describe("CallTagRow", () => {
  it("tapping a tag saves it", () => {
    mountTagRow(null);
    fireEvent.click(screen.getByTestId("button-tag-call-7-spam"));
    expect(tagCalls).toHaveLength(1);
    expect(tagCalls[0].vars).toEqual({ id: 7, data: { tag: "spam" } });
  });

  it("tapping the active tag clears it", () => {
    mountTagRow("client");
    const active = screen.getByTestId("button-tag-call-7-client");
    expect(active).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(active);
    expect(tagCalls[0].vars).toEqual({ id: 7, data: { tag: null } });
  });

  it("a tag save merges only the tag — it can't roll back newer notes", () => {
    mountTagRow(null);
    // The cache already holds notes newer than what this tag PATCH's
    // response snapshotted on the server.
    queryClient.setQueryData(["/api/calls", 7], {
      id: 7,
      notes: "newer notes typed meanwhile",
      tag: null,
    });
    fireEvent.click(screen.getByTestId("button-tag-call-7-spam"));
    act(() => {
      tagCalls[0].options.onSuccess({
        id: 7,
        notes: "stale notes from before",
        tag: "spam",
      });
    });
    expect(queryClient.getQueryData(["/api/calls", 7])).toEqual({
      id: 7,
      notes: "newer notes typed meanwhile",
      tag: "spam",
    });
  });
});

describe("notes save vs tag update ordering", () => {
  it("a slow notes save can't clobber a tag set while it was in flight", () => {
    vi.useFakeTimers();
    queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <CallNotesPad callId={7} initialNotes="" />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "some notes" },
    });
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(notesCalls).toHaveLength(1);
    // While the notes request is in flight, a tag update lands in the cache.
    queryClient.setQueryData(["/api/calls", 7], {
      id: 7,
      notes: "",
      tag: "spam",
    });
    // The notes response arrives late, carrying the tag as it was BEFORE
    // the tag update (null). It must not overwrite the newer tag.
    act(() => {
      notesCalls[0].options.onSuccess({
        id: 7,
        notes: "some notes",
        tag: null,
      });
      notesCalls[0].options.onSettled?.();
    });
    expect(queryClient.getQueryData(["/api/calls", 7])).toEqual({
      id: 7,
      notes: "some notes",
      tag: "spam",
    });
  });
});
