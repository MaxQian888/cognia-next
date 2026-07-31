// DOM-bounded ballistic physics for the in-app pet widget — the browser
// counterpart to the Tauri overlay's OS-window throw physics
// (`use-pet-locomotion`'s `beginThrow`). Reuses the same pure stepper
// (`lib/pet/behavior/ballistics.ts`) so a flick feels identical on both
// surfaces, but there's no wander FSM and no Tauri IPC — the widget never
// wanders, it only reacts to a drag release.
//
// The physics runs in "offset" space: (0,0) is the widget's anchored resting
// position. Bounds are derived once per throw from `anchorRef`'s *untransformed*
// rect (the anchor wrapper itself is never offset — only the pet handle inside
// it is), so a bottom-anchored pet has little room to "fall" (it's already
// near the floor) while a top-anchored one can fall the full viewport height.
// Power shape matches `use-pet-locomotion`: no rAF runs except during an
// active throw.

"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  BALLISTIC_DEFAULTS,
  stepBallistic,
  type BallisticParams,
  type BallisticState,
} from "@/lib/pet/behavior/ballistics"

export interface PetWidgetThrowIo {
  now: () => number
  raf: (cb: () => void) => number
  caf: (id: number) => void
}

export interface UsePetWidgetThrowArgs {
  /** The anchor wrapper's rect (untransformed) defines the on-screen bounds. */
  anchorRef: React.RefObject<HTMLElement | null>
  /** Pet render-box size (logical px) — kept fully on-screen at the far edge. */
  petSize: number
  /** Restored offset from a previous session; read once at mount. */
  initialOffset?: { x: number; y: number } | null
  /** Called once when a throw settles, with the final resting offset. */
  onSettle?: (x: number, y: number) => void
  io?: Partial<PetWidgetThrowIo>
}

export interface UsePetWidgetThrowResult {
  offset: { x: number; y: number }
  isThrowing: boolean
  /** Hand off a drag release: velocity in px/s. Starts the ballistic fall. */
  beginThrow: (vx: number, vy: number) => void
  /** Move without physics (live drag tracking, or a non-throw release). */
  setOffsetImmediate: (x: number, y: number) => void
}

const DEFAULT_IO: PetWidgetThrowIo = {
  now: () => performance.now(),
  raf: (cb) => requestAnimationFrame(() => cb()),
  caf: (id) => cancelAnimationFrame(id),
}

export function usePetWidgetThrow(args: UsePetWidgetThrowArgs): UsePetWidgetThrowResult {
  const io = useMemo<PetWidgetThrowIo>(
    () => ({ ...DEFAULT_IO, ...args.io }),
    // io overrides are a test seam — treat as mount-stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const argsRef = useRef(args)
  useEffect(() => {
    argsRef.current = args
  })

  const [offset, setOffset] = useState(() => args.initialOffset ?? { x: 0, y: 0 })
  const [isThrowing, setIsThrowing] = useState(false)
  // The authoritative current offset, written synchronously by every setter
  // below. `offset` (React state) mirrors it for rendering — reading `offset`
  // itself would be one render stale inside a same-tick
  // setOffsetImmediate-then-beginThrow sequence (a throw picking up exactly
  // where a drag left off).
  const offsetRef = useRef(offset)

  const physicsRef = useRef<BallisticState | null>(null)
  const rafIdRef = useRef<number | null>(null)
  const lastFrameMsRef = useRef<number | null>(null)
  const disposedRef = useRef(false)

  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
      if (rafIdRef.current != null) io.caf(rafIdRef.current)
      rafIdRef.current = null
    }
  }, [io])

  /** Bounds snapshot from the anchor's untransformed rect + the viewport. */
  const resolveParams = (): BallisticParams | null => {
    const el = argsRef.current.anchorRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const size = argsRef.current.petSize
    const vw = window.innerWidth
    const vh = window.innerHeight
    const minX = Math.min(0, -rect.left)
    const maxX = Math.max(0, vw - rect.left - size)
    const groundY = Math.max(0, vh - rect.top - size)
    return { ...BALLISTIC_DEFAULTS, groundY, minX, maxX }
  }

  const frame = () => {
    rafIdRef.current = null
    if (disposedRef.current) return
    const state = physicsRef.current
    if (!state) return
    const nowMs = io.now()
    const last = lastFrameMsRef.current
    lastFrameMsRef.current = nowMs
    const dtMs = last == null ? 16 : Math.max(0, nowMs - last)
    // resolveParams reads live rect/viewport each frame — cheap, and keeps a
    // resize mid-throw from launching the pet off a now-stale bound.
    const params = resolveParams()
    if (!params) return
    const next = stepBallistic(state, dtMs, params)
    physicsRef.current = next
    offsetRef.current = { x: next.x, y: next.y }
    setOffset(offsetRef.current)
    if (next.settled) {
      lastFrameMsRef.current = null
      setIsThrowing(false)
      argsRef.current.onSettle?.(Math.round(next.x), Math.round(next.y))
      return
    }
    rafIdRef.current = io.raf(frame)
  }

  const beginThrow = (vx: number, vy: number) => {
    if (!resolveParams()) return // no anchor rect yet — nothing to bound against
    physicsRef.current = { x: offsetRef.current.x, y: offsetRef.current.y, vx, vy, settled: false }
    setIsThrowing(true)
    lastFrameMsRef.current = null
    if (rafIdRef.current == null) rafIdRef.current = io.raf(frame)
  }

  const setOffsetImmediate = (x: number, y: number) => {
    if (rafIdRef.current != null) {
      io.caf(rafIdRef.current)
      rafIdRef.current = null
    }
    physicsRef.current = null
    setIsThrowing(false)
    offsetRef.current = { x, y }
    setOffset(offsetRef.current)
  }

  return { offset, isThrowing, beginThrow, setOffsetImmediate }
}
