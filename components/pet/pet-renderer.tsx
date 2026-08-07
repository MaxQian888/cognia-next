// Public render entry for the pet. Presentational and pure-ish: pick a skin and
// draw the given bones in the given visual state. Reduced motion resolves from
// the explicit prop when provided, otherwise from the OS preference — so the
// renderer honors `prefers-reduced-motion` even when a caller forgets to pass it.

"use client"

import { memo, useEffect, useId, useState, useSyncExternalStore } from "react"
import { useReducedMotion } from "motion/react"
import Image from "next/image"
import type {
  PetBones,
  PetEvolutionFlavor,
  PetLocomotion,
  PetMood,
  PetOneShot,
  PetLookTarget,
  PetSkinSelection,
  PetStage,
  PetVisualState,
} from "@/types/pet"
import { getSkin } from "./skins/registry"
import { svgSkin } from "./skins/svg-skin"
import {
  getPetSkinRuntime,
  type PetRenderPriority,
  type PetRuntimeLease,
} from "@/lib/pet/skin-runtime"
import { PET_SKIN_CAPABILITIES, resolvePetBehaviorLayer } from "@/lib/pet/skin-governance"

export interface PetRendererProps {
  bones: PetBones
  stage: PetStage
  state: PetVisualState
  oneShot?: PetOneShot | null
  /** Force reduced motion. When undefined, falls back to the OS preference. */
  reducedMotion?: boolean
  size?: number
  skinId?: string
  /** Typed asset selection; preferred over the legacy `skinId` prop. */
  selection?: PetSkinSelection
  /** Resource-budget priority for this surface. */
  renderPriority?: PetRenderPriority
  /** Normalized local/screen pointer target. */
  lookTarget?: PetLookTarget | null
  /** Explicit low-power mode, never read by a skin from global settings. */
  lowPower?: boolean
  /** Overlay-only locomotion (walk/fall + facing). Absent = resting. */
  locomotion?: PetLocomotion | null
  /** Render a still frame (window hidden / widget minimized). */
  paused?: boolean
  /** Care-quality evolution flavor (cosmetic accent). Absent = normal. */
  flavor?: PetEvolutionFlavor
  /** Coarse mood — flavors the idle loop. */
  mood?: PetMood
  /** A speech bubble is showing — skins may lip-flap. */
  speaking?: boolean
  /** The user is holding/dragging the pet — dangle pose. */
  held?: boolean
}

export const PetRenderer = memo(function PetRenderer({
  bones,
  stage,
  state,
  oneShot = null,
  reducedMotion,
  size = 96,
  skinId,
  selection,
  renderPriority = "interactive",
  lookTarget,
  lowPower,
  locomotion,
  paused,
  flavor,
  mood,
  speaking,
  held,
}: PetRendererProps) {
  const osReduced = useReducedMotion()
  const reduced = Boolean(reducedMotion ?? osReduced)
  const resolvedSelection: PetSkinSelection = selection ?? { skinId: "svg" }
  // Durable settings use the closed PetSkinSelection union. Keep the legacy
  // registry seam for in-memory/custom renderers, but never treat an unknown
  // string as a durable asset selection.
  const skin = selection ? getSkin(selection.skinId) : getSkin(skinId)
  const capabilities = skin.capabilities ?? PET_SKIN_CAPABILITIES.svg
  const runtime = getPetSkinRuntime()
  const ownerId = useId()
  const assetKey =
    resolvedSelection.skinId === "live2d"
      ? `live2d:${resolvedSelection.modelId}`
      : resolvedSelection.skinId === "sprite-v2"
        ? `sprite-v2:${resolvedSelection.packId}`
        : "svg"
  const [lease, setLease] = useState<PetRuntimeLease | null>(null)
  useSyncExternalStore(runtime.subscribe, runtime.snapshotRevision, runtime.snapshotRevision)
  useEffect(() => {
    const next = runtime.acquireLease(ownerId, renderPriority, assetKey)
    setLease(next)
    return () => next.release()
  }, [assetKey, ownerId, renderPriority, runtime])
  const renderMode = lease?.mode() ?? "placeholder"
  const snapshot = renderMode === "snapshot" ? lease?.snapshot() : undefined
  const behaviorLayer = resolvePetBehaviorLayer({
    suspended: Boolean(paused || renderMode !== "live"),
    reduced,
    held,
    oneShot: oneShot !== null,
    locomotion: Boolean(locomotion && locomotion.mode !== "resting"),
    semanticState: state !== "idle",
    gaze: Boolean(lookTarget),
  })

  const renderProps = {
    bones,
    stage,
    state: behaviorLayer === "semanticState" ? state : ("idle" as const),
    oneShot: behaviorLayer === "oneShot" && capabilities.oneShots ? oneShot : null,
    reducedMotion: reduced,
    size,
    locomotion:
      behaviorLayer === "locomotion" && capabilities.locomotion
        ? (locomotion ?? undefined)
        : undefined,
    paused: Boolean(paused || (resolvedSelection.skinId === "svg" && renderMode !== "live")),
    flavor: capabilities.flavor ? flavor : undefined,
    mood: capabilities.mood ? mood : undefined,
    speaking: capabilities.speaking ? speaking : false,
    held: behaviorLayer === "held" && capabilities.heldPose ? held : false,
    selection: resolvedSelection,
    renderMode,
    lookTarget: behaviorLayer === "gaze" && capabilities.gaze ? lookTarget : null,
    lowPower,
  }
  if (snapshot) {
    return (
      <Image
        src={snapshot}
        width={size}
        height={size}
        alt=""
        aria-hidden
        unoptimized
        data-pet-render-mode="snapshot"
      />
    )
  }
  if (renderMode === "placeholder" && resolvedSelection.skinId !== "svg") {
    return <>{svgSkin.render({ ...renderProps, selection: { skinId: "svg" }, paused: true })}</>
  }
  return <>{skin.render(renderProps)}</>
})
