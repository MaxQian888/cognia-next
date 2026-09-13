"use client"

/**
 * Lays out the provider rail and the detail column for whichever shape the
 * pane is in: two live columns when it is wide enough to split, or a
 * list → detail push when it is stacked.
 *
 * The rail is rendered in exactly ONE place at a time, chosen from
 * `useSettingsListDensity()` rather than from two CSS-hidden copies. A hidden
 * copy still exists in the DOM with its ids, and the rail's rows carry
 * `id="provider-<id>"`, which the onboarding banner scrolls to with
 * `getElementById`. Two copies means the banner can scroll to the invisible
 * one and appear to do nothing.
 *
 * Stacked used to be a drawer over an always-mounted detail. On a phone that
 * meant the list was a modal you had to dismiss to see anything, and the
 * detail behind it was the *previous* provider until the drawer closed. Now
 * the list is the page, a row pushes the detail in, and a back button on the
 * detail's top bar returns to the list. Nothing is lost on the way back: the
 * detail is simply unmounted and remounts on the next pick.
 */

import { ArrowLeft, Plus } from "lucide-react"
import { useTranslations } from "next-intl"
import type { ReactNode } from "react"

import { useSettingsListDensity } from "@/components/settings/common/settings-master-detail"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** Rail width bounds (px). The default matches the previous fixed column. */
export const RAIL_MIN_WIDTH = 240
export const RAIL_MAX_WIDTH = 480
export const RAIL_DEFAULT_WIDTH = 320

/** Which of the two stacked pages is showing. Ignored on a split pane. */
export type ProviderStackedView = "list" | "detail"

export interface ProviderRailHostProps {
  rail: ReactNode
  /** The detail column (or the compare / routing workspace standing in for it). */
  detail: ReactNode
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
  /** Title on the stacked detail bar. */
  selectedName?: string
  stackedView: ProviderStackedView
  onShowList: () => void
  onAdd: () => void
}

export function ProviderRailHost({
  rail,
  detail,
  railWidth,
  railResize,
  selectedName,
  stackedView,
  onShowList,
  onAdd,
}: ProviderRailHostProps) {
  const t = useTranslations("providers")
  const density = useSettingsListDensity()

  if (density === "split") {
    return (
      <>
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
        {detail}
      </>
    )
  }

  if (stackedView === "list") {
    // The list is the whole pane. `row-span-2` because the frame reserves a
    // bar row above the detail row; with no bar, the rail takes both.
    return (
      <div
        className="row-span-2 flex min-h-0 flex-col overflow-hidden rounded-lg border"
        data-testid="provider-rail"
        data-stacked-view="list"
      >
        {rail}
      </div>
    )
  }

  return (
    <>
      <div
        className="flex items-center gap-2"
        data-testid="provider-rail-bar"
        data-stacked-view="detail"
      >
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 gap-1.5 pl-1"
          onClick={onShowList}
          data-testid="provider-rail-back"
        >
          <ArrowLeft className="h-4 w-4" />
          {t("mobile.openProviders")}
        </Button>
        {selectedName ? (
          <p
            className="min-w-0 flex-1 truncate text-sm font-medium"
            data-testid="provider-rail-title"
          >
            {selectedName}
          </p>
        ) : null}
        {/* Adding is on the bar itself: going back to the list first to add
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
      {detail}
    </>
  )
}
