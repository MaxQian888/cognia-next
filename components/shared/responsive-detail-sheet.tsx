"use client"

/**
 * Responsive detail surface shared by the goal and loop detail sheets:
 * a right-side Sheet on desktop, a bottom Drawer on small screens — the
 * Sheet/Drawer switch lives HERE so feature sheets don't each re-implement
 * it. Header carries a title, an optional description line, and an optional
 * extra row (e.g. plugin contribution slots); `children` render identically
 * in both shells.
 */

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { useIsMobile } from "@/hooks/ui/use-mobile"
import { cn } from "@/lib/utils"

interface Props {
  open: boolean
  onOpenChange: (next: boolean) => void
  title: string
  /** Single-line summary under the title (clamped to 3 lines). */
  description?: string
  /** Extra header row — plugin slots, quick actions. */
  headerExtra?: React.ReactNode
  /**
   * Keep the title and description for assistive tech only. For a body that
   * draws its own header (the goal detail panel), where the visible sheet
   * header would print the same facts twice.
   */
  headerVisuallyHidden?: boolean
  /** Extra classes for the sheet / drawer content (width, padding). */
  contentClassName?: string
  /**
   * The sheet's own corner close button. Off for a body with a close button
   * of its own in its header row, which the corner one would sit on top of.
   */
  showCloseButton?: boolean
  children: React.ReactNode
}

export function ResponsiveDetailSheet({
  open,
  onOpenChange,
  title,
  description,
  headerExtra,
  headerVisuallyHidden = false,
  contentClassName,
  showCloseButton = true,
  children,
}: Props) {
  const isMobile = useIsMobile()
  const headerClassName = headerVisuallyHidden ? "sr-only" : undefined

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent
          className={cn("max-h-[85vh]", contentClassName)}
          data-testid="responsive-detail-drawer"
        >
          <DrawerHeader className={headerClassName}>
            <DrawerTitle>{title}</DrawerTitle>
            {description ? (
              <DrawerDescription className="line-clamp-3 text-xs">{description}</DrawerDescription>
            ) : null}
            {headerExtra}
          </DrawerHeader>
          {children}
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={showCloseButton}
        className={cn("w-full max-w-md sm:max-w-lg", contentClassName)}
        data-testid="responsive-detail-sheet"
      >
        <SheetHeader className={headerClassName}>
          <SheetTitle>{title}</SheetTitle>
          {description ? (
            <SheetDescription className="line-clamp-3 text-xs">{description}</SheetDescription>
          ) : null}
          {headerExtra}
        </SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  )
}

ResponsiveDetailSheet.displayName = "ResponsiveDetailSheet"
