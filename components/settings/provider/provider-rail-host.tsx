"use client"

/**
 * Puts the provider rail wherever the pane is wide enough to take it: a
 * resizable left column when the frame is split, or a drawer behind a top bar
 * when it is stacked.
 *
 * The rail is rendered in exactly ONE of those at a time, chosen from
 * `useSettingsListDensity()` rather than from two CSS-hidden copies. A hidden
 * copy still exists in the DOM with its ids, and the rail's rows carry
 * `id="provider-<id>"`, which the onboarding banner scrolls to with
 * `getElementById`. Two copies means the banner can scroll to the invisible
 * one and appear to do nothing.
 */

import { Menu, Plus } from "lucide-react"
import { useTranslations } from "next-intl"
import type { ReactNode } from "react"

import { useSettingsListDensity } from "@/components/settings/common/settings-master-detail"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { cn } from "@/lib/utils"

/** Rail width bounds (px). The default matches the previous fixed column. */
export const RAIL_MIN_WIDTH = 240
export const RAIL_MAX_WIDTH = 480
export const RAIL_DEFAULT_WIDTH = 320

export interface ProviderRailHostProps {
  rail: ReactNode
  /**
   * The user's stored preference, which is what the resize handle reports.
   * Distinct from the rendered track: `SettingsListDetail` clamps the column
   * to `clamp(200px, 30cqi, railWidth)`, so on a narrow pane the rail is
   * narrower than this number. `RAIL_MIN_WIDTH` floors the preference, 200px
   * floors the track, and they measure different things.
   */
  railWidth: number
  railResize: {
    dragging: boolean
    onPointerDown: (e: React.PointerEvent) => void
    onPointerMove: (e: React.PointerEvent) => void
    onPointerUp: (e: React.PointerEvent) => void
    onKeyDown: (e: React.KeyboardEvent) => void
    onDoubleClick: () => void
  }
  selectedName?: string
  sheetOpen: boolean
  onSheetOpenChange: (open: boolean) => void
  onAdd: () => void
}

export function ProviderRailHost({
  rail,
  railWidth,
  railResize,
  selectedName,
  sheetOpen,
  onSheetOpenChange,
  onAdd,
}: ProviderRailHostProps) {
  const t = useTranslations("providers")
  const density = useSettingsListDensity()

  if (density === "split") {
    return (
      <div
        className="relative flex min-h-0 flex-col overflow-hidden rounded-lg border"
        data-testid="provider-rail"
      >
        {rail}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("sidebar.resizeHandle")}
          aria-valuemin={RAIL_MIN_WIDTH}
          aria-valuemax={RAIL_MAX_WIDTH}
          aria-valuenow={Math.round(railWidth)}
          tabIndex={0}
          data-testid="provider-rail-resize-handle"
          className={cn(
            "group absolute -right-1 bottom-0 top-0 z-10 flex w-2.5 cursor-col-resize items-center justify-center focus-visible:outline-none",
            railResize.dragging && "select-none"
          )}
          onPointerDown={railResize.onPointerDown}
          onPointerMove={railResize.onPointerMove}
          onPointerUp={railResize.onPointerUp}
          onKeyDown={railResize.onKeyDown}
          onDoubleClick={railResize.onDoubleClick}
        >
          <span
            aria-hidden
            className={cn(
              "h-full w-0.5 bg-transparent transition-colors group-hover:bg-primary/50 group-focus-visible:bg-primary",
              railResize.dragging && "bg-primary"
            )}
          />
        </div>
      </div>
    )
  }

  // Stacked: a top bar over the detail, which stays mounted below it. The old
  // layout replaced the whole pane with the list, so opening the list meant
  // losing the provider you were part-way through configuring.
  return (
    <div className="flex items-center gap-2" data-testid="provider-rail-bar">
      <Sheet open={sheetOpen} onOpenChange={onSheetOpenChange}>
        <SheetTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 gap-1.5"
            data-testid="provider-rail-drawer-trigger"
          >
            <Menu className="h-4 w-4" />
            {t("mobile.openProviders")}
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-[320px] p-0">
          <SheetHeader className="px-3 pt-3">
            <SheetTitle className="text-sm">{t("mobile.openProviders")}</SheetTitle>
          </SheetHeader>
          {rail}
        </SheetContent>
      </Sheet>
      {selectedName ? (
        <p
          className="min-w-0 flex-1 truncate text-sm font-medium"
          data-testid="provider-rail-title"
        >
          {selectedName}
        </p>
      ) : null}
      {/* Adding is on the bar itself: needing to open the drawer first to add
          a provider is one tap of pure ceremony. */}
      <Button
        variant="outline"
        size="icon"
        className="ml-auto size-8 shrink-0"
        onClick={onAdd}
        aria-label={t("addProvider")}
        data-testid="provider-rail-drawer-add"
      >
        <Plus className="h-4 w-4" />
      </Button>
    </div>
  )
}
