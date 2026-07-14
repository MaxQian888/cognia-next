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
import { extractMotionGroupCounts } from "@/lib/pet/live2d/manifest"
import { readBlobText } from "@/lib/pet/live2d/read-blob-text"
import type { Live2DManifest, Live2dCapabilities } from "@/lib/pet/live2d/types"
import {
  DEFAULT_LIVE2D_TRANSFORM,
  type Live2dMotionOverrides,
  type Live2dTransform,
  type PetSkinRenderProps,
} from "@/types/pet"
import { ensureLive2dPluginRegistered } from "@/lib/pet/live2d/register-plugin"
import { useIdleQuiescence } from "@/hooks/pet/use-idle-quiescence"
import { useLive2dMotion, type Live2dModelLike } from "./use-live2d-motion"
import { useLive2dLipSync, type Live2dLipSyncModel } from "./use-live2d-lip-sync"
import { useLive2dParamEmotion } from "./use-live2d-param-emotion"

export interface Live2dCanvasProps extends PetSkinRenderProps {
  modelId: string
  /** Low-power mode: 30fps ticker cap (update + render) plus init-time
   * antialias off, `powerPreference: "low-power"`, and low-precision masks. */
  lowPower?: boolean
  /** Per-model user transform applied on top of the fit (normalized). */
  transform?: Live2dTransform
  /** Per-model state→motion/expression overrides. */
  motionOverrides?: Live2dMotionOverrides
  /** True while a speech bubble is showing — drives the lip-sync mouth flap. */
  speaking?: boolean
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
  ticker: {
    stop: () => void
    start: () => void
    add: (fn: () => void, context?: unknown, priority?: number) => void
    remove: (fn: () => void, context?: unknown) => void
    maxFPS?: number
  }
  init: (opts: Record<string, unknown>) => Promise<void>
  render: () => void
  destroy: (removeView?: boolean, opts?: Record<string, unknown>) => void
}

/** Ticker caps: 60fps default, 30fps in low-power mode. */
const MAX_FPS_DEFAULT = 60
const MAX_FPS_LOW_POWER = 30
/** Deep-idle cap: after a quiet stretch of plain idle, breathing still reads
 * as alive at 12fps while the SVG skin's quiescence has long since hit zero
 * rAF — this is the Live2D equivalent (the ticker never quiesced before). */
const MAX_FPS_QUIESCENT = 12

/**
 * Cap the render resolution: past 2x the extra pixels are invisible on a
 * ~100-400px pet but quadruple the fill-rate on 200%-scaled Windows displays.
 */
const MAX_RESOLUTION = 2

/** pixi's UPDATE_PRIORITY.LOW — keeps the guarded render AFTER the model's
 * ticker update (the Automator adds at NORMAL), same slot pixi's own
 * auto-render uses. Mirrored numerically so pixi stays out of this module's
 * static graph. */
const RENDER_PRIORITY_LOW = -25

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
 * Fit a model into a square box of `size` px, centered, then apply the user's
 * per-model transform (scale multiplier + offsets as canvas-size fractions).
 * Facing left mirrors the model by negating the X scale (the canvas buffer
 * stays untouched).
 * NOTE: `model.width/height` reflect the CURRENT scale, so the fit scale must
 * be derived from the unscaled bounds — read them with scale reset to 1.
 */
