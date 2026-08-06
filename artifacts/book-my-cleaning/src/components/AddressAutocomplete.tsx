import { useEffect, useId, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { loadGooglePlaces } from "@/lib/googleMaps";
import { MapPin } from "lucide-react";

/**
 * Address box with Google address suggestions.
 *
 * Suggestions are a convenience, never a requirement: if the key has no Places
 * access, or the network hiccups, this quietly becomes an ordinary text box and
 * whatever was typed still gets geocoded server-side. Picking a suggestion just
 * fills in the full, well-formed address — which matters because a half-written
 * address ("123 Main St", no city) geocodes to a confidently wrong place rather
 * than failing.
 */

const MIN_CHARS = 3;
const DEBOUNCE_MS = 250;
/** Google caps the bias radius at 50km. */
const BIAS_RADIUS_M = 50_000;
const MAX_SUGGESTIONS = 5;

type Suggestion = {
  id: string;
  primary: string;
  secondary: string;
  full: string;
  /** Google's handle for looking the place up, carrying the session token. */
  toPlace?: () => any;
};

export function AddressAutocomplete({
  apiKey,
  value,
  onChange,
  onSelect,
  placeholder,
  bias,
  disabled,
}: {
  apiKey: string;
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
}) {
  const listId = useId();
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [unavailable, setUnavailable] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<any>(null);
  // Set just before we write a chosen address back into the field, so the
  // effect below doesn't immediately look that address up again.
  const skipNextLookupRef = useRef(false);

  // Object identity would change every render, so depend on the numbers.
  const biasLat = bias?.lat;
  const biasLng = bias?.lng;

  useEffect(() => {
    if (unavailable) return;
    if (skipNextLookupRef.current) {
      skipNextLookupRef.current = false;
      return;
    }

    const query = value.trim();
    if (query.length < MIN_CHARS) {
      setSuggestions([]);
      setOpen(false);
      // Cleared the box without picking anything — that search is abandoned,
      // so the next one starts its own session.
      sessionRef.current = null;
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const places = await loadGooglePlaces(apiKey);
          if (cancelled) return;

          // One session token spans the typing that leads to a single pick —
          // that's how Google bills autocomplete as one lookup, not one per
          // keystroke.
          if (!sessionRef.current) {
            sessionRef.current = new places.AutocompleteSessionToken();
          }

          const request: Record<string, unknown> = {
            input: query,
            sessionToken: sessionRef.current,
          };
          if (biasLat !== undefined && biasLng !== undefined) {
            request.locationBias = {
              center: { lat: biasLat, lng: biasLng },
              radius: BIAS_RADIUS_M,
            };
          }

          const result =
            await places.AutocompleteSuggestion.fetchAutocompleteSuggestions(
              request,
            );
          if (cancelled) return;

          const next: Suggestion[] = (result?.suggestions ?? [])
            .map((s: any) => s.placePrediction)
            .filter(Boolean)
            .slice(0, MAX_SUGGESTIONS)
            .map((p: any) => ({
              id: String(p.placeId ?? p.text?.toString() ?? ""),
              primary: p.mainText?.toString() ?? p.text?.toString() ?? "",
              secondary: p.secondaryText?.toString() ?? "",
              full: p.text?.toString() ?? "",
              toPlace:
                typeof p.toPlace === "function" ? () => p.toPlace() : undefined,
            }))
            .filter((s: Suggestion) => s.full.length > 0);

          setSuggestions(next);
          setActiveIndex(-1);
          setOpen(next.length > 0);
        } catch {
          // Most likely the key has no Places access. Stop asking for the rest
          // of the page load and let the plain text box do its job.
          if (cancelled) return;
          setUnavailable(true);
          setSuggestions([]);
          setOpen(false);
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [value, apiKey, biasLat, biasLng, unavailable]);

  // Clicking anywhere else closes the list.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const choose = (suggestion: Suggestion) => {
    skipNextLookupRef.current = true;
    onChange(suggestion.full);
    setSuggestions([]);
    setOpen(false);
    setActiveIndex(-1);

    // Ask Google for the canonical address of the place that was picked. Two
    // reasons: it's tidier than the prediction text, and it's the request that
    // *closes* the autocomplete session — without it Google bills every
    // keystroke's lookup separately instead of the session as one.
    const place = suggestion.toPlace?.();
    sessionRef.current = null;
    if (!place) {
      onSelect?.(suggestion.full);
      return;
    }

    void (async () => {
      let chosen = suggestion.full;
      try {
        await place.fetchFields({ fields: ["formattedAddress"] });
        const formatted = place.formattedAddress;
        if (typeof formatted === "string" && formatted.length > 0) {
          chosen = formatted;
          skipNextLookupRef.current = true;
          onChange(formatted);
        }
      } catch {
        // The prediction text is already in the box and geocodes fine.
      }
      // Announced after the tidy-up so the caller acts on the best address we
      // have, not the abbreviated prediction text.
      onSelect?.(chosen);
    })();
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
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          if (suggestions.length > 0) setOpen(true);
        }}
        placeholder={placeholder}
        disabled={disabled}
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
          Address suggestions are off. Enable the{" "}
          <strong>Places API (New)</strong> on your Google Maps key to turn them
          on — typing the full address still works.
        </p>
      )}
    </div>
  );
}
