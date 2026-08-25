"use client"

/**
 * The browser chrome shared by all three preview surfaces: the embedded pane,
 * the remote-Chromium canvas, and the web iframe fallback.
 *
 * It exists because the remote preview had grown its own flat row of ten
 * controls with no responsive behaviour at all, while the embedded pane
 * measured its width and packed into three tiers with a "⋯" overflow. The
 * pane's narrowest host is the chat rail at 24% of the window, so the flat row
 * simply overflowed there. Copying the tier constants across would be how the
 * two diverged in the first place; this is the one implementation.
 *
 * `modal` on the overflow popover is load-bearing, not a style choice: the
 * native webview is always-on-top and cannot be clipped, so a non-modal popover
 * opens *behind* the page. Modal makes Radix mark the rest of the app
 * `aria-hidden`, which is exactly what `useRegionVisibility` watches in order to
 * park the webview off-screen.
 */

import { type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react"
import { GlobeIcon, LockIcon, MoreHorizontalIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useElementWidth } from "@/hooks/use-element-width"
import { cn } from "@/lib/utils"

/**
 * Measured toolbar widths at which the secondary controls stop being inline and
 * pack into the "⋯" popover instead. The pane is docked in the chat right rail
 * as often as it fills the `/browser` page, and that rail's floor is 24% of the
 * window (~300px on a laptop) — well under the ~620px the full control row
 * needs. Wrapping instead of packing cost four toolbar rows and pushed the
 * address bar onto a line of its own.
 */
export const COMPACT_TOOLBAR_PX = 460
export const WIDE_TOOLBAR_PX = 680

export type BrowserToolbarTier = "compact" | "medium" | "wide"

/**
 * How the toolbar packs itself. Width 0 means "not measured yet" (SSR, first
 * paint, jsdom) — take the widest branch, matching the `/browser` page.
 */
export function toolbarTier(width: number): BrowserToolbarTier {
  if (width === 0 || width >= WIDE_TOOLBAR_PX) return "wide"
  return width >= COMPACT_TOOLBAR_PX ? "medium" : "compact"
}

/**
 * The address bar's read-mode form: scheme (carried by the lock / globe icon),
 * a leading `www.` and a bare trailing slash are dropped, so what survives
 * end-truncation in a narrow rail is the host — not `https://www.exam…`. The
 * host and the rest are returned separately so the path can be dimmed.
 *
 * Returns `null` for anything that isn't a parseable http(s) address; a
 * half-typed draft is always shown verbatim.
 */
export function addressDisplayParts(
  url: string
): { host: string; rest: string; secure: boolean } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
  const rest = `${parsed.pathname}${parsed.search}${parsed.hash}`
  return {
    host: parsed.host.replace(/^www\./, ""),
    rest: rest === "/" ? "" : rest,
    secure: parsed.protocol === "https:",
  }
}

export interface BrowserToolbarProps {
  /** Measured to choose the tier; the caller owns the ref so it can re-measure. */
  toolbarRef: RefObject<HTMLDivElement | null>
  /** Back / forward / reload — supplied whole so each surface keeps its driver. */
  navigation: ReactNode
  /** Reached on every pass: last to collapse. */
  inspectActions?: ReactNode
  /** Set once and left alone: first to collapse. */
  pageActions?: ReactNode
  /** Always in the popover, at every width (output settings, not chrome). */
  overflowExtras?: ReactNode
  /** Never collapses — a live status badge or a control-handover button. */
  trailing?: ReactNode
  url: string
  onUrlChange: (next: string) => void
  onSubmit: (event: FormEvent) => void
  onUrlKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void
  onUrlFocus?: () => void
  onUrlBlur?: () => void
  urlInputRef?: RefObject<HTMLInputElement | null>
  /** Paint the read-mode address over the field. Callers suppress it mid-edit. */
  addressDisplay?: { host: string; rest: string; secure: boolean } | null
  /** Draw the indeterminate progress bar along the bottom edge. */
  loading?: boolean
  /**
   * Mark the "⋯" trigger when a collapsed control is in a non-default state, so
   * "select mode is armed" / "zoom isn't 100%" can't hide inside the popover.
   */
  collapsedActive?: boolean
  /** Reported on every tier change so a caller can re-measure a native webview. */
  onTierChange?: (tier: BrowserToolbarTier) => void
}

