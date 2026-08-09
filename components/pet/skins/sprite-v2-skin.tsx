"use client"

import { useEffect, useState, type CSSProperties, type ReactNode } from "react"
import type { PetSkin, PetSkinRenderProps } from "@/types/pet"
import { PET_SKIN_CAPABILITIES, quantizeSpriteLookDirection } from "@/lib/pet/skin-governance"
import { loadSpriteSkinAsset } from "@/lib/pet/skin-assets"
import { getPetSkinRuntime } from "@/lib/pet/skin-runtime"
import { svgSkin } from "./svg-skin"

export interface SpriteAnimation {
  row: number
  durations: readonly number[]
  fixedFrame?: number
}

const ROWS: readonly SpriteAnimation[] = [
  { row: 0, durations: [280, 110, 110, 140, 140, 320] },
  { row: 1, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  { row: 2, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  { row: 3, durations: [140, 140, 140, 280] },
  { row: 4, durations: [140, 140, 140, 140, 280] },
  { row: 5, durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  { row: 6, durations: [150, 150, 150, 150, 150, 260] },
  { row: 7, durations: [120, 120, 120, 120, 120, 220] },
  { row: 8, durations: [150, 150, 150, 150, 150, 280] },
]

/** Map Cognia's richer semantic state model onto the v2 atlas contract. */
export function resolveSpriteAnimation(props: PetSkinRenderProps): SpriteAnimation {
  if (props.held) return ROWS[0]
  if (props.oneShot) {
    switch (props.oneShot) {
      case "wave":
        return ROWS[3]
      case "sad":
      case "sleepy":
        return ROWS[5]
      default:
        return ROWS[4]
    }
  }
  if (props.locomotion?.mode === "walking" || props.locomotion?.mode === "climbing") {
    return ROWS[props.locomotion.facing === "left" ? 2 : 1]
  }
  if (props.locomotion?.mode === "falling") return ROWS[4]

  if (props.state === "idle" && props.lookTarget && !props.reducedMotion && !props.paused) {
    const look = quantizeSpriteLookDirection(props.lookTarget)
    if (look) return { row: look.row, durations: [1], fixedFrame: look.frame }
  }

  switch (props.state) {
    case "waiting":
      return ROWS[6]
    case "review":
      return ROWS[8]
    case "thinking":
    case "interacting":
    case "evolving":
      return ROWS[7]
    case "error":
    case "sad":
    case "unwell":
      return ROWS[5]
    case "greeting":
      return ROWS[3]
    case "happy":
      return ROWS[4]
    case "idle":
    case "sleeping":
      return ROWS[0]
  }
}

function fallback(props: PetSkinRenderProps): ReactNode {
  return svgSkin.render({ ...props, selection: { skinId: "svg" } })
}

function AnimatedAtlas({
  assetUrl,
  animation,
  props,
}: {
  assetUrl: string
  animation: SpriteAnimation
  props: PetSkinRenderProps
}) {
  const [frame, setFrame] = useState(animation.fixedFrame ?? 0)
  useEffect(() => {
    if (props.paused || props.reducedMotion || animation.fixedFrame !== undefined) return
    const runtime = getPetSkinRuntime()
    const releaseTimer = runtime.track("timers")
    const timer = window.setTimeout(
      () => setFrame((current) => (current + 1) % animation.durations.length),
      animation.durations[frame]
    )
    return () => {
      window.clearTimeout(timer)
      releaseTimer()
    }
  }, [animation, frame, props.paused, props.reducedMotion])

  const height = props.size
  const width = (height * 192) / 208
  const filter = [
    props.mood === "lonely" ? "saturate(.72)" : undefined,
    props.flavor === "radiant"
      ? "saturate(1.25)"
      : props.flavor === "plain"
        ? "saturate(.78)"
        : undefined,
    props.speaking ? "brightness(1.08)" : undefined,
  ]
    .filter(Boolean)
    .join(" ")
  const style: CSSProperties = {
    width,
    height,
    backgroundImage: `url(${assetUrl})`,
    backgroundRepeat: "no-repeat",
    backgroundSize: `${width * 8}px ${height * 11}px`,
    backgroundPosition: `${-frame * width}px ${-animation.row * height}px`,
    filter: filter || undefined,
    transform: props.held ? "rotate(7deg) translateY(3%)" : undefined,
  }

  return (
    <div
      data-pet-skin="sprite-v2"
      data-pet-held={props.held || undefined}
      data-pet-speaking={props.speaking || undefined}
      data-pet-mood={props.mood}
      data-pet-flavor={props.flavor}
      className="flex items-center justify-center"
      style={{ width: props.size, height: props.size }}
    >
      <div data-testid="pet-sprite-v2" aria-hidden style={style} />
    </div>
  )
}

function SpriteV2Boundary(props: PetSkinRenderProps) {
  const packId = props.selection?.skinId === "sprite-v2" ? props.selection.packId : undefined
  const [asset, setAsset] = useState<{ packId: string; url: string } | null>(null)
  const gazeActive =
    props.state === "idle" && Boolean(props.lookTarget) && !props.reducedMotion && !props.paused
  const lookSample = gazeActive
    ? `${props.lookTarget?.x}:${props.lookTarget?.y}:${props.lookTarget?.updatedAt}`
    : ""
  const [lookState, setLookState] = useState<{
    sample: string
    index?: number
    cell?: ReturnType<typeof quantizeSpriteLookDirection>
  }>({ sample: "" })
  if (lookState.sample !== lookSample) {
    const cell =
      gazeActive && props.lookTarget
        ? quantizeSpriteLookDirection(props.lookTarget, { previousIndex: lookState.index })
        : null
    setLookState({ sample: lookSample, index: cell?.index, cell })
  }
  useEffect(() => {
    let active = true
    if (!packId) return
    void loadSpriteSkinAsset(packId).then((pack) => {
      if (!active || !pack) return
      const runtime = getPetSkinRuntime()
      setAsset({ packId, url: runtime.objectUrl(`sprite-v2:${packId}`, pack.spritesheet) })
    })
    return () => {
      active = false
    }
  }, [packId])

  useEffect(() => {
    if (!packId || asset?.packId !== packId || typeof Image === "undefined") return
    let active = true
    const image = new Image()
    image.onload = () => {
      if (!active) return
      try {
        const canvas = document.createElement("canvas")
        canvas.width = 192
        canvas.height = 208
        const context = canvas.getContext("2d")
        if (!context) return
        context.drawImage(image, 0, 0, 192, 208, 0, 0, 192, 208)
        getPetSkinRuntime().publishSnapshot(`sprite-v2:${packId}`, canvas.toDataURL("image/png"))
      } catch {
        // Snapshot capture is an optimization; the live atlas remains usable.
      }
    }
    image.src = asset.url
    return () => {
      active = false
      image.onload = null
    }
  }, [asset, packId])

  if (!packId || asset?.packId !== packId) return <>{fallback(props)}</>
  let animation = resolveSpriteAnimation({ ...props, lookTarget: null })
  const look = lookState.sample === lookSample ? lookState.cell : undefined
  if (look) animation = { row: look.row, durations: [1], fixedFrame: look.frame }
  return (
    <AnimatedAtlas
      key={`${animation.row}:${animation.fixedFrame ?? "animated"}`}
      assetUrl={asset.url}
      animation={animation}
      props={props}
    />
  )
}

export const spriteV2Skin: PetSkin = {
  id: "sprite-v2",
  capabilities: PET_SKIN_CAPABILITIES["sprite-v2"],
  render(props) {
    return <SpriteV2Boundary {...props} />
  },
}
