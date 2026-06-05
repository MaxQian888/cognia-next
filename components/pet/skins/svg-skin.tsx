// The default SVG skin: composes the parametric body + face + VFX into one
// animated <svg>, driven by the pure motion spec. The body group plays the
// state/one-shot keyframes; a separate group blinks the eyes on a gentle loop.
// Everything collapses to a still frame under reduced motion.

import { motion } from "motion/react"
import type { PetSkin, PetSkinRenderProps } from "@/types/pet"
import { resolvePetMotion } from "@/lib/pet/animation/motion-spec"
import { resolveWalkMotion } from "@/lib/pet/animation/walk-spec"
import { stageScale, isEggStage } from "@/lib/pet/skins/stage-visual"
import { PetBody } from "./svg/pet-body"
import { PetEyesGroup, PetMouth } from "./svg/pet-face"
import { PetVfx } from "./svg/pet-vfx"

function PetSvgContent({
  bones,
  stage,
  state,
  oneShot,
  reducedMotion,
  locomotion,
  paused,
}: PetSkinRenderProps) {
  // `paused` renders the same still frame as reduced motion (the face still
  // expresses the emotion) — used while the window is hidden / minimized.
  const still = reducedMotion || Boolean(paused)
  const baseSpec = resolvePetMotion(state, oneShot, still, bones.eyes)
  // Walking overlays a brisk bob over the resting spec; one-shots keep priority.
  const walking = locomotion?.mode === "walking" && oneShot === null && !still
  const spec = walking ? resolveWalkMotion(baseSpec, still) : baseSpec
  const scale = stageScale(stage)
  const egg = isEggStage(stage)

  const bodyAnimate = still
    ? { scale: spec.body.scale[0] * scale }
    : {
        scale: spec.body.scale.map((s) => s * scale),
        y: spec.body.y,
        x: spec.body.x,
        rotate: spec.body.rotate,
      }

  const bodyTransition = still
    ? { duration: 0 }
    : {
        duration: spec.durationSec,
        repeat: spec.loop ? Infinity : 0,
        ease: "easeInOut" as const,
      }

  return (
    <g data-pet-skin="svg" data-pet-state={state} data-pet-oneshot={oneShot ?? "none"}>
      {/* Ground shadow — squashes slightly as the body bobs. */}
      <motion.ellipse
        data-pet-part="shadow"
        cx={50}
        cy={92}
        rx={22}
        ry={5}
        fill="#00000022"
        animate={still ? { scaleX: 1 } : { scaleX: [1, 0.9, 1] }}
        transition={
          still
            ? { duration: 0 }
            : { duration: spec.durationSec, repeat: spec.loop ? Infinity : 0, ease: "easeInOut" }
        }
        style={{ transformOrigin: "50px 92px" }}
      />

      <motion.g
        animate={bodyAnimate}
        transition={bodyTransition}
        style={{ transformOrigin: "50px 58px" }}
      >
        {egg ? (
          <g data-pet-part="egg">
            <ellipse cx={50} cy={60} rx={24} ry={30} fill={bones.palette.primary} />
            <path
              d="M 30 58 l 8 -6 l 6 6 l 6 -6 l 6 6 l 6 -6 l 8 6"
              stroke={bones.palette.secondary}
              strokeWidth={2.5}
              fill="none"
            />
          </g>
        ) : (
          <>
            <PetBody bones={bones} />
            <PetEyesGroup kind={spec.eyes} />
            <PetMouth shape={spec.mouth} />
          </>
        )}
      </motion.g>

      {!egg && <PetVfx state={state} oneShot={oneShot} shiny={bones.shiny} reducedMotion={still} />}
    </g>
  )
}

export const svgSkin: PetSkin = {
  id: "svg",
  render(props: PetSkinRenderProps) {
    const facing = props.locomotion?.facing ?? "right"
    return (
      <svg
        viewBox="0 0 100 100"
        width={props.size}
        height={props.size}
        role="img"
        data-pet-skin-root="svg"
        data-pet-facing={facing}
        data-pet-locomotion={props.locomotion?.mode ?? "resting"}
        // The art faces right by default; walking left mirrors the whole svg.
        style={{ overflow: "visible", transform: facing === "left" ? "scaleX(-1)" : undefined }}
      >
        <PetSvgContent {...props} />
      </svg>
    )
  },
}
