import * as React from "react"
import { Avatar as AvatarPrimitive } from "radix-ui"

import { cn } from "./cn"

/**
 * Identity chip.
 *
 * Built on Radix rather than a bare `<img>` because the interesting part is the
 * load state machine: `AvatarImage` only reveals itself once the network fetch
 * resolves, so the fallback never flashes behind a cached image and never
 * disappears behind a broken URL. A plugin rendering avatars from arbitrary
 * remote sources (a connector's contact list, a git author) gets that for free.
 *
 * `size` is a data attribute rather than a prop threaded through every part:
 * the fallback, the badge and the group count all size themselves off the
 * `group/avatar` container, so a caller sets one prop and the whole cluster
 * scales together.
 */
function Avatar({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Root> & {
  size?: "default" | "sm" | "lg"
}) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      data-size={size}
      className={cn(
        "group/avatar relative flex size-8 shrink-0 overflow-hidden rounded-full select-none data-[size=lg]:size-10 data-[size=sm]:size-6",
        className
      )}
      {...props}
    />
  )
}

function AvatarImage({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn("aspect-square size-full", className)}
      {...props}
    />
  )
}

/**
 * Rendered until (and unless) the image loads. Its content is the caller's —
 * initials, an icon, whatever the plugin can compute without a network round
 * trip — because the kit has no way to derive a label from a locale it cannot
 * read.
 */
function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        "flex size-full items-center justify-center rounded-full bg-muted text-sm text-muted-foreground group-data-[size=sm]/avatar:text-xs",
        className
      )}
      {...props}
    />
  )
}

/**
 * Status dot / mini-icon pinned to the avatar's corner. Purely decorative by
 * default: at `sm` the slot is too small to render a glyph legibly, so any
 * `<svg>` inside is hidden rather than squashed — meaning a caller that encodes
 * meaning here must also convey it in text.
 */
function AvatarBadge({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="avatar-badge"
      className={cn(
        "absolute right-0 bottom-0 z-10 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground ring-2 ring-background select-none",
        "group-data-[size=sm]/avatar:size-2 group-data-[size=sm]/avatar:[&>svg]:hidden",
        "group-data-[size=default]/avatar:size-2.5 group-data-[size=default]/avatar:[&>svg]:size-2",
        "group-data-[size=lg]/avatar:size-3 group-data-[size=lg]/avatar:[&>svg]:size-2",
        className
      )}
      {...props}
    />
  )
}

function AvatarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group"
      className={cn(
        "group/avatar-group flex -space-x-2 *:data-[slot=avatar]:ring-2 *:data-[slot=avatar]:ring-background",
        className
      )}
      {...props}
    />
  )
}

/**
 * The "+3" tail of an `AvatarGroup`. It sizes off `group-has-data-[size=…]`,
 * i.e. off whatever the sibling avatars declared, so the overflow chip cannot
 * drift out of alignment when a caller changes the group's avatar size.
 */
function AvatarGroupCount({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group-count"
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm text-muted-foreground ring-2 ring-background group-has-data-[size=lg]/avatar-group:size-10 group-has-data-[size=sm]/avatar-group:size-6 [&>svg]:size-4 group-has-data-[size=lg]/avatar-group:[&>svg]:size-5 group-has-data-[size=sm]/avatar-group:[&>svg]:size-3",
        className
      )}
      {...props}
    />
  )
}

export { Avatar, AvatarImage, AvatarFallback, AvatarBadge, AvatarGroup, AvatarGroupCount }
