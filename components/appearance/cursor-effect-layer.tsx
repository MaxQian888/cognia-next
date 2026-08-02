"use client"

// The pointer-effect overlay: one full-viewport canvas that draws the particle
// field behind the cursor.
//
// Everything about this component is written so that a decorative feature can
// never become a performance or accessibility problem:
//
//   - it renders nothing at all unless an effect is selected;
//   - it stands down under reduced motion (OS hint or the app's own setting),
//     because a particle trail is exactly the kind of motion that setting is
//     about;
//   - it stands down on coarse pointers — there is no cursor to decorate on a
//     touch screen, and the canvas would just cost memory on mobile;
//   - the rAF loop parks itself the moment the field empties and restarts on
//     the next pointer sample, so an idle window runs no timer;
//   - it pauses while the document is hidden;
//   - `pointer-events: none` plus `aria-hidden` keep it out of both hit-testing
//     and the accessibility tree.

import { useEffect, useRef, useState } from "react"
import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { getCursorPack } from "@/lib/appearance/cursor/cursor-packs"
import { useCursorAccentColor } from "@/lib/appearance/cursor/use-cursor-accent"
import {
  createSimState,
  EFFECT_SPECS,
  spawnAmbient,
  spawnBurst,
  spawnForMove,
  stepParticles,
  type SpawnOptions,
} from "@/lib/appearance/cursor/effects/particle-sim"
import { drawFrame } from "@/lib/appearance/cursor/effects/effect-renderer"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_CURSOR, type CursorSettings } from "@/types/appearance"

/** Longest frame delta the simulation will integrate, in ms. */
const MAX_FRAME_MS = 64

/**
 * Resolve the flat color the particles paint with. Returns `null` for the
 * rainbow mode, where each particle carries its own hue.
 */
export function resolveEffectColor(
  cursor: CursorSettings,
  accentColor: string | undefined
): string | null {
  switch (cursor.effect.colorMode) {
    case "rainbow":
      return null
    case "custom":
      return cursor.effect.customColor ?? accentColor ?? "#8b5cf6"
    case "pack": {
      const pack = getCursorPack(cursor.packId)
      return pack?.palette.accent ?? accentColor ?? "#8b5cf6"
    }
    case "accent":
    default:
      return accentColor ?? "#8b5cf6"
  }
}

/** True when this device has a real pointer worth decorating. */
function hasFinePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
  try {
    return !window.matchMedia("(pointer: coarse)").matches
  } catch {
    // A matchMedia implementation that throws on this query (some older
    // WebViews) shouldn't disable the feature outright.
    return true
  }
}

export function CursorEffectLayer() {
  const cursorSetting = useSettingsStore((s) => s.settings?.cursor)
  const accentColor = useCursorAccentColor()
  const { reduce } = useFlowMotion()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [finePointer, setFinePointer] = useState(false)

  // Media queries can only be read on the client; deferring to an effect also
  // keeps the server and first client render identical.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return
    const update = () => setFinePointer(hasFinePointer())
    update()
    let mql: MediaQueryList | null = null
    try {
      mql = window.matchMedia("(pointer: coarse)")
    } catch {
      return
    }
    mql.addEventListener?.("change", update)
    return () => mql?.removeEventListener?.("change", update)
  }, [])

  const cursor: CursorSettings = { ...DEFAULT_CURSOR, ...(cursorSetting ?? {}) }
  const kind = cursor.effect.kind
  const active = kind !== "none" && !reduce && finePointer

  useEffect(() => {
    const canvas = canvasRef.current
    if (!active || !canvas) return
    const spec = EFFECT_SPECS[kind as Exclude<typeof kind, "none">]
    if (!spec) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const state = createSimState()
    const flatColor = resolveEffectColor(cursor, accentColor)
    const options: SpawnOptions = {
      spec,
      intensity: cursor.effect.intensity,
      scale: cursor.effect.scale,
      rainbow: flatColor === null,
    }
    const color = flatColor ?? "#ffffff"

    let width = 0
    let height = 0
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      // Draw in CSS pixels; the transform absorbs the device ratio.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()

    let raf = 0
    let lastFrame = 0
    let running = false

    const frame = (now: number) => {
      const dt = lastFrame === 0 ? 16 : Math.min(now - lastFrame, MAX_FRAME_MS)
      lastFrame = now
      spawnAmbient(state, options, dt)
      const live = stepParticles(state, spec, dt)
      drawFrame(ctx, state, {
        spec,
        color,
        width,
        height,
        pointer: state.last,
        scale: cursor.effect.scale,
      })
      // Park when there is nothing left to animate. The halo effect keeps the
      // loop alive only while the pointer is inside the window.
      if (live === 0 && !(spec.halo && state.last)) {
        running = false
        lastFrame = 0
        return
      }
      raf = requestAnimationFrame(frame)
    }

    const start = () => {
      if (running || document.hidden) return
      running = true
      lastFrame = 0
      raf = requestAnimationFrame(frame)
    }

    let lastMoveAt = 0
    const onMove = (event: PointerEvent) => {
      const now = event.timeStamp || 0
      const dt = lastMoveAt === 0 ? 16 : Math.max(now - lastMoveAt, 1)
      lastMoveAt = now
      spawnForMove(state, options, event.clientX, event.clientY, dt)
      start()
    }
    const onDown = (event: PointerEvent) => {
      if (!cursor.effect.clickBurst) return
      spawnBurst(state, options, event.clientX, event.clientY)
      start()
    }
    const onLeave = () => {
      // Forget the pointer so the halo stops drawing and the loop can park.
      state.last = null
    }
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf)
        running = false
        lastFrame = 0
      } else if (state.particles.length > 0) {
        start()
      }
    }

    window.addEventListener("pointermove", onMove, { passive: true })
    window.addEventListener("pointerdown", onDown, { passive: true })
    window.addEventListener("pointerout", onLeave, { passive: true })
    window.addEventListener("blur", onLeave)
    window.addEventListener("resize", resize)
    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerdown", onDown)
      window.removeEventListener("pointerout", onLeave)
      window.removeEventListener("blur", onLeave)
      window.removeEventListener("resize", resize)
      document.removeEventListener("visibilitychange", onVisibility)
      ctx.clearRect(0, 0, width, height)
    }
    // `cursor` is rebuilt each render; depend on the fields the loop reads so a
    // re-render with identical settings doesn't tear the canvas down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    active,
    kind,
    accentColor,
    cursor.packId,
    cursor.effect.intensity,
    cursor.effect.scale,
    cursor.effect.colorMode,
    cursor.effect.customColor,
    cursor.effect.clickBurst,
  ])

  if (!active) return null

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-testid="cursor-effect-layer"
      data-effect={kind}
      className="pointer-events-none fixed inset-0 z-[100] select-none"
    />
  )
}
