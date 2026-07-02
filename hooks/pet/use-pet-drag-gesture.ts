// Shared pointer drag/tap/throw-velocity state machine for the pet's two
// interactive surfaces (the Tauri overlay window and the in-app widget). Both
// need identical click-vs-drag disambiguation (a small movement threshold) and
// a release-velocity estimate for throw physics, but differ in what "moving"
// means (an OS window position vs. a local DOM offset) — so this hook reports
// deltas from the press origin and lets the caller decide what to do with
// them, rather than owning any notion of absolute position itself.
//
// Every side effect is injectable through `io` so jsdom tests can drive the
// rAF batching deterministically (same seam as `use-pet-locomotion`'s `io`).

"use client"

import { useEffect, useMemo, useRef } from "react"
import { releaseVelocityFromSamples, type PointerSample } from "@/lib/pet/overlay-geometry"

export interface PetDragGestureIo {
  now: () => number
  raf: (cb: () => void) => number
  caf: (id: number) => void
}

export interface PetDragReleaseInfo {
  wasDrag: boolean
  /** Cumulative delta (px) from the press origin. */
  dx: number
  dy: number
  /** Release velocity (px/s), estimated from the last ~140ms of samples. Zero for a tap. */
  vx: number
  vy: number
  event: React.PointerEvent
}

export interface UsePetDragGestureArgs {
  /** px movement before a press counts as a drag instead of a tap. Default 4. */
  threshold?: number
  /** Only presses with this button start a gesture. Default 0 (left). */
  button?: number
  /** Fired once, synchronously, the instant the threshold is crossed. */
  onDragStart?: () => void
  /** rAF-throttled; dx/dy are cumulative deltas from the press origin. */
  onDragMove: (dx: number, dy: number) => void
  /** Fired on pointer-up, for both a tap (wasDrag=false) and a drag release. */
  onRelease: (info: PetDragReleaseInfo) => void
  /** Fired on pointer-cancel instead of `onRelease` — no tap/throw should follow. */
  onCancel?: (info: { wasDrag: boolean }) => void
  io?: Partial<PetDragGestureIo>
}

export interface PetDragGestureHandlers {
  onPointerDown: (e: React.PointerEvent) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerUp: (e: React.PointerEvent) => void
  onPointerCancel: (e: React.PointerEvent) => void
}

const DEFAULT_IO: PetDragGestureIo = {
  now: () => performance.now(),
  raf: (cb) => requestAnimationFrame(() => cb()),
  caf: (id) => cancelAnimationFrame(id),
}

/** Pointer samples kept for the release-velocity estimate. */
const MAX_DRAG_SAMPLES = 8

interface DragState {
  pointerId: number
  startX: number
  startY: number
  dragging: boolean
  rafId: number | null
  pending: { dx: number; dy: number } | null
  /** Relative-delta samples; velocity is a difference so the origin cancels out. */
  samples: PointerSample[]
}

export function usePetDragGesture(args: UsePetDragGestureArgs): PetDragGestureHandlers {
  const threshold = args.threshold ?? 4
  const button = args.button ?? 0

  const argsRef = useRef(args)
  useEffect(() => {
    argsRef.current = args
  })

  const io = useMemo<PetDragGestureIo>(
    () => ({ ...DEFAULT_IO, ...args.io }),
    // io overrides are a test seam — treat as mount-stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const dragRef = useRef<DragState | null>(null)

  useEffect(() => {
    return () => {
      const d = dragRef.current
      if (d?.rafId != null) io.caf(d.rafId)
      dragRef.current = null
    }
  }, [io])

  const flushMove = () => {
    const d = dragRef.current
    if (!d) return
    d.rafId = null
    if (!d.pending) return
    const { dx, dy } = d.pending
    d.pending = null
    argsRef.current.onDragMove(dx, dy)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== button) return
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.screenX,
      startY: e.screenY,
      dragging: false,
      rafId: null,
      pending: null,
      samples: [],
    }
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    const dx = e.screenX - d.startX
    const dy = e.screenY - d.startY
    if (!d.dragging && Math.abs(dx) < threshold && Math.abs(dy) < threshold) return
    if (!d.dragging) {
      d.dragging = true
      argsRef.current.onDragStart?.()
    }
    d.samples.push({ x: dx, y: dy, tMs: io.now() })
    if (d.samples.length > MAX_DRAG_SAMPLES) d.samples.shift()
    d.pending = { dx, dy }
    if (d.rafId == null) d.rafId = io.raf(flushMove)
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    ;(e.currentTarget as Element).releasePointerCapture?.(e.pointerId)
    if (d.rafId != null) {
      io.caf(d.rafId)
      d.rafId = null
    }
    const dx = e.screenX - d.startX
    const dy = e.screenY - d.startY
    const wasDrag = d.dragging
    const samples = d.samples
    dragRef.current = null
    const { vx, vy } = wasDrag ? releaseVelocityFromSamples(samples) : { vx: 0, vy: 0 }
    argsRef.current.onRelease({ wasDrag, dx, dy, vx, vy, event: e })
  }

  const onPointerCancel = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    if (d.rafId != null) io.caf(d.rafId)
    const wasDrag = d.dragging
    dragRef.current = null
    argsRef.current.onCancel?.({ wasDrag })
  }

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel }
}
