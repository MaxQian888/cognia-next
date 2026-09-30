"use client"

import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { useCannotHover } from "@/hooks/ui/use-cannot-hover"
import { cn } from "@/lib/utils"

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

/**
 * A tooltip is a hover affordance, and a device that cannot hover never gets
 * the gesture that dismisses one. Radix opens on FOCUS as well as on hover, and
 * a tap focuses the button it lands on, so on a phone every tapped toolbar
 * button raised its tooltip and kept it up for as long as the button held
 * focus: over the file picker's return, behind the popover the tap opened, and
 * after that popover handed focus back to its trigger on close.
 *
 * So an uncontrolled tooltip stays closed where the primary pointer reports it
 * cannot hover. A caller that controls `open` itself (a tap-to-explain hint)
 * has asked for the tooltip explicitly and is left alone. Everything a tooltip
 * says on these controls is also their accessible name.
 */
function Tooltip({
  open,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const cannotHover = useCannotHover()
  const controlled = open !== undefined
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false)
  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (!controlled) {
        if (next && cannotHover) return
        setUncontrolledOpen(next)
      }
      onOpenChange?.(next)
    },
    [controlled, cannotHover, onOpenChange]
  )
  return (
    <TooltipPrimitive.Root
      data-slot="tooltip"
      open={controlled ? open : uncontrolledOpen && !cannotHover}
      onOpenChange={handleOpenChange}
      {...props}
    />
  )
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-fit origin-(--radix-tooltip-content-transform-origin) animate-in rounded-md bg-foreground px-3 py-1.5 text-xs text-balance text-background fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
