import { useEffect, useId, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { useGetAddressSuggestions } from "@workspace/api-client-react";
import { MapPin } from "lucide-react";

/**
 * Address box with address suggestions.
 *
 * The lookup happens on our server, not in the browser: suggestions used to go
 * straight to Google from here, which only worked on a Maps key with the newest
 * Places API switched on, and failed as a silent rejected promise when it
 * wasn't. Server-side, the same key can fall back to Google's older endpoint
 * and any refusal is logged.
 *
 * Suggestions stay a convenience, never a requirement: if Google is unreachable
 * or the key has no Places access at all, this is an ordinary text box and
 * whatever was typed still gets geocoded when it's saved. Picking a suggestion
 * fills in the full, well-formed address — which matters because a half-written
 * address ("123 Main St", no city) geocodes to a confidently wrong place rather
 * than failing.
 */

const MIN_CHARS = 3;
const DEBOUNCE_MS = 250;

export function AddressAutocomplete({
  id,
  testId,
  value,
  onChange,
  onSelect,
  placeholder,
  bias,
  disabled,
  className,
}: {
  /** So a <Label htmlFor> still points at the box. */
  id?: string;
  testId?: string;
  value: string;
  onChange: (value: string) => void;
  /**
   * Fired once the caller has actually *picked* a suggestion, with the best
   * address we have for it. Typing alone never fires this — only a deliberate
   * choice — so a caller can act on the selection without acting on keystrokes.
   */
  onSelect?: (address: string) => void;
  placeholder?: string;
  /** Nudges results toward the area the crew actually works in. */
  bias?: { lat: number; lng: number };
  disabled?: boolean;
  /** Extra classes for the box itself — the booking desk lights it up green
   *  when a live call filled the address in. */
  className?: string;
}) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Set just before a chosen address is written back into the field, so the
  // effect below doesn't immediately look that address up again.
  const skipNextLookupRef = useRef(false);

  // Object identity would change every render, so depend on the numbers.
  const biasLat = bias?.lat;
  const biasLng = bias?.lng;

  useEffect(() => {
    if (skipNextLookupRef.current) {
      skipNextLookupRef.current = false;
      setQuery("");
      setOpen(false);
      return;
    }

    const trimmed = value.trim();
    if (trimmed.length < MIN_CHARS) {
      setQuery("");
      setOpen(false);
      return;
    }

    const timer = window.setTimeout(() => setQuery(trimmed), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [value]);

  const enabled = query.length >= MIN_CHARS && !disabled;
  const { data } = useGetAddressSuggestions(
    { q: query, lat: biasLat, lng: biasLng },
    {
      query: {
        queryKey: ["address-suggestions", query, biasLat, biasLng],
        enabled,
        // The same street typed twice in a session shouldn't cost two lookups.
        staleTime: 5 * 60 * 1000,
        retry: false,
      },
    },
  );

  const suggestions = enabled ? (data?.suggestions ?? []) : [];
  const unavailable = enabled && data?.available === false;

  useEffect(() => {
    setActiveIndex(-1);
    setOpen(suggestions.length > 0);
    // Reacting to the arrival of a result set, not to every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, enabled]);

  // Clicking anywhere else closes the list.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const choose = (suggestion: { full: string }) => {
    skipNextLookupRef.current = true;
    onChange(suggestion.full);
    setOpen(false);
    setActiveIndex(-1);
    onSelect?.(suggestion.full);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || suggestions.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => (i + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault();
      choose(suggestions[activeIndex]!);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <Input
        id={id}
        data-testid={testId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          if (suggestions.length > 0) setOpen(true);
        }}
        placeholder={placeholder}
        disabled={disabled}
        className={className}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={listId}
        aria-activedescendant={
          activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined
        }
      />

      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-md border border-border bg-popover shadow-lg"
        >
          {suggestions.map((suggestion, index) => (
            <li key={`${suggestion.id}-${index}`} role="presentation">
              <button
                type="button"
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                // Keep focus in the input so blur doesn't close us first.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(suggestion)}
                className={`flex w-full items-start gap-2 px-3 py-2 text-left transition-colors ${
                  index === activeIndex ? "bg-secondary" : "hover:bg-secondary"
                }`}
              >
                <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block truncate text-sm text-foreground">
                    {suggestion.primary}
                  </span>
                  {suggestion.secondary && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {suggestion.secondary}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {unavailable && (
        <p className="mt-1 text-xs text-muted-foreground">
          Address suggestions are off — your Google Maps key doesn't allow them
          yet. Typing the full address still works.
        </p>
      )}
    </div>
  );
}
