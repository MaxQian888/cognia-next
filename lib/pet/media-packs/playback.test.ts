import { planMediaMotion, mediaFrameAt } from "./playback"
import type { MediaPackManifest } from "./manifest"
import type { PetSkinRenderProps } from "@/types/pet"
const clip = {
  kind: "frames" as const,
  frames: ["0.webp", "1.webp", "2.webp"],
  frameMs: 42,
  loop: true,
}
const manifest: MediaPackManifest = {
  version: 1,
  displayName: "Whale",
  source: "dsh-frames",
  width: 412,
  height: 344,
  clips: {
    idle: clip,
    drag: clip,
    think: clip,
    success: { ...clip, loop: false },
    walk: clip,
    pat: { ...clip, loop: false },
  },
  states: {
    idle: ["idle"],
    held: ["drag"],
    thinking: ["think"],
    happy: ["success"],
    walking: ["walk"],
    pet: ["pat"],
  },
  ambient: [],
}
const props = {
  bones: {},
  stage: "baby",
  state: "thinking",
  oneShot: null,
  reducedMotion: false,
  size: 256,
} as PetSkinRenderProps
it("prioritizes held, interaction, locomotion then semantic task state", () => {
  expect(planMediaMotion(manifest, props).ids).toEqual(["think"])
  expect(
    planMediaMotion(manifest, { ...props, locomotion: { mode: "walking", facing: "left" } }).ids
  ).toEqual(["walk"])
  expect(
    planMediaMotion(manifest, {
      ...props,
      oneShot: "wave",
      locomotion: { mode: "walking", facing: "left" },
    }).ids
  ).toEqual(["pat"])
  expect(planMediaMotion(manifest, { ...props, held: true, oneShot: "wave" }).ids).toEqual(["drag"])
})
it("falls back to idle and lets a completion play only once", () => {
  expect(planMediaMotion(manifest, { ...props, state: "unwell" }).ids).toEqual(["idle"])
  expect(planMediaMotion(manifest, { ...props, state: "happy" }).repeat).toBe(false)
})
it("uses wall time and clamps at the final frame instead of wrapping a one-shot", () => {
  expect(mediaFrameAt(clip, 83)).toEqual({ index: 1, ended: false })
  expect(mediaFrameAt(clip, 126)).toEqual({ index: 2, ended: true })
})
