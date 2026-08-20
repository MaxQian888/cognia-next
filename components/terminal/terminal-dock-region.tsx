"use client"

/**
 * The animated shell region that hosts the terminal dock.
 *
 * Two instances are mounted by `components/desktop/desktop-app-shell.tsx` — one
 * per physical slot — and each stays in the DOM permanently, collapsed to a
 * zero-size box unless it owns the store's current `panelPosition`. Keeping
 * both mounted is what lets the dock be handed between the bottom edge and the
 * right column, and what lets either one animate at all: a CSS transition needs
 * the element present on both sides of the change.
 *
 * ## How it opens and closes
 *
 * The region animates *the space it takes in the layout* — its `height` when
 * docked bottom, its `width` when docked right — between `0` and its stored
 * size. Both directions are the same transition, so collapsing is the expansion
 * played backwards.
 *
 * This replaced a transform slide that reserved the full size in a single
 * frame. That made the two directions structurally different gestures:
 * expanding jumped the workspace by up to 40% of the shell and *then* slid the
 * dock into the gap it had just torn open, while collapsing slid the dock out
 * and only then closed the gap, in one frame, after the motion had finished.
 * Each toggle therefore contained one instant reflow of everything above (or
 * beside) the dock — the "large jitter" this component exists to not have.
 *
 * ## Why the size is in pixels, and why there is an inner layer
 *
 * The animating outer box clips a fixed-size inner layer holding the dock, so
 * the terminal itself keeps ONE size for the whole animation and slides behind
 * the shell edge instead of being squeezed. That matters more here than it
 * looks: `TerminalInstance` re-fits xterm from a `ResizeObserver` and pushes
 * every new row/column count to the PTY, so a dock whose own box tweened would
 * spend the animation sending a SIGWINCH storm to the child process.
 *
 * Holding the inner layer still needs an absolute size, which is why the stored
 * percentage is resolved against the measured parent rather than handed to CSS:
 * a percentage inside the animating box would track the box. Before the parent
 * has been measured (SSR, the first layout pass) both fall back to the raw
 * percentage, which is exactly the pre-animation behaviour.
 *
 * Axis asymmetry worth knowing about: the bottom dock maximizes by leaving the
 * flow and overlaying the page, which works because the inner shell column is
 * `relative`. The shell *row* is not, and making it relative would silently
 * re-parent the containing block for every `absolute` descendant of the rail and
 * the routed page. So the right dock maximizes to `width: 100%` of the row
 * instead. Same user-visible result, no blast radius.
 */

import { useCallback, useEffect, useState } from "react"

import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { TerminalDock } from "@/components/terminal/terminal-dock"
import { bootReattachTerminals } from "@/lib/terminal/boot-reattach"
import { useEdgePanelTransition } from "@/hooks/shell/use-edge-panel-transition"
import { useElementAxisSize } from "@/hooks/use-element-axis-size"
import { SHELL_DOCK_TIMING_CLASS } from "@/lib/ui/shell-dock-motion"
import { cn } from "@/lib/utils"
import { useTerminalStore, type TerminalPanelPosition } from "@/stores/terminal/terminal-store"

export interface TerminalDockRegionProps {
  /** The slot this instance owns. Collapses to nothing unless it is active. */
  slot: TerminalPanelPosition
}

export function TerminalDockRegion({ slot }: TerminalDockRegionProps) {
  // Reattaching lives here, not in the dock, because this region is mounted
  // permanently by the shell while `<TerminalDock/>` only mounts when the panel
  // is open — and the sessions a remote host kept across the reload have to be
  // back before anything asks for the tab count (the status-bar chip does, and
  // it hides itself at zero). `bootReattachTerminals` runs once per page load,
  // which is what makes it safe to call from both slots.
  useEffect(() => {
    void bootReattachTerminals()
  }, [])

  const panelOpen = useTerminalStore((s) => s.panelOpen)
  const panelPosition = useTerminalStore((s) => s.panelPosition)
  const panelHeightPct = useTerminalStore((s) => s.panelHeightPct)
  const panelWidthPct = useTerminalStore((s) => s.panelWidthPct)
  const maximized = useTerminalStore((s) => s.maximized)
  const { reduce } = useFlowMotion()

  const right = slot === "right"
  const owns = panelPosition === slot
  const open = panelOpen && owns

  // The shell column (bottom) or the shell row (right). Held as state through a
  // callback ref rather than read from a ref during render: the parent is only
  // reachable once this element is in the DOM, and the measurement hook has to
  // re-observe when it changes.
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const attach = useCallback((element: HTMLDivElement | null) => setHost(element), [])
  const basisPx = useElementAxisSize(host?.parentElement ?? null, right ? "width" : "height")

  const pct = maximized ? 100 : right ? panelWidthPct : panelHeightPct
  // Resolved against the parent so the inner layer can hold still while the
  // outer box animates; the percentage is the pre-measurement fallback.
  const fullSize = basisPx > 0 ? `${Math.round((basisPx * pct) / 100)}px` : `${pct}%`

  const animating = useEdgePanelTransition(open, {
    element: host,
    // A slot *move* is a hand-off, not an open/close: the dock leaves one edge
    // and arrives at the other in one commit. Animating the departing side
    // would keep a second <TerminalDock/> — and a second xterm attachment for
    // the same session — alive for the length of the slide.
    enabled: !reduce && (owns || !panelOpen),
  })

  // Kept for exactly one collapse animation so the dock slides out with its
  // content, then unmounts: xterm, its PTY attachment and the dock's own
  // subscriptions must not stay live behind a zero-size box.
  const contentMounted = open || animating

  // Maximizing takes the bottom dock out of the flow instead of squeezing the
  // page to nothing — a chat re-laid-out at zero height loses its scroll
  // anchor, and gets it wrong again on the way back. Held through the collapse
  // so closing while maximized still slides rather than blinking out.
  const overlay = !right && maximized && (open || animating)

  return (
    <div
      ref={attach}
      data-testid="terminal-dock-region"
      data-position={slot}
      data-open={open ? "true" : "false"}
      data-maximized={maximized ? "true" : "false"}
      className={cn(
        // Clips the fixed-size inner layer, which is what turns the size
        // animation into the dock sliding past the shell edge. Dropped once the
        // dock has settled open so its resize separator can keep protruding
        // past the edge — the same trade the conversation sidebar makes; a
        // permanently clipped region shaves the separator's 10px hit zone down
        // to 6px.
        (!open || animating) && "overflow-hidden",
        overlay ? "absolute inset-x-0 bottom-0 z-40" : "shrink-0",
        right ? "h-full min-w-0" : "min-h-0",
        animating && `transition-[width,height] ${SHELL_DOCK_TIMING_CLASS}`
      )}
      style={right ? { width: open ? fullSize : 0 } : { height: open ? fullSize : 0 }}
      aria-hidden={!open || undefined}
      inert={!open || undefined}
    >
      {/* Fixed-size inner layer, anchored to the edge the dock grows from, so
          the terminal is clipped rather than resized while the outer box moves.
          See the note above on the SIGWINCH storm this avoids. */}
      <div
        data-testid="terminal-dock-surface"
        className={right ? "h-full" : "w-full"}
        style={right ? { width: fullSize } : { height: fullSize }}
      >
        {contentMounted ? <TerminalDock /> : null}
      </div>
    </div>
  )
}

export default TerminalDockRegion
