// The Live2D PetSkin entry. `render()` returns a boundary client component that
// resolves the active model and lazy-loads the heavy pixi/Cubism canvas inside a
// Suspense + class ErrorBoundary. Any failure (no active model, lazy-chunk error,
// runtime load error) degrades to the SVG skin's content so the pet always draws.
// Registered eagerly in registry.ts — this module stays bundle-light because the
// canvas is only pulled in via React.lazy at render time.

"use client"

import { Component, lazy, Suspense, useState, useSyncExternalStore, type ReactNode } from "react"
import type { PetSkin, PetSkinRenderProps } from "@/types/pet"
import { PET_SKIN_CAPABILITIES } from "@/lib/pet/skin-governance"
import { getPetSkinRuntime } from "@/lib/pet/skin-runtime"
// Import the SVG skin directly (not via the registry) — the registry imports
// this module, so going through `getSkin` would form an init-time cycle.
import { svgSkin } from "./svg-skin"

const Live2dCanvas = lazy(() => import("./live2d/live2d-canvas"))

/** SVG-skin content used as the universal fallback. */
function svgFallback(props: PetSkinRenderProps): ReactNode {
  return svgSkin.render(props)
}

interface BoundaryProps {
  children: ReactNode
  fallback: ReactNode
  onError?: () => void
}

interface BoundaryState {
  failed: boolean
}

/**
 * Catches a SYNCHRONOUS render/runtime error from the lazy canvas (e.g. a failed
 * lazy chunk) and shows the SVG fallback. The canvas's ASYNCHRONOUS load failures
 * never throw — they report a typed code through `onError`, which `Live2dSkinBoundary`
 * turns into the same fallback via its own `loadFailed` flag.
 */
class Live2dErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false }

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true }
  }

  componentDidCatch(): void {
    this.props.onError?.()
  }

  render(): ReactNode {
    if (this.state.failed) return this.props.fallback
    return this.props.children
  }
}

function Live2dSkinBoundary(props: PetSkinRenderProps) {
  const modelId = props.selection?.skinId === "live2d" ? props.selection.modelId : undefined
  const fallback = svgFallback(props)
  const runtime = getPetSkinRuntime()
  useSyncExternalStore(runtime.subscribe, runtime.snapshotRevision, runtime.snapshotRevision)
  const assetKey = modelId ? `live2d:${modelId}` : "live2d:missing"
  const attemptKey = `${assetKey}:${runtime.retryGeneration(assetKey)}`

  // Async load failures (missing row, bad blob, engine/core init failure) report
  // a typed code through the canvas's `onError`; without this flag the canvas
  // would keep rendering an empty transparent surface instead of degrading.
  const [loadFailed, setLoadFailed] = useState(false)
  // Reset the failure flag the render the active model changes (a new model
  // deserves a fresh attempt) — React's documented "adjust state during render"
  // pattern, which avoids a setState-in-effect cascade.
  const [previousAttemptKey, setPreviousAttemptKey] = useState(attemptKey)
  if (attemptKey !== previousAttemptKey) {
    setPreviousAttemptKey(attemptKey)
    setLoadFailed(false)
  }

  // Per-model customization rides the reactive row (liveQuery re-emits on
  // save, so editor changes reach the live pet immediately). Memoized so the
  // canvas's re-fit effect doesn't churn on unrelated renders.
  // No active model (or a load that already failed) → render the SVG fallback
  // directly (no lazy chunk needed).
  if (!modelId || loadFailed) return <>{fallback}</>

  return (
    <div
      data-pet-skin="live2d"
      data-pet-held={props.held || undefined}
      data-pet-speaking={props.speaking || undefined}
      data-pet-mood={props.mood}
      data-pet-flavor={props.flavor}
      style={{
        width: props.size,
        height: props.size,
        transform: props.held ? "rotate(7deg) translateY(3%)" : undefined,
        filter:
          props.mood === "lonely"
            ? "saturate(.72)"
            : props.flavor === "radiant"
              ? "saturate(1.25)"
              : props.flavor === "plain"
                ? "saturate(.78)"
                : undefined,
      }}
    >
      <Live2dErrorBoundary
        fallback={fallback}
        onError={() => runtime.recordAssetFailure(assetKey, "renderFailed")}
      >
        <Suspense fallback={fallback}>
          <Live2dCanvas
            key={`${modelId}:${loadFailed ? "failed" : "ready"}`}
            {...props}
            paused={Boolean(props.paused || props.held)}
            modelId={modelId}
            onError={(code) => {
              if (code === "contextLost") {
                const recovery = runtime.recordContextLoss(assetKey)
                if (recovery.action === "retry") {
                  window.setTimeout(() => setLoadFailed(false), recovery.delayMs)
                  setLoadFailed(true)
                  return
                }
                setLoadFailed(true)
                return
              }
              runtime.recordAssetFailure(assetKey, code)
              setLoadFailed(true)
            }}
          />
        </Suspense>
      </Live2dErrorBoundary>
    </div>
  )
}

export const live2dSkin: PetSkin = {
  id: "live2d",
  capabilities: PET_SKIN_CAPABILITIES.live2d,
  render(props: PetSkinRenderProps) {
    return <Live2dSkinBoundary {...props} />
  },
}