export function BrowserToolbar({
  toolbarRef,
  navigation,
  inspectActions,
  pageActions,
  overflowExtras,
  trailing,
  url,
  onUrlChange,
  onSubmit,
  onUrlKeyDown,
  onUrlFocus,
  onUrlBlur,
  urlInputRef,
  addressDisplay = null,
  loading = false,
  collapsedActive = false,
}: BrowserToolbarProps) {
  const t = useTranslations("browser")
  const tier = toolbarTier(useElementWidth(toolbarRef))
  const SchemeIcon = addressDisplay?.secure ? LockIcon : GlobeIcon
  // Each tier renders the identical control roster, only in a different
  // container, so nothing mounts twice and no action becomes unreachable.
  const hasOverflow = !!overflowExtras || !!inspectActions || !!pageActions

  return (
    <div
      ref={toolbarRef}
      className="relative flex items-center gap-1.5 border-b px-2 py-1.5"
      data-testid="browser-toolbar"
      data-tier={tier}
    >
      {loading && (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden"
          role="progressbar"
          aria-label={t("loading.label")}
          data-testid="browser-progress"
        >
          <div className="browser-progress-bar h-full w-1/3 rounded-full bg-primary" />
        </div>
      )}
      {navigation}
      <form onSubmit={onSubmit} className="min-w-0 flex-1">
        <div className="relative">
          <SchemeIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={urlInputRef}
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={url}
            onChange={(event) => onUrlChange(event.target.value)}
            onFocus={(event) => {
              onUrlFocus?.()
              event.target.select()
            }}
            onBlur={onUrlBlur}
            onKeyDown={onUrlKeyDown}
            placeholder={t("url.placeholder")}
            aria-label={t("url.placeholder")}
            className={cn(
              "h-8 rounded-full border-transparent bg-muted/60 pl-8 text-sm shadow-none focus-visible:border-input focus-visible:bg-background",
              // Read mode paints the pretty form over the field instead of
              // rewriting `value`, so copying still yields the real URL and
              // focusing reveals it without a reformat flicker.
              addressDisplay && "text-transparent"
            )}
          />
          {addressDisplay && (
            <div
              aria-hidden
              data-testid="browser-url-display"
              // Same border + padding as the Input so the content boxes line up
              // to the pixel and focusing doesn't nudge the text sideways.
              className="pointer-events-none absolute inset-0 flex items-center border border-transparent pl-8 pr-3"
            >
              <span className="min-w-0 truncate text-sm">
                {addressDisplay.host}
                {addressDisplay.rest && (
                  <span className="text-muted-foreground">{addressDisplay.rest}</span>
                )}
              </span>
            </div>
          )}
        </div>
      </form>
      {tier !== "compact" && inspectActions && (
        <div className="flex shrink-0 items-center">{inspectActions}</div>
      )}
      {tier === "wide" && pageActions && (
        <div className="flex shrink-0 items-center">{pageActions}</div>
      )}
      {trailing}
      {hasOverflow && (
        <Popover modal>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("actions.more")}
              data-testid="browser-toolbar-more"
              className="relative shrink-0"
            >
              <MoreHorizontalIcon />
              {collapsedActive && (
                <span
                  aria-hidden
                  data-testid="browser-toolbar-more-active"
                  className="absolute right-1 top-1 size-1.5 rounded-full bg-primary"
                />
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56 p-2">
            <div className="flex flex-col gap-2">
              {tier === "compact" && inspectActions && (
                <div className="flex flex-wrap items-center gap-0.5">{inspectActions}</div>
              )}
              {tier !== "wide" && pageActions && (
                <div className="flex flex-wrap items-center gap-0.5">{pageActions}</div>
              )}
              {overflowExtras}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}
