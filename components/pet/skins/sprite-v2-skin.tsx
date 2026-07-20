"use client"

import { useEffect, useState, type CSSProperties, type ReactNode } from "react"
import { useSettingsStore } from "@/stores/settings"
import { useActiveSpritePack } from "@/hooks/pet/use-active-sprite-pack"
import { DEFAULT_PET_SETTINGS, type PetSkin, type PetSkinRenderProps } from "@/types/pet"
import { svgSkin } from "./svg-skin"

export interface SpriteAnimation {
  row: number
  durations: readonly number[]
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
  if (props.locomotion?.mode === "walking" || props.locomotion?.mode === "climbing") {
    return ROWS[props.locomotion.facing === "left" ? 2 : 1]
  }
  if (props.locomotion?.mode === "falling") return ROWS[4]

  switch (props.oneShot) {
    case "wave":
      return ROWS[3]
    case "sad":
      return ROWS[5]
    case "happy":
    case "levelUp":
    case "evolving":
    case "surprised":
    case "land":
    case "hatch":
      return ROWS[4]
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
  return svgSkin.render(props)
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
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (props.paused || props.reducedMotion) return
    const timer = window.setTimeout(
      () => setFrame((current) => (current + 1) % animation.durations.length),
      animation.durations[frame]
    )
    return () => window.clearTimeout(timer)
  }, [animation, frame, props.paused, props.reducedMotion])

  const height = props.size
  const width = (height * 192) / 208
  const style: CSSProperties = {
    width,
    height,
    backgroundImage: `url(${assetUrl})`,
    backgroundRepeat: "no-repeat",
    backgroundSize: `${width * 8}px ${height * 11}px`,
    backgroundPosition: `${-frame * width}px ${-animation.row * height}px`,
  }

  return (
    <div
      data-pet-skin="sprite-v2"
      className="flex items-center justify-center"
      style={{ width: props.size, height: props.size }}
    >
      <div data-testid="pet-sprite-v2" aria-hidden style={style} />
    </div>
  )
}

function SpriteAtlas({
  spritesheet,
  animation,
  props,
}: {
  spritesheet: Blob
  animation: SpriteAnimation
  props: PetSkinRenderProps
}) {
  const [assetUrl, setAssetUrl] = useState<string | null>(null)
  useEffect(() => {
    const next = URL.createObjectURL(spritesheet)
    let active = true
    void Promise.resolve().then(() => {
      if (active) setAssetUrl(next)
    })
    return () => {
      active = false
      URL.revokeObjectURL(next)
    }
  }, [spritesheet])
  if (!assetUrl) return <>{fallback(props)}</>
  return (
    <AnimatedAtlas key={animation.row} assetUrl={assetUrl} animation={animation} props={props} />
  )
}

function SpriteV2Boundary(props: PetSkinRenderProps) {
  const appSettings = useSettingsStore((state) => state.settings)
  const pet = appSettings?.petSettings ?? DEFAULT_PET_SETTINGS
  const { row: pack } = useActiveSpritePack(pet)
  const animation = resolveSpriteAnimation(props)

  if (!pack) return <>{fallback(props)}</>
  return (
    <SpriteAtlas key={pack.id} spritesheet={pack.spritesheet} animation={animation} props={props} />
  )
}

export const spriteV2Skin: PetSkin = {
  id: "sprite-v2",
  render(props) {
    return <SpriteV2Boundary {...props} />
  },
}
