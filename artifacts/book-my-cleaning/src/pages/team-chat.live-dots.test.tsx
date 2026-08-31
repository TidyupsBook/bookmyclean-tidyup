// @vitest-environment jsdom
/**
 * The green "live" lights in team chat are pure presentation — the API side
 * is tested, but until now no test rendered the page, so a restyle could
 * silently drop the bubbles. These tests pin the contract:
 *
 * - the conversation list shows a `dot-live-chat-<id>` bubble exactly on
 *   conversations with at least one live member;
 * - a direct chat's pane header shows `dot-live-pane` only when that person
 *   is live, plus the "Live now" text;
 * - a group chat's pane shows a `dot-live-member-<id>` bubble per live
 *   member (and none for the others) plus "N live now";
 * - no live members means no dots and no live text at all;
 * - a group message's author name shows `dot-live-author-<messageId>` only
 *   when that sender is live.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  StaffChatMember,
  StaffConversation,
  StaffMessage,
} from "@workspace/api-client-react";

// The pane fetches its conversation itself; each test points this at the
// fixture it wants before rendering.
let paneData: {
  conversation: StaffConversation;
  myMemberId: number;
  messages: unknown[];
} | null = null;

vi.mock("@workspace/api-client-react", () => ({
  useListStaffConversations: () => ({ data: [], isLoading: false }),
  useGetStaffConversation: () => ({ data: paneData, isLoading: false }),
  useStartStaffConversation: () => ({ mutate: () => {}, isPending: false }),
  useSendStaffMessage: () => ({ mutate: () => {}, isPending: false }),
  useListChatContacts: () => ({ data: [] }),
  getListChatContactsQueryKey: () => ["/api/staff-chat/contacts"],
  getListStaffConversationsQueryKey: () => ["/api/staff-chat/conversations"],
  getGetStaffConversationQueryKey: (id: number) => [
    "/api/staff-chat/conversations",
    id,
  ],
}));

import { ChatPane, ConversationList } from "./team-chat";

// jsdom doesn't implement scrollIntoView; the pane calls it after render.
Element.prototype.scrollIntoView = () => {};

function member(id: number, name: string, isLive: boolean): StaffChatMember {
  return { id, name, isLive };
}

function conversation(
  id: number,
  kind: "direct" | "group",
  members: StaffChatMember[],
): StaffConversation {
  return {
    id,
    kind,
    title: kind === "direct" ? (members[0]?.name ?? "Chat") : "Crew chat",
    memberNames: members.map((m) => m.name),
    members,
    lastMessageAt: "2026-08-08T12:00:00.000Z",
    lastMessagePreview: null,
    unreadCount: 0,
  };
}

function message(
  id: number,
  memberId: number,
  authorName: string,
): StaffMessage {
  return {
    id,
    memberId,
    authorName,
    body: `msg ${id}`,
    createdAt: "2026-08-08T12:00:00.000Z",
  };
}

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  paneData = null;
});

describe("ConversationList live bubbles", () => {
  it("lights exactly the chats that have a live member", () => {
    renderWithClient(
      <ConversationList
        conversations={[
          conversation(1, "direct", [member(10, "Ann", true)]),
          conversation(2, "direct", [member(11, "Bo", false)]),
          conversation(3, "group", [
            member(10, "Ann", false),
            member(12, "Cy", true),
          ]),
        ]}
        activeId={1}
        onSelect={() => {}}
        onStart={() => {}}
      />,
    );
    expect(screen.getByTestId("dot-live-chat-1")).toBeTruthy();
    expect(screen.queryByTestId("dot-live-chat-2")).toBeNull();
    expect(screen.getByTestId("dot-live-chat-3")).toBeTruthy();
  });

  it("shows no bubbles when nobody is live", () => {
    renderWithClient(
      <ConversationList
        conversations={[
          conversation(1, "direct", [member(10, "Ann", false)]),
          conversation(3, "group", [
            member(10, "Ann", false),
            member(12, "Cy", false),
          ]),
        ]}
        activeId={1}
        onSelect={() => {}}
        onStart={() => {}}
      />,
    );
    expect(screen.queryByTestId("dot-live-chat-1")).toBeNull();
    expect(screen.queryByTestId("dot-live-chat-3")).toBeNull();
  });
});

describe("ChatPane header live indicators", () => {
  it("direct chat with a live member: pane dot and 'Live now'", () => {
    paneData = {
      conversation: conversation(1, "direct", [member(10, "Ann", true)]),
      myMemberId: 99,
      messages: [],
    };
    renderWithClient(<ChatPane conversationId={1} />);
    expect(screen.getByTestId("dot-live-pane")).toBeTruthy();
    expect(screen.getByTestId("text-chat-live").textContent).toContain(
      "Live now",
    );
  });

  it("direct chat with nobody live: no dot, no live text", () => {
    paneData = {
      conversation: conversation(1, "direct", [member(10, "Ann", false)]),
      myMemberId: 99,
      messages: [],
    };
    renderWithClient(<ChatPane conversationId={1} />);
    expect(screen.queryByTestId("dot-live-pane")).toBeNull();
    expect(screen.queryByTestId("text-chat-live")).toBeNull();
  });

  it("group chat: one bubble per live member and 'N live now'", () => {
    paneData = {
      conversation: conversation(3, "group", [
        member(10, "Ann", true),
        member(11, "Bo", false),
        member(12, "Cy", true),
      ]),
      myMemberId: 99,
      messages: [],
    };
    renderWithClient(<ChatPane conversationId={3} />);
    expect(screen.getByTestId("dot-live-member-10")).toBeTruthy();
    expect(screen.queryByTestId("dot-live-member-11")).toBeNull();
    expect(screen.getByTestId("dot-live-member-12")).toBeTruthy();
    expect(screen.getByTestId("text-chat-live").textContent).toContain(
      "2 live now",
    );
  });

  it("group chat with nobody live: no member bubbles, no live text", () => {
    paneData = {
      conversation: conversation(3, "group", [
        member(10, "Ann", false),
        member(11, "Bo", false),
      ]),
      myMemberId: 99,
      messages: [],
    };
    renderWithClient(<ChatPane conversationId={3} />);
    expect(screen.queryByTestId("dot-live-member-10")).toBeNull();
    expect(screen.queryByTestId("dot-live-member-11")).toBeNull();
    expect(screen.queryByTestId("text-chat-live")).toBeNull();
  });
});

describe("ChatBubble author live dot", () => {
  it("group chat: dot beside the author name only for live senders", () => {
    paneData = {
      conversation: conversation(3, "group", [
        member(10, "Ann", true),
        member(11, "Bo", false),
      ]),
      myMemberId: 99,
      messages: [message(101, 10, "Ann"), message(102, 11, "Bo")],
    };
    renderWithClient(<ChatPane conversationId={3} />);
    expect(screen.getByTestId("dot-live-author-101")).toBeTruthy();
    expect(screen.queryByTestId("dot-live-author-102")).toBeNull();
  });

  it("my own messages never show an author dot, even if I'm live", () => {
    paneData = {
      conversation: conversation(3, "group", [member(10, "Ann", true)]),
      myMemberId: 10,
      messages: [message(101, 10, "Ann")],
    };
    renderWithClient(<ChatPane conversationId={3} />);
    expect(screen.queryByTestId("dot-live-author-101")).toBeNull();
  });

  it("direct chat: no author dot (names aren't shown)", () => {
    paneData = {
      conversation: conversation(1, "direct", [member(10, "Ann", true)]),
      myMemberId: 99,
      messages: [message(101, 10, "Ann")],
    };
    renderWithClient(<ChatPane conversationId={1} />);
    expect(screen.queryByTestId("dot-live-author-101")).toBeNull();
  });
});
