// Overlay-only locomotion driver: owns the rAF loop + rest timer + seeded
// PRNG, steps the pure FSM (lib/pet/behavior/locomotion-fsm.ts), and moves the
// OS window through the Tauri wrapper. All real logic lives in the pure
// modules; this hook is the thin clock-and-IPC glue, with every side effect
// injectable through `io` so jsdom tests can drive it deterministically.
//
// Power shape: while the pet rests, NO rAF runs — a single timeout wakes the
// loop at `restUntilMs`. The 60fps stepping only happens while the window is
// actually walking or falling.

"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import type { PetLocomotion, PetWanderSettings } from "@/types/pet"
import { getPetWindowPosition, getPetWorkArea, setPetWindowPosition } from "@/lib/tauri/pet-window"
import { overlayWindowSize, type WorkAreaRect } from "@/lib/pet/overlay-geometry"
import {
  beginThrow as fsmBeginThrow,
  createLocomotionState,
  stepLocomotion,
  type LocomotionFsmState,
  type LocomotionInput,
} from "@/lib/pet/behavior/locomotion-fsm"
import { resolveWanderTuning } from "@/lib/pet/behavior/wander-config"
import { mulberry32 } from "@/lib/pet/bones/prng"

/** Injectable side effects (defaults are the real implementations). */
export interface PetLocomotionIo {
  getWorkArea: typeof getPetWorkArea
  getPosition: typeof getPetWindowPosition
  setPosition: typeof setPetWindowPosition
  now: () => number
  raf: (cb: () => void) => number
  caf: (id: number) => void
  setTimer: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer: (id: ReturnType<typeof setTimeout>) => void
  createRng: (seed: number) => () => number
}

export interface UsePetLocomotionArgs {
  /** Wandering master gate: overlay active && wander.enabled && !reduced. */
  enabled: boolean
  /** Freeze inputs: dragging / menu open / bubble showing / hidden / click-through. */
  paused: boolean
  wander: PetWanderSettings
  lowPower: boolean
  /** Pet render-box size (logical px) — resolves the overlay window box. */
  petSize: number
  /** Reads the latest user-interaction timestamp (same clock as `io.now`). */
  lastInteractionAtMs: () => number | null
  /** Called with the resting window position after a walk/fall settles. */
  onSettle?: (x: number, y: number) => void
  io?: Partial<PetLocomotionIo>
}

export interface UsePetLocomotionResult {
  locomotion: PetLocomotion
  /** Monitor scale factor (physical = logical × scale); 1 until known. */
  scaleFactor: number
  /**
   * Hand off a drag release: window position + release velocity in physical
   * px(/s). Enters the falling mode regardless of the wander switch.
   */
  beginThrow: (x: number, y: number, vx: number, vy: number) => void
}

const DEFAULT_IO: PetLocomotionIo = {
  getWorkArea: getPetWorkArea,
  getPosition: getPetWindowPosition,
  setPosition: setPetWindowPosition,
  now: () => performance.now(),
  raf: (cb) => requestAnimationFrame(() => cb()),
  caf: (id) => cancelAnimationFrame(id),
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (id) => clearTimeout(id),
  createRng: mulberry32,
}

