import type { PetSkinRenderProps } from "@/types/pet"
import type { MediaClip, MediaPackManifest } from "./manifest"

export interface MediaMotionPlan {
  key: string
  ids: string[]
  repeat: boolean
}
export function planMediaMotion(
  manifest: MediaPackManifest,
  props: PetSkinRenderProps
): MediaMotionPlan {
  const pool = (state: string) => manifest.states[state]
  let state = props.state as string
  if (props.held && pool("held")) state = "held"
  else if (props.oneShot)
    state = pool(props.oneShot) ? props.oneShot : pool("pet") ? "pet" : "happy"
  else if (
    props.locomotion &&
    ["walking", "climbing"].includes(props.locomotion.mode) &&
    pool("walking")
  )
    state = "walking"
  else if (props.locomotion?.mode === "falling" && pool("held")) state = "held"
  const ids = pool(state) ?? pool("idle")
  return {
    key: `${state}:${props.oneShot ?? ""}`,
    ids,
    repeat: (state === "held" || !props.oneShot) && ids.some((id) => manifest.clips[id].loop),
  }
}
export function mediaFrameAt(
  clip: Exclude<MediaClip, { kind: "video" }>,
  elapsedMs: number
): { index: number; ended: boolean } {
  const count = clip.kind === "frames" ? clip.frames.length : clip.frameCount
  const frame = Math.max(0, Math.floor(elapsedMs / clip.frameMs))
  return { index: Math.min(count - 1, frame), ended: frame >= count }
}
