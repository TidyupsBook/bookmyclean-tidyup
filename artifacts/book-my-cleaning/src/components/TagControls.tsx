import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The owner's quick verdict on a lead or a call: one tap after the
 * conversation to remember who was real and who was a scammer. One tag at a
 * time on purpose — this is fast triage, not a labeling system. Tapping the
 * active tag again clears it.
 */
export type QuickTag = "client" | "good_lead" | "bad_lead" | "spam";

export const QUICK_TAGS: {
  value: QuickTag;
  label: string;
  chip: string;
}[] = [
  {
    value: "client",
    label: "Client",
    chip: "bg-green-500/10 text-green-400 border-green-500/20 hover:bg-green-500/10",
  },
  {
    value: "good_lead",
    label: "Good lead",
    chip: "bg-sky-500/10 text-sky-400 border-sky-500/20 hover:bg-sky-500/10",
  },
  {
    value: "bad_lead",
    label: "Bad lead",
    chip: "bg-amber-500/10 text-amber-400 border-amber-500/20 hover:bg-amber-500/10",
  },
  {
    value: "spam",
    label: "Spam",
    chip: "bg-red-500/10 text-red-400 border-red-500/20 hover:bg-red-500/10",
  },
];

/** The compact colored badge shown wherever the row is scanned. */
export function TagChip({
  tag,
  testid,
}: {
  tag: string | null | undefined;
  testid?: string;
}) {
  const def = QUICK_TAGS.find((t) => t.value === tag);
  if (!def) return null;
  return (
    <Badge className={def.chip} data-testid={testid}>
      {def.label}
    </Badge>
  );
}

/** The row of tap-to-set tag buttons. Tapping the active one clears it. */
export function TagPicker({
  value,
  disabled,
  onSelect,
  testidPrefix,
}: {
  value: string | null | undefined;
  disabled?: boolean;
  onSelect: (tag: QuickTag | null) => void;
  testidPrefix: string;
}) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-xs text-muted-foreground">Tag:</span>
      {QUICK_TAGS.map((t) => {
        const active = value === t.value;
        return (
          <button
            key={t.value}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => onSelect(active ? null : t.value)}
            data-testid={`${testidPrefix}-${t.value}`}
            className={cn(
              "px-2.5 py-1 rounded-full text-xs font-medium border transition-colors disabled:opacity-50",
              active
                ? cn(t.chip, "border-current/30")
                : "border-border text-muted-foreground hover:text-foreground hover:bg-secondary",
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
