import { useCallback, useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CornerOwner } from "@/lib/cornerStack";

/**
 * How far down the page you have to be before the button is worth showing.
 * Below this you can reach the top with one flick of the wheel anyway, and a
 * button hovering over a short page is just clutter.
 */
const SHOW_AFTER_PX = 400;

/**
 * A long list — a full day of bookings, a busy call log — leaves the filters
 * and the "New booking" button a long way back up the page. This floats a
 * "Back to top" button once you've scrolled past a screenful, on every page,
 * so nobody has to drag the scrollbar back by hand.
 *
 * The page itself scrolls (the layout is `min-h-screen`, not an inner scroll
 * pane), so this watches the window rather than a container.
 *
 * It shares its corner with the live-call bar and the Live booking launcher,
 * and it never wins that contest: while the launcher is up it queues one
 * step above it, and while the bar is up it steps aside entirely — a call in
 * progress must never have its controls covered by a convenience button.
 */
export function ScrollToTopButton({ corner = null }: { corner?: CornerOwner }) {
  const [visible, setVisible] = useState(false);
  const shown = visible && corner !== "live-call-bar";

  useEffect(() => {
    const update = () => setVisible(window.scrollY > SHOW_AFTER_PX);
    // Run once on mount: a page restored mid-scroll (back button, refresh)
    // must show the button without waiting for the next scroll event.
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  const scrollToTop = useCallback(() => {
    // Honour "reduce motion" — a long smooth scroll is exactly the kind of
    // movement that setting exists to stop.
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  }, []);

  return (
    <button
      type="button"
      onClick={scrollToTop}
      aria-label="Back to top"
      title="Back to top"
      // Hidden from the keyboard and from screen readers while it's off
      // screen, so tabbing through a page never lands on an invisible control.
      aria-hidden={!shown}
      tabIndex={shown ? 0 : -1}
      data-testid="button-scroll-top"
      className={cn(
        "fixed right-4 z-40 print:hidden",
        // One step up while the Live booking launcher holds the corner.
        corner === "live-booking-launcher" ? "bottom-20" : "bottom-4",
        "flex items-center gap-2 rounded-full border border-border bg-card/95 backdrop-blur",
        "px-4 py-3 text-sm font-medium shadow-lg",
        "hover-elevate active-elevate-2",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        "transition-opacity duration-200 motion-reduce:transition-none",
        shown ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      <ArrowUp className="h-4 w-4" aria-hidden="true" />
      <span className="hidden sm:inline">Top</span>
    </button>
  );
}
