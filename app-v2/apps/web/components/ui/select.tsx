import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A native `<select>`, styled to match `Input`. Deliberately not a Radix
 * popover: every select in this app is a short, flat list of enum values,
 * and the native control gets keyboard handling, mobile pickers and
 * accessibility for free.
 */
function Select({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 py-1 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Select };
