// Renders a stored Live2D model onto a pixi.js canvas. Heavy deps (pixi.js + the
// Cubism engine) are never statically imported here — pixi is `await import`ed
// and the engine import lives inside `createLive2dLoader`, so this module stays
// out of the main bundle until the live2d skin actually renders.
//
// Lifecycle: a strict-mode-safe rAF ready gate (mirrors persona.tsx) defers init
// one frame so React's double-mount never spins up two WebGL contexts. The async
// init is guarded by a cancelled flag re-checked after every await; any failure
// reports a typed code via `onError` and renders nothing. Cleanup disposes the
// model (revoking object URLs via the loader) and destroys the pixi app.

"use client"

import { useEffect, useRef, useState } from "react"
import { createLive2dLoader } from "@/lib/pet/live2d/loader"
import { getPetModel, getPetModelEntries } from "@/lib/db/pet-models"
import type { Live2DManifest } from "@/lib/pet/live2d/types"
import type { PetSkinRenderProps } from "@/types/pet"
import { useLive2dMotion, type Live2dModelLike } from "./use-live2d-motion"

export interface Live2dCanvasProps extends PetSkinRenderProps {
  modelId: string
  /** Low-power mode: 30fps ticker cap + antialias off (init-time). */
  lowPower?: boolean
  /** Reports a typed failure so the boundary can degrade to the SVG skin. */
  onError?: (code: string) => void
}

/** A loaded pixi model exposing the bits the canvas positions + drives. */
interface PixiModelLike extends Live2dModelLike {
  width: number
  height: number
  anchor?: { set: (x: number, y: number) => void }
  position?: { set: (x: number, y: number) => void }
  scale?: { set: (x: number, y?: number) => void }
}

interface PixiAppLike {
  stage: { addChild: (child: unknown) => void }
  renderer: { resize: (w: number, h: number) => void }
  ticker: { stop: () => void; start: () => void; maxFPS?: number }
  init: (opts: Record<string, unknown>) => Promise<void>
  destroy: (removeView?: boolean, opts?: Record<string, unknown>) => void
}

/** Ticker caps: 60fps default, 30fps in low-power mode. */
const MAX_FPS_DEFAULT = 60
const MAX_FPS_LOW_POWER = 30

const useStrictModeSafeInit = () => {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true))
    return () => {
      cancelAnimationFrame(id)
      setReady(false)
    }
  }, [])
  return ready
}

/**
 * Fit a model into a square box of `size` px, centered. Facing left mirrors
 * the model by negating the X scale (the canvas buffer stays untouched).
 * NOTE: `model.width/height` reflect the CURRENT scale, so the fit scale must
 * be derived from the unscaled bounds — read them with scale reset to 1.
 */
function fitModel(model: PixiModelLike, size: number, facing: "left" | "right" = "right"): void {
  model.anchor?.set(0.5, 0.5)
  model.position?.set(size / 2, size / 2)
  model.scale?.set(1, 1)
  const largest = Math.max(model.width, model.height)
  const scale = largest > 0 ? size / largest : 1
  model.scale?.set(facing === "left" ? -scale : scale, scale)
}

export default function Live2dCanvas({
  modelId,
  state,
  oneShot,
  reducedMotion,
  size,
  locomotion,
  paused,
  lowPower = false,
  onError,
}: Live2dCanvasProps) {
  const ready = useStrictModeSafeInit()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const appRef = useRef<PixiAppLike | null>(null)
  const [model, setModel] = useState<PixiModelLike | null>(null)
  const [caps, setCaps] = useState({ motionGroups: [] as string[], expressionIds: [] as string[] })

  // Report errors through a ref so the async init closure doesn't capture a
  // stale callback and so changing `onError` never re-runs the heavy effect.
  const onErrorRef = useRef(onError)
  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])

  // Same ref treatment for the antialias knob: only the value at init matters.
  const lowPowerRef = useRef(lowPower)
  useEffect(() => {
    lowPowerRef.current = lowPower
  }, [lowPower])

  useEffect(() => {
    if (!ready) return
    const canvas = canvasRef.current
    if (!canvas) return

    let cancelled = false
    let app: PixiAppLike | null = null
    let dispose: (() => void) | null = null

    async function init() {
      try {
        const row = await getPetModel(modelId)
        if (cancelled) return
        if (!row) {
          onErrorRef.current?.("modelMissing")
          return
        }

        const { Application } = (await import("pixi.js")) as unknown as {
          Application: new () => PixiAppLike
        }
        if (cancelled) return
        app = new Application()
        // High-DPI: render at the device pixel ratio with autoDensity keeping
        // the CSS size logical. Antialias is an init-time-only knob — low-power
        // mode trades it away (a runtime toggle would rebuild the WebGL context).
        await app.init({
          canvas,
          width: size,
          height: size,
          backgroundAlpha: 0,
          antialias: !lowPowerRef.current,
          resolution: typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
          autoDensity: true,
        })
        if (cancelled) return
        appRef.current = app

        const entries = await getPetModelEntries(modelId)
        if (cancelled) return

        // The loader only reads `settingsPath` off the manifest; the remaining
        // resource paths are resolved from the entries at replace time, so a
        // minimal manifest reconstructed from the row is sufficient.
        const manifest: Live2DManifest = {
          kind: "modern",
          settingsPath: row.settingsPath,
          mocPath: "",
          texturePaths: [],
          motionGroups: row.motionGroups,
          expressionIds: row.expressionIds,
        }

        const loader = createLive2dLoader()
        const result = await loader.load({ manifest, entries })
        if (cancelled) {
          if (result.ok) result.dispose()
          return
        }
        if (!result.ok) {
          onErrorRef.current?.(result.code)
          return
        }

        dispose = result.dispose
        const loaded = result.model as PixiModelLike
        fitModel(loaded, size)
        app.stage.addChild(loaded)
        setCaps({ motionGroups: row.motionGroups, expressionIds: row.expressionIds })
        setModel(loaded)
      } catch {
        if (!cancelled) onErrorRef.current?.("modelFailed")
      }
    }

    void init()

    return () => {
      cancelled = true
      setModel(null)
      try {
        dispose?.()
      } catch {
        // Best-effort — disposing a half-built model must never throw on unmount.
      }
      try {
        app?.destroy(true, { children: true })
      } catch {
        // Same: pixi teardown is best-effort.
      }
      appRef.current = null
    }
    // `size` is intentionally omitted — resizing is handled by the resize effect
    // below so a slider drag doesn't tear down and rebuild the whole model.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, modelId])

  const facing = locomotion?.facing ?? "right"

  // Resize + re-fit on size/facing change without rebuilding the model.
  useEffect(() => {
    const app = appRef.current
    if (!app || !model) return
    app.renderer.resize(size, size)
    fitModel(model, size, facing)
  }, [size, model, facing])

  // Reduced motion / paused (hidden window, minimized widget) stops the ticker.
  useEffect(() => {
    const app = appRef.current
    if (!app) return
    if (reducedMotion || paused) app.ticker.stop()
    else app.ticker.start()
  }, [reducedMotion, paused, model])

  // FPS cap follows the low-power setting live (unlike antialias).
  useEffect(() => {
    const app = appRef.current
    if (!app) return
    app.ticker.maxFPS = lowPower ? MAX_FPS_LOW_POWER : MAX_FPS_DEFAULT
  }, [lowPower, model])

  useLive2dMotion(model, state, oneShot, caps, reducedMotion, locomotion?.mode === "walking")

  return (
    <canvas ref={canvasRef} data-pet-skin-root="live2d" style={{ width: size, height: size }} />
  )
}
