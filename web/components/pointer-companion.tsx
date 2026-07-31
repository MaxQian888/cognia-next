"use client"

import { useEffect, useRef, useState } from "react"
import {
  type CompanionFrame,
  IDLE_SIZE,
  approach,
  companionTarget,
  settled,
} from "@web/lib/magnetism"

/** Elements the ring latches onto. */
export const MAGNETIC_ATTR = "data-magnetic"

const EASE = 0.18

/**
 * A ring that follows the pointer and latches onto controls (spec §6.7).
 *
 * **The native cursor is never hidden.** The usual way to build this is
 * `cursor: none` plus a hand-drawn dot, and that breaks a real set of
 * accessibility settings: OS pointer enlargement, high-contrast pointers, and
 * every custom cursor a user has deliberately chosen. Those are assistive
 * settings, not decoration. This is purely additive — the system cursor stays
 * exactly where it was, and the ring is a second, decorative layer behind it.
 *
 * It is off unless all three hold:
 *
 * - `(pointer: fine)` and `(hover: hover)` — a touch screen has no pointer to
 *   follow, and a coarse pointer would put the ring under the user's thumb.
 * - `prefers-reduced-motion: no-preference` — this is continuous
 *   `requestAnimationFrame` motion, and the belt in `globals.css` collapses
 *   `animation-duration`, which does nothing to a rAF loop. It has to opt out
 *   itself.
 * - after mount — the server cannot know any of the above, and rendering it
 *   during SSR would guarantee a hydration mismatch.
 *
 * The loop writes transforms straight to the node and never sets React state:
 * at 60fps a state update per frame would re-render the subtree sixty times a
 * second. Same reason `rolling-number.tsx` does it in the product app.
 */
export function PointerCompanion() {
  const ringRef = useRef<HTMLDivElement | null>(null)
  const [active, setActive] = useState(false)

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return

    const fine = window.matchMedia("(pointer: fine) and (hover: hover)")
    const still = window.matchMedia("(prefers-reduced-motion: reduce)")

    const evaluate = () => setActive(fine.matches && !still.matches)
    evaluate()

    fine.addEventListener("change", evaluate)
    still.addEventListener("change", evaluate)
    return () => {
      fine.removeEventListener("change", evaluate)
      still.removeEventListener("change", evaluate)
    }
  }, [])

  useEffect(() => {
    if (!active) return
    const node = ringRef.current
    if (!node) return

    let frame = 0
    let magnet: Element | null = null
    let pointer = { x: -9999, y: -9999 }
    let current: CompanionFrame = {
      x: -9999,
      y: -9999,
      width: IDLE_SIZE,
      height: IDLE_SIZE,
      radius: IDLE_SIZE / 2,
    }
    let visible = false

    const corners = Array.from(node.querySelectorAll<HTMLElement>("[data-corner]"))

    const draw = () => {
      frame = 0
      const rect = magnet?.getBoundingClientRect() ?? null
      // Adopt the control's own corner radius so the brackets sit *on* its edge
      // rather than cutting across it. A square control reports 0 and the
      // brackets stay square, which is also correct.
      const radius = magnet
        ? Number.parseFloat(getComputedStyle(magnet).borderTopLeftRadius) || 0
        : 0
      const target = companionTarget(pointer.x, pointer.y, rect, radius)

      current = approach(current, target, EASE)
      node.style.transform = `translate3d(${current.x - current.width / 2}px, ${
        current.y - current.height / 2
      }px, 0)`
      node.style.width = `${current.width}px`
      node.style.height = `${current.height}px`
      for (const corner of corners) {
        corner.style[corner.dataset.radius as "borderTopLeftRadius"] = `${current.radius}px`
      }

      // Stop the loop once the ring has caught up; a permanent rAF loop on an
      // idle page is a battery cost with nothing to show for it.
      if (!settled(current, target)) schedule()
    }

    const schedule = () => {
      if (frame) return
      frame = window.requestAnimationFrame(draw)
    }

    const onMove = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY }
      if (!visible) {
        visible = true
        node.style.opacity = "1"
        // Jump rather than fly in from the last known position, which after a
        // window switch could be the far corner.
        current = { ...current, x: pointer.x, y: pointer.y }
      }
      const found = (event.target as Element | null)?.closest?.(`[${MAGNETIC_ATTR}]`) ?? null
      magnet = found
      schedule()
    }

    const onLeave = () => {
      visible = false
      magnet = null
      node.style.opacity = "0"
    }

    window.addEventListener("pointermove", onMove, { passive: true })
    document.addEventListener("pointerleave", onLeave)
    window.addEventListener("blur", onLeave)

    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      window.removeEventListener("pointermove", onMove)
      document.removeEventListener("pointerleave", onLeave)
      window.removeEventListener("blur", onLeave)
    }
  }, [active])

  if (!active) return null

  return (
    <div
      ref={ringRef}
      aria-hidden
      data-testid="pointer-companion"
      // `fixed` + `pointer-events-none` so it can never intercept a click, and
      // a z-index below the nav so it does not sit on top of real chrome.
      className="pointer-events-none fixed left-0 top-0 z-40 opacity-0 transition-opacity duration-200 will-change-transform"
      style={{ width: IDLE_SIZE, height: IDLE_SIZE }}
    >
      {/* Four corner brackets, not a closed outline.
       *
       * A full rectangle traced around every control reads as a selection box —
       * something has been *chosen* — and at 1px it just looks like a stray
       * border. Corners read as a viewfinder instead: the thing under the
       * pointer is being *sighted*, not selected. It is also the same
       * vocabulary as the registration ticks on the brand mark and the
       * measurement rules the rest of the page is built from (spec §2.4),
       * rather than a new shape invented for this one effect.
       *
       * Idle they sit ~4px apart and read as a reticle; latched they spread to
       * frame the control. One container transform drives both, so there is no
       * per-corner arithmetic to get wrong. */}
      {CORNERS.map((corner) => (
        <span
          key={corner.key}
          data-corner={corner.key}
          data-radius={corner.radius}
          className={`absolute size-2.5 border-action ${corner.className}`}
        />
      ))}
    </div>
  )
}

const CORNERS = [
  { key: "tl", radius: "borderTopLeftRadius", className: "left-0 top-0 border-l border-t" },
  { key: "tr", radius: "borderTopRightRadius", className: "right-0 top-0 border-r border-t" },
  { key: "bl", radius: "borderBottomLeftRadius", className: "bottom-0 left-0 border-b border-l" },
  { key: "br", radius: "borderBottomRightRadius", className: "bottom-0 right-0 border-b border-r" },
] as const
