import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Search, Inbox, CalendarCheck, Contact, Users } from "lucide-react";
import {
  getSearchDirectoryQueryKey,
  useSearchDirectory,
  type SearchMatch,
} from "@workspace/api-client-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

/**
 * One search box over everyone the company knows: leads, bookings, clients
 * and staff — "does this person already exist?" answered from anywhere.
 *
 * Matching happens on the SERVER (name or phone, any format), so cmdk's own
 * client-side filter is disabled — every item the API returned is shown.
 */

const KIND_META: Record<
  SearchMatch["kind"],
  { label: string; href: string; icon: typeof Inbox }
> = {
  lead: { label: "Leads", href: "/leads", icon: Inbox },
  booking: { label: "Bookings", href: "/bookings", icon: CalendarCheck },
  client: { label: "Clients", href: "/clients", icon: Contact },
  team: { label: "Staff", href: "/team", icon: Users },
};

const KIND_ORDER: SearchMatch["kind"][] = ["client", "lead", "booking", "team"];

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [, navigate] = useLocation();

  // Cmd+K / Ctrl+K from anywhere in the app.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const enabled = open && debounced.length >= 2;
  const { data, isFetching } = useSearchDirectory(
    { q: debounced },
    {
      query: {
        enabled,
        // No placeholderData on purpose: with cmdk's own filter disabled,
        // carrying the previous query's results forward would let the user
        // click a stale match for a different search term.
        queryKey: getSearchDirectoryQueryKey({ q: debounced }),
      },
    },
  );

  const groups = useMemo(() => {
    const results = enabled ? (data?.results ?? []) : [];
    return KIND_ORDER.map((kind) => ({
      kind,
      items: results.filter((r) => r.kind === kind),
    })).filter((g) => g.items.length > 0);
  }, [data, enabled]);

  const pick = (match: SearchMatch) => {
    setOpen(false);
    setQuery("");
    navigate(KIND_META[match.kind].href);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="button-global-search"
        className="flex items-center gap-3 px-3 py-2 rounded-lg transition-colors cursor-pointer text-sm font-medium text-muted-foreground hover:bg-white/5 hover:text-white w-full"
      >
        <Search className="w-4 h-4" />
        <span className="flex-1 text-left">Search</span>
        <kbd className="hidden lg:inline-flex text-[10px] font-mono border border-white/10 rounded px-1.5 py-0.5 text-muted-foreground">
          ⌘K
        </kbd>
      </button>
      {/* Server-side matching — never let cmdk re-filter what came back. */}
      <CommandDialog open={open} onOpenChange={setOpen} shouldFilter={false}>
        <CommandInput
          placeholder="Search by name or phone number…"
          value={query}
          onValueChange={setQuery}
          data-testid="input-global-search"
        />
        <CommandList>
          {debounced.length < 2 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              Type a name or phone number to search leads, bookings, clients and
              staff.
            </div>
          ) : groups.length === 0 ? (
            <CommandEmpty>
              {isFetching ? "Searching…" : "No one found. They may be new."}
            </CommandEmpty>
          ) : (
            groups.map((group) => {
              const meta = KIND_META[group.kind];
              const Icon = meta.icon;
              return (
                <CommandGroup key={group.kind} heading={meta.label}>
                  {group.items.map((item) => {
                    const date = formatDate(item.date);
                    return (
                      <CommandItem
                        key={`${item.kind}-${item.id}`}
                        value={`${item.kind}-${item.id}`}
                        onSelect={() => pick(item)}
                        data-testid={`search-result-${item.kind}-${item.id}`}
                      >
                        <Icon className="mr-2 shrink-0 opacity-60" />
                        <div className="flex flex-col min-w-0">
                          <span className="truncate">
                            {item.name}
                            {item.phone ? (
                              <span className="text-muted-foreground">
                                {" "}
                                · {item.phone}
                              </span>
                            ) : null}
                          </span>
                          {(item.detail || date || item.status) && (
                            <span className="text-xs text-muted-foreground truncate">
                              {[item.detail, date, item.status]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          )}
                        </div>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              );
            })
          )}
        </CommandList>
      </CommandDialog>
    </>
  );
}
