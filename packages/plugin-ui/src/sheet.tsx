import * as React from "react"
import { XIcon } from "lucide-react"
import { Dialog as SheetPrimitive } from "radix-ui"

import { cn } from "./cn"
import { useShouldReduceMotion } from "./motion-tokens"

/**
 * Edge-anchored overlay panel.
 *
 * This exists in the kit because a plugin cannot build one itself: `react-dom`
 * is withheld from the host's shared-module whitelist
 * (`lib/plugin/core/shared-modules.ts`), so there is no `createPortal` and a
 * plugin's tree cannot escape the slot it was mounted into — nor its `@scope`d
 * stylesheet. Radix's own portal is the sanctioned escape hatch: the host owns
 * the portal container and the layering, the plugin only declares content.
 *
 * Built on Radix's Dialog primitive (a sheet is a dialog with an edge anchor),
 * which brings the focus trap, scroll lock, Escape/outside-click dismissal and
 * `aria-modal` semantics for free.
 */
function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />
}

function SheetTrigger({ ...props }: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose({ ...props }: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetPortal({ ...props }: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

/**
 * Enter ~250 ms decelerating, exit ~200 ms accelerating: an overlay should
 * arrive quickly and leave faster, and anything slower reads as lag on a
 * phone. Each duration is scaled by `--motion-duration-scale`, which the HOST
 * publishes on `:root` from the user's motion-speed preference — reading it
 * (rather than hard-coding the number) keeps a plugin's sheet at the same
 * speed as the host's own surfaces without the plugin knowing the setting
 * exists. `ease-*` sets `--tw-ease`, which the `animate-in` / `animate-out`
 * keyframes read for their timing function.
 */
const SHEET_TIMING =
  "data-[state=open]:ease-out data-[state=open]:[animation-duration:calc(250ms*var(--motion-duration-scale,1))] data-[state=closed]:ease-in data-[state=closed]:[animation-duration:calc(200ms*var(--motion-duration-scale,1))]"

type SheetSide = "top" | "right" | "bottom" | "left"

/** Where each side anchors and how large it is. Motion-independent. */
const SHEET_SIDE_LAYOUT: Record<SheetSide, string> = {
  right: "inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-sm",
  left: "inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm",
  top: "inset-x-0 top-0 h-auto border-b",
  // pb: bottom sheets sit flush against the screen edge — reserve the
  // home-indicator inset so footers/action rows stay tappable on notched
  // devices (0px on desktop). Arbitrary pb-* (not a named utility) so a
  // caller's own pb-* still wins via tailwind-merge.
  bottom: "inset-x-0 bottom-0 h-auto border-t pb-[env(safe-area-inset-bottom)]",
}

/** The edge slide each side plays when motion is allowed. */
const SHEET_SIDE_SLIDE: Record<SheetSide, string> = {
  right: "data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right",
  left: "data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left",
  top: "data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
  bottom: "data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
}

/**
 * Reduced motion swaps the slide for an opacity-only fade: a panel travelling
 * across the whole viewport is exactly the large-displacement motion the
 * preference exists to remove, while a fade still tells the user something
 * appeared. Keeping *an* animation (rather than none) also keeps Radix's
 * presence logic on one code path — it waits for `animationend` either way.
 */
const SHEET_REDUCED_ENTER_EXIT = "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 data-[state=closed]:pointer-events-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        // Same timing as the panel, so the scrim and the sheet land together.
        SHEET_TIMING,
        className
      )}
      {...props}
    />
  )
}

function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  // The host's copy hard-codes "Close" in the sr-only span. A plugin surface
  // has no access to the app's next-intl catalog, so the only way this label
  // can follow the user's locale is for the plugin to pass its own translated
  // string. Default kept so the button is never unlabeled by omission.
  closeLabel = "Close",
  forceMount,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: SheetSide
  showCloseButton?: boolean
  closeLabel?: string
}) {
  // The app's reduce toggle (class or `data-reduce-motion`) and the OS hint
  // (unless `data-motion-respect="off"`) — the same markers the host CSS
  // guard reads, re-evaluated live when the user flips the setting.
  const reduceMotion = useShouldReduceMotion()
  return (
    <SheetPortal forceMount={forceMount}>
      <SheetOverlay forceMount={forceMount} />
      <SheetPrimitive.Content
        forceMount={forceMount}
        data-slot="sheet-content"
        className={cn(
          "fixed z-50 flex flex-col gap-4 bg-background shadow-lg data-[state=closed]:animate-out data-[state=open]:animate-in",
          SHEET_TIMING,
          SHEET_SIDE_LAYOUT[side],
          reduceMotion ? SHEET_REDUCED_ENTER_EXIT : SHEET_SIDE_SLIDE[side],
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close-button"
            // 28px painted, 36px on a coarse pointer: the bare 16px icon was a
            // miss on a phone. `focus-visible`, not `focus`, so a tap does not
            // leave a ring behind.
            className="absolute top-3 right-3 inline-flex size-7 items-center justify-center rounded-xs opacity-70 ring-offset-background transition-opacity pointer-coarse:size-9 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-hidden disabled:pointer-events-none data-[state=open]:bg-secondary"
          >
            <XIcon className="size-4" aria-hidden="true" />
            <span className="sr-only">{closeLabel}</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-1.5 p-4", className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  )
}

/**
 * Radix derives the dialog's accessible name from Title and its description
 * from Description — omitting Title leaves the overlay unnamed to a screen
 * reader, so both are exported rather than folded into SheetHeader.
 */
function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("font-semibold text-foreground", className)}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

// SheetOverlay / SheetPortal stay internal, exactly as in the host: SheetContent
// already renders both, and every extra export is another shape of the plugin
// contract we'd owe compatibility to.
export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
}
