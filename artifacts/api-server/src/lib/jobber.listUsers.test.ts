import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * listJobberUsers must be EXHAUSTIVE: the Team page reads absence from this
 * list as "their Jobber account was deactivated" and offers Unlink, so a
 * partial page would falsely accuse active staff. Pin here that pagination
 * follows the cursor to the end, and that an unfinishable listing fails
 * loudly instead of returning fewer users than exist.
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { listJobberUsers } from "./jobber";

function graphqlResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: body }),
  };
}

function usersPage(
  nodes: Array<{ id: string; name: string }>,
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
) {
  return graphqlResponse({
    users: {
      nodes: nodes.map((n) => ({ id: n.id, name: { full: n.name } })),
      pageInfo,
    },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("listJobberUsers", () => {
  it("follows the cursor so a user on a later page is still reported", async () => {
    fetchMock
      .mockResolvedValueOnce(
        usersPage([{ id: "ju_1", name: "First Page" }], {
          hasNextPage: true,
          endCursor: "cur_1",
        }),
      )
      .mockResolvedValueOnce(
        usersPage([{ id: "ju_2", name: "Second Page" }], {
          hasNextPage: false,
          endCursor: "cur_2",
        }),
      );

    const users = await listJobberUsers("tok");
    expect(users).toEqual([
      { id: "ju_1", name: "First Page" },
      { id: "ju_2", name: "Second Page" },
    ]);

    // The second request really asked for the page after the first.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(
      (fetchMock.mock.calls[1]![1] as { body: string }).body,
    ) as { variables: { after: string | null } };
    expect(secondBody.variables.after).toBe("cur_1");
  });

  it("stops after one request when there is a single page", async () => {
    fetchMock.mockResolvedValueOnce(
      usersPage([{ id: "ju_1", name: "Only Page" }], {
        hasNextPage: false,
        endCursor: null,
      }),
    );
    await expect(listJobberUsers("tok")).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a partial list rather than never finishing", async () => {
    // Jobber claims another page forever; the loop must throw, not return
    // whatever it happened to gather, because callers treat the result as
    // complete.
    fetchMock.mockResolvedValue(
      usersPage([{ id: "ju_x", name: "Endless" }], {
        hasNextPage: true,
        endCursor: "cur_more",
      }),
    );
    await expect(listJobberUsers("tok")).rejects.toThrow(/partial list/);
  });

  it("fails loudly when a next page comes with no cursor", async () => {
    fetchMock.mockResolvedValueOnce(
      usersPage([{ id: "ju_1", name: "Broken Page" }], {
        hasNextPage: true,
        endCursor: null,
      }),
    );
    await expect(listJobberUsers("tok")).rejects.toThrow(/no cursor/);
  });
});
