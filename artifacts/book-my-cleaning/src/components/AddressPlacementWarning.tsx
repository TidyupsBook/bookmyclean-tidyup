import { useState } from "react";
import { AlertCircle } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * A compact, keyboard- and touch-friendly warning for an address that the
 * background geocoder has tried and could not place. The address is included
 * in the tooltip so the owner can spot a typo without opening the record.
 */
export function AddressPlacementWarning({
  address,
  testId,
}: {
  address: string;
  testId: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Address couldn't be placed on the map"
          data-testid={testId}
          onClick={(event) => {
            event.stopPropagation();
            setOpen((current) => !current);
          }}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-amber-400 hover:bg-amber-400/10 hover:text-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <AlertCircle className="h-4 w-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <span className="block font-medium">Address couldn't be placed</span>
        <span className="mt-0.5 block break-words text-primary-foreground/80">
          {address}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
