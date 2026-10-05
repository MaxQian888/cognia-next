"use client"

/**
 * Responsive shell for a form: a centred Dialog on desktop, a bottom Drawer on
 * a phone (`useIsMobile`: under 768px, or any native Capacitor shell).
 *
 * The sibling of `ResponsiveDetailSheet`, for surfaces that collect input
 * instead of showing a record. Three things a long form needs on a phone that
 * a plain Dialog does not give it:
 *
 *  - **Height in `dvh`, not `vh`.** When the on-screen keyboard opens, `vh`
 *    still measures the layout viewport, so a `max-h-[85vh]` dialog keeps its
 *    full height and the focused field ends up under the keyboard. `dvh`
 *    shrinks with the visible viewport.
 *  - **One scroll region.** The header and the footer stay put and only the
 *    body scrolls, so the Save button is never scrolled out of reach.
 *  - **A sticky footer** on the drawer, padded for the home indicator.
 *
 * Both shells render the same `children` and `footer`. Switching shell (a
 * window resized across the breakpoint) remounts them, so any state a caller
 * cannot afford to lose belongs ABOVE this component — the editors that use it
 * keep their form state in the component that renders it, not in its body.
 */

import type { ReactNode } from "react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { useIsMobile } from "@/hooks/ui/use-mobile"
import { cn } from "@/lib/utils"

export interface ResponsiveFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  /** The form body. Rendered inside the shell's only scroll region. */
  children: ReactNode
  /** Actions (Cancel / Save). Pinned below the scroll region in both shells. */
  footer?: ReactNode
  /** Extra classes for the Dialog / Drawer content box (e.g. a desktop width). */
  contentClassName?: string
  /** Extra classes for the scrollable body. */
  bodyClassName?: string
  /**
   * `data-testid` of the content box. The shell is suffixed so a test can
   * tell which one rendered: `<testid>-dialog` or `<testid>-drawer`.
   */
  testid?: string
}

export function ResponsiveFormDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  contentClassName,
  bodyClassName,
  testid = "responsive-form",
}: ResponsiveFormDialogProps) {
  const isMobile = useIsMobile()

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent
          // The direction-qualified variants are what DrawerContent sets, so
          // the overrides must use the same variant to replace them.
          className={cn(
            "data-[vaul-drawer-direction=bottom]:mt-0 data-[vaul-drawer-direction=bottom]:max-h-[calc(100dvh-env(safe-area-inset-top)-0.5rem)]",
            contentClassName
          )}
          data-testid={`${testid}-drawer`}
        >
          <DrawerHeader className="shrink-0 text-left">
            <DrawerTitle>{title}</DrawerTitle>
            {description ? <DrawerDescription>{description}</DrawerDescription> : null}
          </DrawerHeader>
          <div
            className={cn(
              "grid min-h-0 flex-1 content-start gap-3 overflow-y-auto overscroll-contain px-4 pb-3",
              bodyClassName
            )}
            data-testid={`${testid}-body`}
          >
            {children}
          </div>
          {footer ? (
            <DrawerFooter
              className="sticky bottom-0 mt-0 shrink-0 border-t bg-background pb-[calc(1rem+env(safe-area-inset-bottom))] [&_button]:min-h-11"
              data-testid={`${testid}-footer`}
            >
              {footer}
            </DrawerFooter>
          ) : null}
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn("flex max-h-[85dvh] flex-col sm:max-w-[560px]", contentClassName)}
        data-testid={`${testid}-dialog`}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div
          className={cn(
            "-mx-1 grid min-h-0 flex-1 content-start gap-3 overflow-y-auto px-1 py-3",
            bodyClassName
          )}
          data-testid={`${testid}-body`}
        >
          {children}
        </div>
        {footer ? (
          <DialogFooter className="shrink-0" data-testid={`${testid}-footer`}>
            {footer}
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

ResponsiveFormDialog.displayName = "ResponsiveFormDialog"
