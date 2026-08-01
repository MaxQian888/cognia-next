"use client"

/**
 * The animated shell region that hosts the terminal dock.
 *
 * Two instances are mounted by `components/desktop/desktop-app-shell.tsx` — one
 * per physical slot — and each renders `null` unless it owns the store's current
 * `panelPosition`. Keeping both mounted (rather than moving one node) is what
 * lets the dock slide in from whichever edge it lands on: `AnimatePresence`
 * needs the outgoing node to stay in the tree long enough to run its exit.
 *
 * Axis asymmetry worth knowing about: the bottom dock maximizes by going
 * `absolute inset-0` over the page, which works because the inner shell column
 * is `relative`. The shell *row* is not, and making it relative would silently
 * re-parent the containing block for every `absolute` descendant of the rail and
 * the routed page. So the right dock maximizes to `width: 100%` of the row
 * instead. Same user-visible result, no blast radius.
 */

import { AnimatePresence, motion } from "motion/react"

import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { TerminalDock } from "@/components/terminal/terminal-dock"
import { useTerminalStore, type TerminalPanelPosition } from "@/stores/terminal/terminal-store"

export interface TerminalDockRegionProps {
  /** The slot this instance owns. Renders nothing unless it is the active one. */
  slot: TerminalPanelPosition
}

export function TerminalDockRegion({ slot }: TerminalDockRegionProps) {
  const panelOpen = useTerminalStore((s) => s.panelOpen)
  const panelPosition = useTerminalStore((s) => s.panelPosition)
  const panelHeightPct = useTerminalStore((s) => s.panelHeightPct)
  const panelWidthPct = useTerminalStore((s) => s.panelWidthPct)
  const maximized = useTerminalStore((s) => s.maximized)

  // Slide the dock in from its own edge instead of popping. Only the wrapper's
  // transform animates — the size is reserved instantly so the editor above (or
  // beside) settles once and xterm fits once, never per-frame. Collapses to an
  // instant show/hide under reduced motion.
  const { reduce, durationScale } = useFlowMotion()

  const visible = panelOpen && panelPosition === slot
  const right = slot === "right"

  return (
    <AnimatePresence initial={false}>
      {visible ? (
        <motion.div
          key="terminal-dock-region"
          data-testid="terminal-dock-region"
          data-position={slot}
          data-maximized={maximized ? "true" : "false"}
          className={
            right
              ? "h-full min-w-0 shrink-0"
              : maximized
                ? "absolute inset-0 z-40 min-h-0"
                : "min-h-0 shrink-0"
          }
          style={
            right
              ? { width: maximized ? "100%" : `${panelWidthPct}%` }
              : { height: maximized ? "100%" : `${panelHeightPct}%` }
          }
          initial={reduce ? false : right ? { x: "100%" } : { y: "100%" }}
          animate={right ? { x: 0 } : { y: 0 }}
          exit={
            right
              ? { x: reduce ? 0 : "100%", opacity: reduce ? 0 : 1 }
              : { y: reduce ? 0 : "100%", opacity: reduce ? 0 : 1 }
          }
          transition={{
            duration: reduce ? 0 : 0.2 * durationScale,
            ease: [0.32, 0.72, 0, 1],
          }}
        >
          <TerminalDock />
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

export default TerminalDockRegion
