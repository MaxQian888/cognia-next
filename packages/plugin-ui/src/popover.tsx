/**
 * Anchored popover — free-form layered content, as opposed to `DropdownMenu`'s
 * roving-focus menu semantics.
 *
 * Same rationale as `dropdown-menu.tsx`: plugins get no `react-dom`, so no
 * `createPortal`, so no way to escape their slot. This file is the host-owned
 * escape hatch. Reach for `Popover` when the content is a form, a colour
 * picker, a details card — anything whose children are NOT a list of commands.
 * If they ARE commands, use `DropdownMenu`, which gives keyboard navigation,
 * typeahead and `role="menu"` for free.
 */
import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"

import { cn } from "./cn"

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-hidden data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

/**
 * Detaches positioning from the trigger. Useful when the visual anchor is a
 * text range or a canvas cell rather than the control the user clicked — the
 * plugin can render a zero-size `PopoverAnchor` at the right coordinates and
 * keep the trigger wherever it belongs.
 */
function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

/**
 * `Header` / `Title` / `Description` are plain elements, not Radix parts: a
 * popover is not a dialog, so it must NOT claim `aria-labelledby` wiring or a
 * heading role it does not own. They exist purely so plugin authors stop
 * hand-rolling the spacing and drifting from the host's look.
 */
function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("flex flex-col gap-1 text-sm", className)}
      {...props}
    />
  )
}

function PopoverTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="popover-title" className={cn("font-medium", className)} {...props} />
}

function PopoverDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="popover-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
}