export function usePetLocomotion(args: UsePetLocomotionArgs): UsePetLocomotionResult {
  const io = useMemo<PetLocomotionIo>(
    () => ({ ...DEFAULT_IO, ...args.io }),
    // The io overrides are a test seam — treat as mount-stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // Latest args readable from the loop without re-binding effects every render.
  const argsRef = useRef(args)
  useEffect(() => {
    argsRef.current = args
  })

  const stateRef = useRef<LocomotionFsmState | null>(null)
  const workAreaRef = useRef<WorkAreaRect | null>(null)
  const scaleRef = useRef(1)
  const rngRef = useRef<(() => number) | null>(null)
  const rafIdRef = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastFrameMsRef = useRef<number | null>(null)
  const lastSentRef = useRef<{ x: number; y: number } | null>(null)
  const disposedRef = useRef(false)

  const [locomotion, setLocomotion] = useState<PetLocomotion>({
    mode: "resting",
    facing: "right",
  })
  const [scaleFactor, setScaleFactor] = useState(1)

  // Imperative pile shared by the loop, kept in one ref-closured object so the
  // single long-lived effect below owns every timer/raf id.
  const engineRef = useRef<{ kick: () => void; refreshArea: () => void } | null>(null)

  useEffect(() => {
    disposedRef.current = false

    const stopRaf = () => {
      if (rafIdRef.current != null) {
        io.caf(rafIdRef.current)
        rafIdRef.current = null
      }
    }
    const stopTimer = () => {
      if (timerRef.current != null) {
        io.clearTimer(timerRef.current)
        timerRef.current = null
      }
    }

    const publish = (state: LocomotionFsmState) => {
      setLocomotion((prev) =>
        prev.mode === state.mode && prev.facing === state.facing
          ? prev
          : { mode: state.mode, facing: state.facing }
      )
    }

    /** Refresh the cached work-area (cheap IPC; called on activation + landings). */
    const refreshArea = () => {
      void io.getWorkArea().then((area) => {
        if (disposedRef.current || !area) return
        workAreaRef.current = { x: area.x, y: area.y, width: area.width, height: area.height }
        scaleRef.current = area.scaleFactor || 1
        setScaleFactor(scaleRef.current)
      })
    }

    const buildInput = (nowMs: number): LocomotionInput | null => {
      const a = argsRef.current
      const area = workAreaRef.current
      const rng = rngRef.current
      if (!area || !rng) return null
      const scale = scaleRef.current
      const logical = overlayWindowSize(a.petSize)
      const tuning = resolveWanderTuning(a.wander.frequency, a.lowPower)
      return {
        nowMs,
        paused: a.paused,
        wanderEnabled: a.enabled && a.wander.enabled,
        onlyAfterInteraction: a.wander.onlyAfterInteraction,
        lastInteractionAtMs: a.lastInteractionAtMs(),
        range: a.wander.range,
        workArea: area,
        windowWidth: logical.width * scale,
        windowHeight: logical.height * scale,
        tuning: { ...tuning, walkSpeedPxPerSec: tuning.walkSpeedPxPerSec * scale },
        rng,
      }
    }

    const sendPosition = (state: LocomotionFsmState) => {
      const x = Math.round(state.x)
      const y = Math.round(state.y)
      const last = lastSentRef.current
      if (last && last.x === x && last.y === y) return
      lastSentRef.current = { x, y }
      void io.setPosition(x, y)
    }

    const frame = () => {
      rafIdRef.current = null
      if (disposedRef.current) return
      const state = stateRef.current
      const nowMs = io.now()
      const input = buildInput(nowMs)
      if (!state || !input) return
      const last = lastFrameMsRef.current
      lastFrameMsRef.current = nowMs
      const dtMs = last == null ? 16 : Math.max(0, nowMs - last)

      const prevMode = state.mode
      const next = stepLocomotion(state, input, dtMs)
      stateRef.current = next
      publish(next)
      if (next.x !== state.x || next.y !== state.y) sendPosition(next)

      if (next.mode === "resting") {
        // A walk/fall just finished → persist the resting spot + re-read the
        // monitor (the user may have moved the window across screens).
        if (prevMode !== "resting") {
          argsRef.current.onSettle?.(Math.round(next.x), Math.round(next.y))
          refreshArea()
        }
        lastFrameMsRef.current = null
        const a = argsRef.current
        if (!(a.enabled && a.wander.enabled) || a.paused) return // dormant until args change
        if (next.restUntilMs == null) {
          // Not scheduled yet — step once more next frame to draw the rest.
          rafIdRef.current = io.raf(frame)
          return
        }
        const waitMs = Math.max(0, next.restUntilMs - nowMs)
        stopTimer()
        timerRef.current = io.setTimer(() => {
          timerRef.current = null
          kick()
        }, waitMs + 1)
        return
      }

      rafIdRef.current = io.raf(frame)
    }

    /** Start (or resume) the loop, initializing position/area lazily. */
    const kick = () => {
      if (disposedRef.current || rafIdRef.current != null) return
      if (rngRef.current == null) {
        // Seed once per mount from the wall clock — inside the effect, never in
        // render; determinism in tests comes through `io.createRng`.
        rngRef.current = io.createRng(Math.floor(io.now() * 1000) % 2_147_483_647)
      }
      if (stateRef.current == null || workAreaRef.current == null) {
        void Promise.all([io.getPosition(), io.getWorkArea()]).then(([pos, area]) => {
          if (disposedRef.current) return
          if (area) {
            workAreaRef.current = { x: area.x, y: area.y, width: area.width, height: area.height }
            scaleRef.current = area.scaleFactor || 1
            setScaleFactor(scaleRef.current)
          }
          if (stateRef.current == null) {
            const base = pos ?? { x: 0, y: 0 }
            stateRef.current = createLocomotionState(base.x, base.y)
            lastSentRef.current = { x: Math.round(base.x), y: Math.round(base.y) }
          }
          if (workAreaRef.current && rafIdRef.current == null && !disposedRef.current) {
            lastFrameMsRef.current = null
            rafIdRef.current = io.raf(frame)
          }
        })
        return
      }
      lastFrameMsRef.current = null
      rafIdRef.current = io.raf(frame)
    }

    engineRef.current = { kick, refreshArea }

    return () => {
      disposedRef.current = true
      engineRef.current = null
      stopRaf()
      stopTimer()
    }
  }, [io])

  // (Re)activate the loop whenever the gates open. The loop parks itself when
  // resting + paused/disabled, so flipping a gate must kick it again.
  const active = args.enabled && args.wander.enabled && !args.paused
  useEffect(() => {
    if (active) engineRef.current?.kick()
  }, [active])

  const beginThrow = (x: number, y: number, vx: number, vy: number) => {
    const prev = stateRef.current ?? createLocomotionState(x, y, vx < 0 ? "left" : "right")
    stateRef.current = fsmBeginThrow({ ...prev, x, y }, vx, vy)
    lastSentRef.current = { x: Math.round(x), y: Math.round(y) }
    engineRef.current?.kick()
  }

  return { locomotion, scaleFactor, beginThrow }
}
