import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * No `py-*` here on purpose. This control is single-line and always carries an
 * explicit height, and a native input centres its value inside the *content*
 * box and clips what will not fit. Vertical padding therefore changes nothing
 * visually and only narrows the room the text has: at `h-7` the old `py-1`
 * left an 18px content box for a 20px line box, so descenders were shaved.
 *
 * The one layout that DID read the base padding is `InputGroup`'s block-start
 * / block-end alignment, where the group goes `h-auto` and stacks the addon
 * above or below the control: its own variant supplies the outer edge
 * (`pb-3` / `pt-3`) and the inner edge came from `py-1` here. That edge now
 * lives on the variant beside the one it was always paired with, so this base
 * stays padding-free. Any other call site that wants padding sets `py-*`
 * itself and tailwind-merge lets it win.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-0 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
