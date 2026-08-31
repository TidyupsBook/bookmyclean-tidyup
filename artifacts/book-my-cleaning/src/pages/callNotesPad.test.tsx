// @vitest-environment jsdom
/**
 * The call notepad autosaves ~800ms after typing stops and flushes unsaved
 * keystrokes when the modal closes. These tests pin that contract so a
 * refactor can't silently drop the last keystrokes or hide a failed save:
 *
 * - the debounce fires after the pause, with the latest text
 * - unmounting mid-pause (the modal closing) still saves
 * - a failed save shows "Couldn't save" and the typed text stays put
 * - saves are serialized: while one request is in flight no second one is
 *   issued, and the latest draft is sent once it settles — so the server
 *   can never apply an older note last, a stale success can't claim newer
 *   text is saved, and a stale failure can't flip a saved note to an error
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Vars = { id: number; data: { notes: string } };
type PerCallOptions = {
  onSuccess: (detail: unknown) => void;
  onError: () => void;
  onSettled: () => void;
};

// Every mutate call is recorded and completed manually by each test, so
// success, failure, and completion timing are all controllable. The mock
// also models what a real backend persists: last write applied wins.
let mutateCalls: { vars: Vars; options: PerCallOptions }[] = [];
let serverNotes = "";

vi.mock("@workspace/api-client-react", () => ({
  useUpdateCallNotes: () => ({
    mutate: (vars: Vars, options: PerCallOptions) => {
      mutateCalls.push({ vars, options });
    },
    isPending: false,
  }),
  getGetCallQueryKey: (id: number) => ["/api/calls", id],
}));

import { CallNotesPad } from "./calls";

function succeed(index: number) {
  const call = mutateCalls[index];
  serverNotes = call.vars.data.notes; // this write commits now
  act(() => {
    call.options.onSuccess({ id: call.vars.id, notes: call.vars.data.notes });
    call.options.onSettled();
  });
}

function fail(index: number) {
  act(() => {
    mutateCalls[index].options.onError();
    mutateCalls[index].options.onSettled();
  });
}

let queryClient: QueryClient;

function mount(initialNotes = "") {
  queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <CallNotesPad callId={42} initialNotes={initialNotes} />
    </QueryClientProvider>,
  );
}

function textarea(): HTMLTextAreaElement {
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

function type(text: string) {
  fireEvent.change(textarea(), { target: { value: text } });
}

function sentNotes(): string[] {
  return mutateCalls.map((c) => c.vars.data.notes);
}

beforeEach(() => {
  vi.useFakeTimers();
  mutateCalls = [];
  serverNotes = "";
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("debounced autosave", () => {
  it("saves once, with the latest text, after typing pauses", () => {
    mount();
    type("Gate code is");
    act(() => vi.advanceTimersByTime(500)); // still typing — no save yet
    expect(mutateCalls).toHaveLength(0);
    type("Gate code is 4482");
    act(() => vi.advanceTimersByTime(799));
    expect(mutateCalls).toHaveLength(0);
    act(() => vi.advanceTimersByTime(1));
    expect(sentNotes()).toEqual(["Gate code is 4482"]);
    expect(mutateCalls[0].vars.id).toBe(42);

    succeed(0);
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("shows Saving… while the pause has not elapsed", () => {
    mount();
    type("half a thought");
    expect(screen.getByText("Saving…")).toBeTruthy();
  });

  it("does not save when nothing changed", () => {
    mount("already stored");
    act(() => vi.advanceTimersByTime(2000));
    expect(mutateCalls).toHaveLength(0);
  });
});

describe("closing the modal mid-pause", () => {
  it("flushes the unsaved keystrokes on unmount", () => {
    const view = mount();
    type("caller wants Fridays only");
    act(() => vi.advanceTimersByTime(300)); // debounce has NOT fired
    expect(mutateCalls).toHaveLength(0);

    view.unmount();
    expect(sentNotes()).toEqual(["caller wants Fridays only"]);
  });

  it("does not save again on unmount when everything was already saved", () => {
    const view = mount();
    type("done");
    act(() => vi.advanceTimersByTime(800));
    expect(mutateCalls).toHaveLength(1);
    succeed(0);

    view.unmount();
    expect(mutateCalls).toHaveLength(1);
  });
});

describe("a failed save", () => {
  it("shows Couldn't save and keeps the typed text", () => {
    mount();
    type("very important detail");
    act(() => vi.advanceTimersByTime(800));
    expect(mutateCalls).toHaveLength(1);

    fail(0);
    expect(screen.getByText("Couldn't save")).toBeTruthy();
    expect(textarea().value).toBe("very important detail");
  });

  it("retries when the user types again after a failure", () => {
    mount();
    type("first try");
    act(() => vi.advanceTimersByTime(800));
    fail(0);

    type("first try, second attempt");
    act(() => vi.advanceTimersByTime(800));
    expect(sentNotes()).toEqual(["first try", "first try, second attempt"]);
  });

  it("still flushes unsaved text at unmount after a failure", () => {
    const view = mount();
    type("must not vanish");
    act(() => vi.advanceTimersByTime(800));
    fail(0);

    view.unmount();
    expect(sentNotes()).toEqual(["must not vanish", "must not vanish"]);
  });
});

describe("overlapping saves", () => {
  it("never has two requests in flight, so the server cannot apply an older note last", () => {
    const view = mount();
    type("A");
    act(() => vi.advanceTimersByTime(800)); // save "A" in flight
    type("AB");
    act(() => vi.advanceTimersByTime(800)); // debounce fires, but "A" is still in flight
    expect(sentNotes()).toEqual(["A"]); // no overlapping second request

    succeed(0); // "A" commits; the latest draft goes out immediately
    expect(sentNotes()).toEqual(["A", "AB"]);
    expect(screen.queryByText("Saved")).toBeNull(); // "AB" not saved yet

    succeed(1);
    expect(serverNotes).toBe("AB"); // the newest text is what persisted
    expect(textarea().value).toBe("AB");
    expect(screen.getByText("Saved")).toBeTruthy();

    // Nothing left to save: no stray timer resend, no redundant unmount flush.
    act(() => vi.advanceTimersByTime(2000));
    view.unmount();
    expect(mutateCalls).toHaveLength(2);
  });

  it("keystrokes typed mid-save still reach the server when the modal closes first", () => {
    const view = mount();
    type("A");
    act(() => vi.advanceTimersByTime(800)); // save "A" in flight
    type("AB"); // newer keystrokes, debounce never fires…
    view.unmount(); // …because the modal closes now
    expect(sentNotes()).toEqual(["A"]); // flush deferred: "A" still in flight

    succeed(0); // when it settles, the newest text is sent
    expect(sentNotes()).toEqual(["A", "AB"]);
    succeed(1);
    expect(serverNotes).toBe("AB");
  });

  it("a failure mid-stream does not flag an error for text the user already replaced", () => {
    mount();
    type("A");
    act(() => vi.advanceTimersByTime(800)); // save "A" in flight
    type("AB");

    fail(0); // the "A" request errors out
    // A newer draft is being attempted — no false alarm for stale text…
    expect(screen.queryByText("Couldn't save")).toBeNull();
    // …and the newer draft was sent as soon as the failed request settled.
    expect(sentNotes()).toEqual(["A", "AB"]);

    fail(1); // the newest text really does fail
    expect(screen.getByText("Couldn't save")).toBeTruthy();
    expect(textarea().value).toBe("AB"); // text is not discarded
  });
});
