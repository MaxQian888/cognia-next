/**
 * Loading placeholder.
 *
 * Plugin panels are mounted eagerly by the host but almost always await their
 * own async data, so the alternative to a skeleton is an empty slot that reads
 * as "this plugin is broken". Sizing is deliberately not baked in: the caller
 * passes the box it is reserving (`className="h-4 w-32"`), because only the
 * plugin knows the shape of what is about to replace it.
 */
import * as React from "react"

import { cn } from "./cn"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      // `animate-pulse` is stock Tailwind, not one of the host's `tw-animate-css`
      // additions, so it resolves against any Tailwind build the host ships.
      className={cn("animate-pulse rounded-md bg-accent", className)}
      {...props}
    />
  )
}

export { Skeleton }