function fitModel(
  model: PixiModelLike,
  size: number,
  facing: "left" | "right" = "right",
  transform: Live2dTransform = DEFAULT_LIVE2D_TRANSFORM
): void {
  model.anchor?.set(0.5, 0.5)
  model.scale?.set(1, 1)
  const largest = Math.max(model.width, model.height)
  const scale = (largest > 0 ? size / largest : 1) * transform.scale
  model.scale?.set(facing === "left" ? -scale : scale, scale)
  model.position?.set(size / 2 + transform.offsetX * size, size / 2 + transform.offsetY * size)
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
  transform,
  motionOverrides,
  speaking = false,
  onError,
}: Live2dCanvasProps) {
  const ready = useStrictModeSafeInit()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const appRef = useRef<PixiAppLike | null>(null)
  const [model, setModel] = useState<PixiModelLike | null>(null)
  const [caps, setCaps] = useState<Live2dCapabilities>({
    motionGroups: [],
    expressionIds: [],
  })

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
        // Register the Live2D render pipe with pixi BEFORE the renderer is built
        // by `init()`, so the engine doesn't lazily self-register and warn every
        // frame — under `next dev` that per-frame warning floods the forwarded
        // console buffer until the dev server OOMs. Best-effort: a registration
        // hiccup must not break rendering (the engine still lazy-registers).
        await ensureLive2dPluginRegistered().catch(() => {})
        if (cancelled) return
        // High-DPI: render at the device pixel ratio with autoDensity keeping
        // the CSS size logical. Antialias is an init-time-only knob — low-power
        // mode trades it away (a runtime toggle would rebuild the WebGL context).
        await app.init({
          canvas,
          width: size,
          height: size,
          backgroundAlpha: 0,
          antialias: !lowPowerRef.current,
          resolution:
            typeof window !== "undefined"
              ? Math.min(window.devicePixelRatio || 1, MAX_RESOLUTION)
              : 1,
          autoDensity: true,
          // Dual-GPU machines otherwise route the transparent-window WebGL
          // context to whatever the OS default is; be explicit both ways.
          powerPreference: lowPowerRef.current ? "low-power" : "high-performance",
        })
        if (cancelled) return
        appRef.current = app

        // pixi auto-renders by adding `app.render` to the ticker (TickerPlugin,
        // LOW priority). Swap it for a guarded render: a throw inside the Live2D
        // engine's render loop — e.g. a texture whose GPU source was invalidated
        // by WebGL context loss ("null is not an object (evaluating
        // 'texture.source')") — fires every frame inside the ticker's rAF
        // callback, which neither the React error boundary (sync renders only)
        // nor the async-load `onError` path can catch. Catching it here halts the
        // runaway crash loop and degrades to the SVG skin via the same typed-code
        // channel as load failures.
        const guardedApp = app
        guardedApp.ticker.remove(guardedApp.render, guardedApp)
        guardedApp.ticker.add(
          () => {
            try {
              guardedApp.render()
            } catch {
              guardedApp.ticker.stop()
              onErrorRef.current?.("renderFailed")
            }
          },
          undefined,
          RENDER_PRIORITY_LOW
        )

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
        const result = await loader.load({
          manifest,
          entries,
          modelOptions: {
            // Drive the Cubism update off the APP ticker instead of the
            // engine's default `Ticker.shared`: paused/reducedMotion (ticker
            // stop) and the low-power 30fps cap then govern the per-frame
            // CPU work (physics, deformers, parameters) too — on the shared
            // ticker that work runs uncapped forever, even hidden — and
            // update+render collapse into a single rAF loop.
            ticker: app.ticker,
            // The pet has its own hit-zone system (resolveHitZone); the
            // engine's global pointer listeners (hit-test per tap, focus
            // smoothing per pointermove) are pure overhead here.
            autoHitTest: false,
            autoFocus: false,
            // The pet draws at ~100-400px; sample a downscaled atlas instead
            // of the full-resolution art every frame. Threshold lowered from
            // the 4096 default so common 2048px atlases benefit too.
            textureOptions: { lod: "single-auto", lodTextureSizeThreshold: 1024 },
            // Low-power additionally skips the high-precision mask path
            // ('auto' can enable it on complex models); artifacts are
            // invisible at pet size.
            ...(lowPowerRef.current ? { useHighPrecisionMask: false } : {}),
          },
        })
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
        // Motion counts per group power the "random index" override option;
        // read from the stored settings blob so legacy rows work too.
        let motionGroupCounts: Record<string, number> = {}
        try {
          const settingsEntry = entries.find((e) => e.path === row.settingsPath)
          if (settingsEntry) {
            motionGroupCounts = extractMotionGroupCounts(await readBlobText(settingsEntry.blob))
          }
        } catch {
          // Counts are best-effort — the hook falls back to index 0.
        }
        if (cancelled) {
          // The cleanup already ran: it disposed `dispose`/destroyed the app,
          // but this load finished after — drop the late state writes.
          return
        }
        setCaps({
          motionGroups: row.motionGroups,
          expressionIds: row.expressionIds,
          motionGroupCounts,
        })
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

  // Resize + re-fit on size/facing/transform change without rebuilding the
  // model — this is what makes the transform editor's live preview cheap.
  useEffect(() => {
    const app = appRef.current
    if (!app || !model) return
    app.renderer.resize(size, size)
    fitModel(model, size, facing, transform)
  }, [size, model, facing, transform])

  // Reduced motion / paused (hidden window, minimized widget) stops the ticker.
  useEffect(() => {
    const app = appRef.current
    if (!app) return
    if (reducedMotion || paused) app.ticker.stop()
    else app.ticker.start()
  }, [reducedMotion, paused, model])

  // FPS cap follows the low-power setting live (unlike antialias), dropping
  // further after a quiet idle stretch (same trigger as the SVG skin's
  // quiescence) — the Cubism update + render both ride this ticker.
  const quiescent = useIdleQuiescence(state, oneShot, lowPower)
  useEffect(() => {
    const app = appRef.current
    if (!app) return
    app.ticker.maxFPS = quiescent
      ? MAX_FPS_QUIESCENT
      : lowPower
        ? MAX_FPS_LOW_POWER
        : MAX_FPS_DEFAULT
  }, [lowPower, quiescent, model])

  useLive2dMotion(
    model,
    state,
    oneShot,
    caps,
    reducedMotion,
    locomotion?.mode === "walking",
    motionOverrides
  )

  // Ambient head/eye envelopes for the idle-collapsed AI states
  // (thinking/waiting/review) — skipped while paused (no frames fire).
  useLive2dParamEmotion(
    model as unknown as Live2dLipSyncModel | null,
    state,
    oneShot,
    reducedMotion || Boolean(paused)
  )

  // Mouth flap while a bubble is up. Skip when paused (ticker stopped → no frames)
  // so we don't register a handler that can never fire.
  useLive2dLipSync(
    model as unknown as Live2dLipSyncModel | null,
    speaking && !paused,
    reducedMotion
  )

  return (
    <canvas ref={canvasRef} data-pet-skin-root="live2d" style={{ width: size, height: size }} />
  )
}
