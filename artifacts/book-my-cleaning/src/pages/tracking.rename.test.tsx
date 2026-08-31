// @vitest-environment jsdom
/**
 * Every device on the tracking page can be renamed, not just the browser the
 * owner happens to be sitting at.
 *
 * The pencil used to exist only on the "This device" card, so the office PC
 * could be renamed from the office PC and nowhere else. This pins the rule
 * that matters: any row opens an editor, and saving sends the new name to the
 * server for THAT device id — the id is how a rename reaches a machine that
 * isn't the one being typed on.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const renameMutate = vi.fn();

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useRenameStaffDevice: () => ({
      mutate: renameMutate,
      isPending: false,
    }),
    useSetOfficeDevice: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
  };
});

import { DeviceRow } from "./tracking";

afterEach(() => {
  cleanup();
  renameMutate.mockClear();
});

const device = {
  id: 77,
  label: "Boss PC",
  platform: "web",
  isOffice: false,
  lastSeenAt: null,
  live: false,
  lat: null,
  lng: null,
  accuracy: null,
};

function renderRow() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ul>
        <DeviceRow device={device} />
      </ul>
    </QueryClientProvider>,
  );
}

describe("renaming a device from the tracking page", () => {
  it("saves the new name against that device's id", () => {
    renderRow();

    fireEvent.click(screen.getByTestId("button-rename-device-77"));
    fireEvent.change(screen.getByTestId("input-device-name-77"), {
      target: { value: "Tidyups Location" },
    });
    fireEvent.click(screen.getByTestId("button-save-device-name-77"));

    expect(renameMutate).toHaveBeenCalledWith({
      id: 77,
      data: { label: "Tidyups Location" },
    });
  });

  it("doesn't send an empty name, or one that hasn't changed", () => {
    renderRow();

    fireEvent.click(screen.getByTestId("button-rename-device-77"));
    fireEvent.change(screen.getByTestId("input-device-name-77"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByTestId("button-save-device-name-77"));
    expect(renameMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("button-rename-device-77"));
    fireEvent.click(screen.getByTestId("button-save-device-name-77"));
    expect(renameMutate).not.toHaveBeenCalled();
  });

  it("closes the editor on Escape without saving", () => {
    renderRow();

    fireEvent.click(screen.getByTestId("button-rename-device-77"));
    fireEvent.change(screen.getByTestId("input-device-name-77"), {
      target: { value: "Half typed" },
    });
    fireEvent.keyDown(screen.getByTestId("input-device-name-77"), {
      key: "Escape",
    });

    expect(renameMutate).not.toHaveBeenCalled();
    expect(screen.getByTestId("button-rename-device-77")).toHaveTextContent(
      "Boss PC",
    );
  });
});
