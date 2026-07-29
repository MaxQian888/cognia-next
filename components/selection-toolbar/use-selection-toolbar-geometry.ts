"use client"

/**
 * Measures the toolbar's content and drives the native window's size, position
 * and hit-rect.
 *
 * The window used to be a hard-coded 360x44 box that had nothing to do with
 * what was inside it, which is where three separate defects came from: the
 * capsule's `shadow-xl` was clipped by a 4px margin, the surplus width was a
 * transparent dead zone Rust still counted as "inside the toolbar", and opening
 * the language menu jumped the window to a fixed 280px height *and* re-anchored
 * it for that height, teleporting the capsule ~236px up the screen.
 *
 * Now the renderer is the authority: it measures, Rust follows. Mirrors
 * `island_resize` (`src-tauri/src/fleet/island_window.rs`) and the measurement
 * shape of `components/fleet/island-shell.tsx`, including its grow-now /
 * shrink-later rule so a collapsing height does not outrun its CSS transition.
 */

import { useCallback, useLayoutEffect, useRef, useState } from "react"
import { useReducedMotion } from "motion/react"

import {
  resizeSelectionToolbar,
  SELECTION_SHADOW_PAD,
  type SelectionAnchorRect,
  type SelectionToolbarPlacement,
} from "@/lib/tauri/selection-toolbar"

/**
 * How long to wait before telling Rust the window got smaller. The capsule's
 * own collapse animation is still playing during this window; resizing first
 * would crop it mid-flight.
 */
const SHRINK_SETTLE_MS = 220

interface WindowBox {
  width: number
  height: number
}

export interface SelectionToolbarGeometryHandles {
  /** Wraps everything the window must contain — capsule plus any open panel. */
  shellRef: React.RefObject<HTMLDivElement | null>
  /** The opaque pill. Its live rect is Rust's primary hit target. */
  capsuleRef: React.RefObject<HTMLDivElement | null>
  /**
   * The language list, while it is open. It is a *sibling* of the capsule, not
   * a child, so it needs its own rect: hit-testing the capsule alone made every
   * click in the list read as a click away, dismissing the candidate before the
   * click's own handler could use it.
   */
  panelRef: React.RefObject<HTMLElement | null>
  /**
   * An `aria-hidden` copy of the widest state the capsule can reach (every
   * icon plus the longest label expanded). Pinning the window to this width
   * once means hovering never resizes the window — the label expansion is pure
   * layout animation with no IPC round-trip and no flicker.
   */
  ghostRef: React.RefObject<HTMLDivElement | null>
  placement: SelectionToolbarPlacement
  /** True once the first resize has landed — the window may now be revealed. */
  measured: boolean
  remeasure: () => void
}

function readBox(element: HTMLElement | null): DOMRect | null {
  if (!element) return null
  const rect = element.getBoundingClientRect()
  return rect.width > 0 || rect.height > 0 ? rect : null
}

function sameBox(a: WindowBox | null, b: WindowBox): boolean {
  return a !== null && a.width === b.width && a.height === b.height
}

function sameRect(a: SelectionAnchorRect, b: SelectionAnchorRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function sameRects(a: SelectionAnchorRect[] | null, b: SelectionAnchorRect[]): boolean {
  return a !== null && a.length === b.length && a.every((rect, i) => sameRect(rect, b[i]))
}

/** Window-local, integral rect for an element — or null if it is not laid out. */
function toHitRect(element: HTMLElement | null): SelectionAnchorRect | null {
  const rect = readBox(element)
  if (!rect) return null
  // `getBoundingClientRect` is already window-local: the toolbar window is
  // frameless, so the viewport origin and the window origin coincide.
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.ceil(rect.width),
    height: Math.ceil(rect.height),
  }
}

/**
 * @param contentKey Signature of everything that can change the layout
 *   (candidate id, state, hovered action, open panel). Re-measures whenever it
 *   changes — cheaper and more predictable than a ResizeObserver here, because
 *   the layout only moves in response to discrete state changes.
 */
export function useSelectionToolbarGeometry(contentKey: string): SelectionToolbarGeometryHandles {
  const shellRef = useRef<HTMLDivElement | null>(null)
  const capsuleRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)
  const ghostRef = useRef<HTMLDivElement | null>(null)
  const reduceMotion = useReducedMotion()

  const [placement, setPlacement] = useState<SelectionToolbarPlacement>("above")
  const [measured, setMeasured] = useState(false)
  const [measureNonce, setMeasureNonce] = useState(0)

  const lastBoxRef = useRef<WindowBox | null>(null)
  const lastHitRectsRef = useRef<SelectionAnchorRect[] | null>(null)
  const shrinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const remeasure = useCallback(() => setMeasureNonce((nonce) => nonce + 1), [])

  useLayoutEffect(() => {
    const shell = readBox(shellRef.current)
    const capsuleRect = toHitRect(capsuleRef.current)
    if (!shell || !capsuleRect) return

    const ghostWidth = ghostRef.current?.getBoundingClientRect().width ?? 0
    const box: WindowBox = {
      width: Math.ceil(Math.max(ghostWidth, shell.width)) + SELECTION_SHADOW_PAD * 2,
      height: Math.ceil(shell.height) + SELECTION_SHADOW_PAD * 2,
    }
    // The capsule first, then the language list when it is open. Two rects
    // rather than their bounding box: the shell stacks them with a gap and
    // centres them, so the box would also claim that gap and the corners beside
    // whichever of the two is narrower.
    const panelRect = toHitRect(panelRef.current)
    const hitRects = panelRect ? [capsuleRect, panelRect] : [capsuleRect]

    const boxUnchanged = sameBox(lastBoxRef.current, box)
    if (boxUnchanged && sameRects(lastHitRectsRef.current, hitRects)) return

    const send = () => {
      lastBoxRef.current = box
      lastHitRectsRef.current = hitRects
      void resizeSelectionToolbar(box.width, box.height, hitRects).then(
        (geometry) => {
          setPlacement(geometry.placement)
          setMeasured(true)
        },
        (error: unknown) => {
          // `measured` gates the reveal, so swallowing this would leave the
          // window permanently hidden — a toolbar at the wrong size beats no
          // toolbar at all. Forget the sent box so the next content change
          // retries instead of being suppressed by the equality guard above.
          console.warn("selection toolbar resize failed", error)
          lastBoxRef.current = null
          lastHitRectsRef.current = null
          setMeasured(true)
        }
      )
    }

    // No need to clear a pending shrink here: React runs the previous effect's
    // cleanup before this body, and the shrink branch is the only path that
    // arms the timer — so it is always already null by now.
    const previous = lastBoxRef.current
    const shrinking =
      previous !== null && (box.width < previous.width || box.height < previous.height)
    // A pure hit-rect change (hover expanding the capsule inside an unchanged
    // window) is invisible, so it never waits.
    if (shrinking && !boxUnchanged && !reduceMotion) {
      shrinkTimerRef.current = setTimeout(send, SHRINK_SETTLE_MS)
      return () => {
        if (shrinkTimerRef.current) {
          clearTimeout(shrinkTimerRef.current)
          shrinkTimerRef.current = null
        }
      }
    }
    send()
  }, [contentKey, measureNonce, reduceMotion])

  useLayoutEffect(
    () => () => {
      if (shrinkTimerRef.current) clearTimeout(shrinkTimerRef.current)
    },
    []
  )

  return { shellRef, capsuleRef, panelRef, ghostRef, placement, measured, remeasure }
}
