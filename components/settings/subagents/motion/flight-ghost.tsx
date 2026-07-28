"use client"

/**
 * Cross-column flight for the Subagents master/detail selection: when a nav
 * row is picked, its round avatar appears to fly into the detail header.
 *
 * Implemented as a measured FLIP over a transient ghost rather than motion's
 * `layoutId` shared-element, and that choice is load-bearing. A shared layout
 * animation needs the two elements to hand off as one mounts and the other
 * unmounts; here the nav row *stays mounted* while the header updates, so two
 * live elements would carry the same `layoutId` simultaneously — undefined
 * territory, and exactly the sort of thing that reads as jitter. Measuring two
 * rects and animating a throwaway node between them depends on no layout
 * semantics at all, and composes cleanly with the `AnimatePresence mode="wait"`
 * crossfade that `PanelTransition` runs on the body underneath.
 *
 * The detail header must therefore live OUTSIDE `PanelTransition` — under
 * `mode="wait"` the incoming panel does not mount until the outgoing one has
 * finished exiting, so a target inside it would not exist to measure.
 */

import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { motion } from "motion/react"

import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { MOBILE_SPRING } from "@/lib/ui/motion"

/** Attribute the detail header's avatar carries so the ghost can find it. */
export const FLIGHT_TARGET_ATTR = "data-flight-target"

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

interface FlightState {
  from: Rect
  to: Rect
  /** Bumped per flight so a rapid re-selection restarts the animation. */
  key: number
}

/** Escape a value for use inside a quoted attribute selector. */
function escapeAttrValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function toRect(el: Element): Rect {
  const r = el.getBoundingClientRect()
  return { top: r.top, left: r.left, width: r.width, height: r.height }
}

/** A zero-area rect means an unlaid-out element (or jsdom) — never fly then. */
function isMeasurable(r: Rect): boolean {
  return r.width > 0 && r.height > 0
}

export interface SubagentFlightGhostProps {
  /** Current panel id; a change is what triggers a flight. */
  activePanel: string
  /** The avatar to render mid-flight — same node the header shows. */
  children: React.ReactNode
  /** Lets the header hide its own avatar while the ghost is in the air. */
  onFlightChange?: (flying: boolean) => void
}

export function SubagentFlightGhost({
  activePanel,
  children,
  onFlightChange,
}: SubagentFlightGhostProps) {
  const { reduce, speed } = useFlowMotion()
  const [flight, setFlight] = useState<FlightState | null>(null)
  const previousPanel = useRef<string | null>(null)
  const flightSeq = useRef(0)

  useEffect(() => {
    const previous = previousPanel.current
    previousPanel.current = activePanel
    // First mount is a render, not a selection change — nothing to fly from.
    if (previous === null || previous === activePanel) return
    if (reduce) return
    if (typeof document === "undefined") return

    const source = document.querySelector(`[data-flight-source="${escapeAttrValue(activePanel)}"]`)
    const target = document.querySelector(`[${FLIGHT_TARGET_ATTR}]`)
    if (!source || !target) return

    const from = toRect(source)
    const to = toRect(target)
    if (!isMeasurable(from) || !isMeasurable(to)) return

    flightSeq.current += 1
    setFlight({ from, to, key: flightSeq.current })
    onFlightChange?.(true)
  }, [activePanel, reduce, onFlightChange])

  // A reduce-motion switch mid-flight must land immediately, or the header
  // avatar stays hidden behind a ghost that will never animate again. This is
  // the "sync to an external system" case the rule carves out — the external
  // system being the OS/app motion preference — so the state write is the
  // point rather than a cascade.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (reduce && flight) {
      setFlight(null)
      onFlightChange?.(false)
    }
  }, [reduce, flight, onFlightChange])
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!flight || typeof document === "undefined") return null

  return createPortal(
    <motion.div
      key={flight.key}
      aria-hidden
      data-testid="subagent-flight-ghost"
      className="pointer-events-none fixed z-50"
      initial={{
        top: flight.from.top,
        left: flight.from.left,
        width: flight.from.width,
        height: flight.from.height,
        opacity: 1,
      }}
      animate={{
        top: flight.to.top,
        left: flight.to.left,
        width: flight.to.width,
        height: flight.to.height,
        opacity: 1,
      }}
      transition={{
        ...MOBILE_SPRING,
        // `speed` is the user's motion multiplier; a higher setting means a
        // snappier spring, so it scales stiffness rather than a duration.
        ...(typeof (MOBILE_SPRING as { stiffness?: number }).stiffness === "number"
          ? {
              stiffness:
                (MOBILE_SPRING as { stiffness?: number }).stiffness! * Math.max(speed, 0.25),
            }
          : {}),
      }}
      onAnimationComplete={() => {
        setFlight(null)
        onFlightChange?.(false)
      }}
    >
      <div className="flex size-full items-center justify-center">{children}</div>
    </motion.div>,
    document.body
  )
}
