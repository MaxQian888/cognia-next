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
  /** Reports a typed failure so the boundary can degrade to the SVG skin. */
  onError?: (code: string) => void
}

/** A loaded pixi model exposing the bits the canvas positions + drives. */
interface PixiModelLike extends Live2dModelLike {
  width: number
  height: number
  anchor?: { set: (x: number, y: number) => void }
  position?: { set: (x: number, y: number) => void }
  scale?: { set: (v: number) => void }
}

interface PixiAppLike {
  stage: { addChild: (child: unknown) => void }
  renderer: { resize: (w: number, h: number) => void }
  ticker: { stop: () => void; start: () => void }
  init: (opts: Record<string, unknown>) => Promise<void>
  destroy: (removeView?: boolean, opts?: Record<string, unknown>) => void
}

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

/** Fit a model into a square box of `size` px, centered. */
function fitModel(model: PixiModelLike, size: number): void {
  model.anchor?.set(0.5, 0.5)
  model.position?.set(size / 2, size / 2)
  const largest = Math.max(model.width, model.height)
  const scale = largest > 0 ? size / largest : 1
  model.scale?.set(scale)
}

export default function Live2dCanvas({
  modelId,
  state,
  oneShot,
  reducedMotion,
  size,
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
        await app.init({ canvas, width: size, height: size, backgroundAlpha: 0, antialias: true })
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

  // Resize + re-fit on size change without rebuilding the model.
  useEffect(() => {
    const app = appRef.current
    if (!app || !model) return
    app.renderer.resize(size, size)
    fitModel(model, size)
  }, [size, model])

  // Reduced motion pauses/resumes the pixi ticker.
  useEffect(() => {
    const app = appRef.current
    if (!app) return
    if (reducedMotion) app.ticker.stop()
    else app.ticker.start()
  }, [reducedMotion, model])

  useLive2dMotion(model, state, oneShot, caps, reducedMotion)

  return (
    <canvas ref={canvasRef} data-pet-skin-root="live2d" style={{ width: size, height: size }} />
  )
}
