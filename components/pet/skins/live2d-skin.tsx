// The Live2D PetSkin entry. `render()` returns a boundary client component that
// resolves the active model and lazy-loads the heavy pixi/Cubism canvas inside a
// Suspense + class ErrorBoundary. Any failure (no active model, lazy-chunk error,
// runtime load error) degrades to the SVG skin's content so the pet always draws.
// Registered eagerly in registry.ts — this module stays bundle-light because the
// canvas is only pulled in via React.lazy at render time.

"use client"

import { Component, lazy, Suspense, useMemo, useState, type ReactNode } from "react"
import type { PetSkin, PetSkinRenderProps } from "@/types/pet"
import { useSettingsStore } from "@/stores/settings"
import { usePetStore } from "@/stores/pet/pet-store"
import { DEFAULT_PET_SETTINGS } from "@/types/pet"
import { normalizeTransform } from "@/lib/pet/live2d/transform"
import { useActiveLive2dModel } from "@/hooks/pet/use-active-live2d-model"
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

  render(): ReactNode {
    if (this.state.failed) return this.props.fallback
    return this.props.children
  }
}

function Live2dSkinBoundary(props: PetSkinRenderProps) {
  const settings = useSettingsStore((s) => s.settings)
  const pet = settings?.petSettings ?? DEFAULT_PET_SETTINGS
  const { modelId, row } = useActiveLive2dModel(pet)
  // A visible bubble means the pet is "talking" → drive the Live2D mouth flap.
  const speaking = usePetStore((s) => s.bubble !== null)
  const fallback = svgFallback(props)

  // Async load failures (missing row, bad blob, engine/core init failure) report
  // a typed code through the canvas's `onError`; without this flag the canvas
  // would keep rendering an empty transparent surface instead of degrading.
  const [loadFailed, setLoadFailed] = useState(false)
  // Reset the failure flag the render the active model changes (a new model
  // deserves a fresh attempt) — React's documented "adjust state during render"
  // pattern, which avoids a setState-in-effect cascade.
  const [prevModelId, setPrevModelId] = useState(modelId)
  if (modelId !== prevModelId) {
    setPrevModelId(modelId)
    setLoadFailed(false)
  }

  // Per-model customization rides the reactive row (liveQuery re-emits on
  // save, so editor changes reach the live pet immediately). Memoized so the
  // canvas's re-fit effect doesn't churn on unrelated renders.
  const transform = useMemo(() => normalizeTransform(row?.transform), [row?.transform])

  // No active model (or a load that already failed) → render the SVG fallback
  // directly (no lazy chunk needed).
  if (!modelId || loadFailed) return <>{fallback}</>

  return (
    <Live2dErrorBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <Live2dCanvas
          {...props}
          modelId={modelId}
          lowPower={pet.lowPower ?? false}
          transform={transform}
          motionOverrides={row?.motionOverrides}
          speaking={speaking}
          onError={() => setLoadFailed(true)}
        />
      </Suspense>
    </Live2dErrorBoundary>
  )
}

export const live2dSkin: PetSkin = {
  id: "live2d",
  render(props: PetSkinRenderProps) {
    return <Live2dSkinBoundary {...props} />
  },
}
