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

interface Props {
  open: boolean
  onOpenChange: (next: boolean) => void
  title: string
  /** Single-line summary under the title (clamped to 3 lines). */
  description?: string
  /** Extra header row — plugin slots, quick actions. */
  headerExtra?: React.ReactNode
  children: React.ReactNode
}

export function ResponsiveDetailSheet({
  open,
  onOpenChange,
  title,
  description,
  headerExtra,
  children,
}: Props) {
  const isMobile = useIsMobile()

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="max-h-[85vh]" data-testid="responsive-detail-drawer">
          <DrawerHeader>
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
        className="w-full max-w-md sm:max-w-lg"
        data-testid="responsive-detail-sheet"
      >
        <SheetHeader>
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
