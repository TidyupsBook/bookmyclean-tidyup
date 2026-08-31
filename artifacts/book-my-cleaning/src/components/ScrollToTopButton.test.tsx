// @vitest-environment jsdom
/**
 * The "Back to top" button only earns its place on screen once a page is
 * genuinely long. These tests pin that: hidden (and unreachable by keyboard)
 * near the top, visible after a screenful, and it actually sends the page
 * back to the top when pressed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ScrollToTopButton } from "./ScrollToTopButton";

function scrollTo(y: number) {
  Object.defineProperty(window, "scrollY", {
    value: y,
    writable: true,
    configurable: true,
  });
  fireEvent.scroll(window);
}

let scrollSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollSpy = vi.fn();
  Object.defineProperty(window, "scrollTo", {
    value: scrollSpy,
    writable: true,
    configurable: true,
  });
  scrollTo(0);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ScrollToTopButton", () => {
  it("stays out of the way — and out of the tab order — near the top", () => {
    render(<ScrollToTopButton />);
    const button = screen.getByTestId("button-scroll-top");
    expect(button).toHaveClass("opacity-0");
    expect(button).toHaveAttribute("aria-hidden", "true");
    expect(button).toHaveAttribute("tabindex", "-1");
  });

  it("appears once you've scrolled past a screenful", () => {
    render(<ScrollToTopButton />);
    scrollTo(800);
    const button = screen.getByTestId("button-scroll-top");
    expect(button).toHaveClass("opacity-100");
    expect(button).toHaveAttribute("aria-hidden", "false");
    expect(button).toHaveAttribute("tabindex", "0");
  });

  it("hides again when you scroll back up", () => {
    render(<ScrollToTopButton />);
    scrollTo(800);
    scrollTo(10);
    expect(screen.getByTestId("button-scroll-top")).toHaveClass("opacity-0");
  });

  it("shows straight away on a page restored part-way down", () => {
    // Back button / refresh restores the scroll position before we mount, so
    // the first paint must already know the page is scrolled.
    Object.defineProperty(window, "scrollY", {
      value: 900,
      writable: true,
      configurable: true,
    });
    render(<ScrollToTopButton />);
    expect(screen.getByTestId("button-scroll-top")).toHaveClass("opacity-100");
  });

  it("scrolls the page back to the top when pressed", () => {
    render(<ScrollToTopButton />);
    scrollTo(800);
    fireEvent.click(screen.getByTestId("button-scroll-top"));
    expect(scrollSpy).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });

  it("queues one step above the Live booking launcher when it holds the corner", () => {
    render(<ScrollToTopButton corner="live-booking-launcher" />);
    scrollTo(800);
    const button = screen.getByTestId("button-scroll-top");
    expect(button).toHaveClass("bottom-20");
    expect(button).not.toHaveClass("bottom-4");
    expect(button).toHaveClass("opacity-100");
  });

  it("steps aside entirely while the live-call bar is up", () => {
    render(<ScrollToTopButton corner="live-call-bar" />);
    scrollTo(800);
    const button = screen.getByTestId("button-scroll-top");
    expect(button).toHaveClass("opacity-0");
    expect(button).toHaveAttribute("aria-hidden", "true");
    expect(button).toHaveAttribute("tabindex", "-1");
  });

  it("jumps instantly instead of gliding when motion is reduced", () => {
    Object.defineProperty(window, "matchMedia", {
      value: (query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
      writable: true,
      configurable: true,
    });
    render(<ScrollToTopButton />);
    scrollTo(800);
    fireEvent.click(screen.getByTestId("button-scroll-top"));
    expect(scrollSpy).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
  });
});
