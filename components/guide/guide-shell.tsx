"use client"

import type { ReactNode } from "react"

import { GUIDE_BODY_ENTER, GUIDE_SHELL_ENTER } from "./guide-motion"
import { cn } from "@/lib/utils"
import type { GuidePanelOverflow } from "./guide-narrative-panel"

export interface GuideShellProps {
  /** The row across the top — a `GuideWindowBar`. */
  windowBar: ReactNode
  /** The narrative half — a `GuideNarrativePanel`. */
  panel: ReactNode
  /** Must match the panel's `overflow`; see {@link GuidePanelOverflow}. */
  overflow?: GuidePanelOverflow
  /** Keys the body, so only it replays its entrance on a step change. */
  bodyKey: string
  children: ReactNode
  /** Sticky action row. Kept out of the scroll so it never scrolls away. */
  footer?: ReactNode
  /** Prefix for `${prefix}-shell`, `-step-body`, `-actions`. */
  testIdPrefix: string
  /** Extra `data-*` hooks for the flow (the pairing client, the scene state). */
  dataAttributes?: Record<`data-${string}`, string | undefined>
}

/**
 * The window a full-window guide renders into (ADR-0193).
 *
 * `/onboarding` and `/pair` are both first-contact flows that own the whole
 * window, and each built this frame by hand — the pairing copy without the
 * entrance, without the window bar and with a narrower body. This is the one
 * frame; the flows supply the bar, the panel and the step body.
 *
 * **Hoisted above the steps, and that is load-bearing.** Each step is a
 * different component type, so a shell rendered per step would be torn down on
 * every transition, remounting the "persistent" panel and replaying the whole
 * window's entrance. Here only the keyed body and the keyed scene swap.
 *
 * ```
 * ┌──────────────────────────────────────────────┐
 * │ ← Cognia                             – □ ×   │  window bar
 * ├────────────────────┬─────────────────────────┤
 * │ narrative panel    │  step body (scrolls)    │
 * │                    ├─────────────────────────┤
 * │                    │  actions (sticky)       │
 * └────────────────────┴─────────────────────────┘
 * ```
 *
 * **It owns a definite height.** Guided routes suppress the desktop chrome, so
 * this element *is* the viewport there: `h-[100dvh]`, `overflow-hidden`, an
 * opaque background (the wallpaper layer is a fixed `body::before`, and there
 * is no shell behind this to cover it). On mobile the wrapper hands it a
 * `h-[100dvh]` flex column, and `flex-1 min-h-0` wins there because
 * flex-basis governs a column child's main size — one class list serves both.
 */
export function GuideShell({
  windowBar,
  panel,
  overflow = "band",
  bodyKey,
  children,
  footer,
  testIdPrefix,
  dataAttributes,
}: GuideShellProps) {
  const band = overflow === "band"

  return (
    <div
      className={cn(
        "flex h-[100dvh] min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground safe-area-pt",
        GUIDE_SHELL_ENTER
      )}
      data-testid={`${testIdPrefix}-shell`}
      {...dataAttributes}
    >
      {windowBar}

      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col md:flex-row",
          // The page-scrolling layout scrolls here below `md`, as one page;
          // at `md` and up each column owns its own overflow instead.
          !band && "overflow-y-auto md:overflow-hidden"
        )}
      >
        {panel}

        <div className={cn("flex min-w-0 flex-1 flex-col", band && "min-h-0")}>
          <div
            className={cn(
              "flex flex-1 flex-col",
              band ? "min-h-0 overflow-y-auto" : "md:min-h-0 md:overflow-y-auto"
            )}
          >
            <div
              key={bodyKey}
              className={cn(
                "mx-auto flex w-full max-w-[38rem] flex-1 flex-col justify-center-safe px-6 py-8 sm:px-10 lg:py-12",
                GUIDE_BODY_ENTER
              )}
              data-testid={`${testIdPrefix}-step-body`}
            >
              {children}
            </div>
          </div>

          {footer && (
            <footer
              className="shrink-0 border-t border-border/60 px-6 py-4 sm:px-10"
              data-testid={`${testIdPrefix}-actions`}
            >
              <div className="mx-auto flex w-full max-w-[38rem] items-center justify-between gap-3">
                {footer}
              </div>
            </footer>
          )}
        </div>
      </div>
    </div>
  )
}
