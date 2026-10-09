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
  /** True once this candidate has acknowledged its final geometry. */
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
 * @param candidateId Identity of the selection being placed; null keeps the window hidden.
 * @param contentKey Signature of everything that can change the layout
 *   (candidate id, state, hovered action, open panel). Re-measures whenever it
 *   changes. Viewport and observed content sizes also invalidate the measurement.
 */
export function useSelectionToolbarGeometry(
  candidateId: string | null,
  contentKey: string
): SelectionToolbarGeometryHandles {
  const shellRef = useRef<HTMLDivElement | null>(null)
  const capsuleRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)
  const ghostRef = useRef<HTMLDivElement | null>(null)
  const reduceMotion = useReducedMotion()

  const [placement, setPlacement] = useState<SelectionToolbarPlacement>("above")
  const [measuredLayout, setMeasuredLayout] = useState<{
    candidateId: string
    contentKey: string
    measureNonce: number
  } | null>(null)
  const [acknowledgement, setAcknowledgement] = useState(0)
  const [measureNonce, setMeasureNonce] = useState(0)

  const lastBoxRef = useRef<WindowBox | null>(null)
  const lastHitRectsRef = useRef<SelectionAnchorRect[] | null>(null)
  const lastCandidateRef = useRef<string | null>(null)
  // Native mutations must finish in order, including after an effect is cancelled.
  const pendingRef = useRef<Promise<void>>(Promise.resolve())

  const remeasure = useCallback(() => setMeasureNonce((nonce) => nonce + 1), [])

  useLayoutEffect(() => {
    if (!candidateId) {
      lastCandidateRef.current = null
      return
    }
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

    const sameCandidate = lastCandidateRef.current === candidateId
    const boxUnchanged = sameCandidate && sameBox(lastBoxRef.current, box)
    if (boxUnchanged && sameRects(lastHitRectsRef.current, hitRects)) {
      // A successful native resize causes another layout pass. Only its final
      // local rectangles may unlock reveal, including when placement flipped.
      let cancelled = false
      void Promise.resolve().then(() => {
        if (!cancelled) setMeasuredLayout({ candidateId, contentKey, measureNonce })
      })
      return () => {
        cancelled = true
      }
    }

    let cancelled = false
    let shrinkTimer: ReturnType<typeof setTimeout> | undefined
    const send = () => {
      pendingRef.current = pendingRef.current.then(async () => {
        if (cancelled) return
        try {
          // A cancelled IPC still mutates the native window. Until it settles,
          // the last acknowledged box cannot justify skipping a restoration.
          lastCandidateRef.current = null
          const geometry = await resizeSelectionToolbar(
            candidateId,
            box.width,
            box.height,
            hitRects
          )
          if (cancelled) return
          lastCandidateRef.current = candidateId
          lastBoxRef.current = box
          lastHitRectsRef.current = hitRects
          setPlacement(geometry.placement)
          setAcknowledgement((value) => value + 1)
        } catch (error) {
          if (cancelled) return
          console.warn("selection toolbar resize failed", error)
          lastCandidateRef.current = null
          lastBoxRef.current = null
          lastHitRectsRef.current = null
          // Keep the placeholder hidden. A later layout/viewport change or an
          // explicit remeasure retries without claiming a failed placement.
        }
      })
    }

    const previous = sameCandidate ? lastBoxRef.current : null
    const shrinking =
      previous !== null && (box.width < previous.width || box.height < previous.height)
    if (shrinking && !boxUnchanged && !reduceMotion) {
      shrinkTimer = setTimeout(send, SHRINK_SETTLE_MS)
    } else {
      send()
    }
    return () => {
      cancelled = true
      if (shrinkTimer !== undefined) clearTimeout(shrinkTimer)
    }
  }, [candidateId, contentKey, measureNonce, reduceMotion, placement, acknowledgement])

  useLayoutEffect(() => {
    window.addEventListener("resize", remeasure)
    return () => window.removeEventListener("resize", remeasure)
  }, [remeasure])

  useLayoutEffect(() => {
    if (!candidateId || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(remeasure)
    for (const element of [
      shellRef.current,
      capsuleRef.current,
      panelRef.current,
      ghostRef.current,
    ]) {
      if (element) observer.observe(element)
    }
    return () => observer.disconnect()
  }, [candidateId, contentKey, remeasure])

  const measured =
    candidateId !== null &&
    measuredLayout?.candidateId === candidateId &&
    measuredLayout.contentKey === contentKey &&
    measuredLayout.measureNonce === measureNonce

  return { shellRef, capsuleRef, panelRef, ghostRef, placement, measured, remeasure }
}
