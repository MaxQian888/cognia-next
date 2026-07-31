// The default SVG skin: composes the parametric body + face + VFX into one
// animated <svg>, driven by the pure motion spec. The body group plays the
// state/one-shot keyframes; a separate group blinks the eyes on a deterministic
// loop; locomotion (walk/fall/climb) and the held/dragging pose overlay the
// emotion spec. Everything collapses to a still frame under reduced motion.

import { motion } from "motion/react"
import type { PetBones, PetSkin, PetSkinRenderProps } from "@/types/pet"
import { resolvePetMotion } from "@/lib/pet/animation/motion-spec"
import { useSettingsStore } from "@/stores/settings"
import {
  resolveClimbMotion,
  resolveFallMotion,
  resolveWalkMotion,
} from "@/lib/pet/animation/walk-spec"
import { resolveBlink } from "@/lib/pet/animation/blink-spec"
import { useIdleQuiescence } from "@/hooks/pet/use-idle-quiescence"
import { stageScale, isEggStage } from "@/lib/pet/skins/stage-visual"
import { resolveFlavorVfx } from "@/lib/pet/skins/flavor-vfx"
import { PetBody } from "./svg/pet-body"
import { PetEyesGroup, PetMouth } from "./svg/pet-face"
import { PetVfx } from "./svg/pet-vfx"

/** Deterministic per-pet seed (never Math.random in render paths). */
function blinkSeed(bones: PetBones): number {
  return bones.species.charCodeAt(0) * 97 + bones.stats.chaos * 13 + bones.stats.wisdom
}

/**
 * Blend-in keyframes: `null` first tells framer-motion to tween from the
 * CURRENT value instead of snapping to the spec's resting frame on every
 * state switch (the audit's "transitions snap" gap). Single-frame arrays
 * stay as-is (nothing to blend).
 */
function blendFrom(frames: number[], map: (v: number) => number = (v) => v): (number | null)[] {
  const mapped = frames.map(map)
  if (mapped.length <= 1) return mapped
  return [null, ...mapped.slice(1)]
}

function PetSvgContent({
  bones,
  stage,
  state,
  oneShot,
  reducedMotion,
  locomotion,
  paused,
  flavor,
  mood,
  speaking,
  held,
}: PetSkinRenderProps) {
  // Low power halves the looping cadence (same settings read as live2d-skin).
  const lowPower = useSettingsStore((s) => Boolean(s.settings?.petSettings?.lowPower))
  // After a stretch of plain idle the breathing loop has nothing to express;
  // quiescing collapses it to a still frame (zero rAF) until something changes.
  const quiescent = useIdleQuiescence(state, oneShot, lowPower)
  // `paused` renders the same still frame as reduced motion (the face still
  // expresses the emotion) — used while the window is hidden / minimized.
  const still = reducedMotion || Boolean(paused) || quiescent
  const baseSpec = resolvePetMotion(state, oneShot, still, bones.eyes, { lowPower, mood, held })
  // Locomotion overlays replace the resting body motion; one-shots keep
  // priority, and the held pose (already resolved above) beats walking.
  const mode = locomotion?.mode ?? "resting"
  const spec =
    oneShot !== null || still || held
      ? baseSpec
      : mode === "walking"
        ? resolveWalkMotion(baseSpec, still, locomotion?.speedPxPerSec)
        : mode === "falling"
          ? resolveFallMotion(baseSpec, still)
          : mode === "climbing"
            ? resolveClimbMotion(baseSpec, still)
            : baseSpec
  const scale = stageScale(stage)
  const egg = isEggStage(stage)
  // Evolution-flavor accent: plain desaturates the body (static filter,
  // survives stillness); radiant adds a warm aura via the VFX layer.
  const flavorVfx = egg ? null : resolveFlavorVfx(flavor, { reducedMotion: still, lowPower })
  const blink = egg ? null : resolveBlink(spec.eyes, still || oneShot !== null, blinkSeed(bones))

  // The egg is not inert: a slow shell-bottom pendulum hints at the life
  // inside (replaces the generic breathing bob, which read as a floating egg).
  const eggWobble = egg && !still

  const bodyAnimate = still
    ? { scale: spec.body.scale[0] * scale }
    : eggWobble
      ? { scale, rotate: [-3, 3, -3] }
      : {
          scale: blendFrom(spec.body.scale, (s) => s * scale),
          y: blendFrom(spec.body.y),
          x: blendFrom(spec.body.x),
          rotate: blendFrom(spec.body.rotate),
        }

  const bodyTransition = still
    ? { duration: 0 }
    : eggWobble
      ? { duration: 3.4, repeat: Infinity, ease: "easeInOut" as const }
      : {
          duration: spec.durationSec,
          repeat: spec.loop ? Infinity : 0,
          ease: "easeInOut" as const,
        }

  // Lip flap while a bubble is showing (SVG parity with Live2D's lip sync).
  // One-shots own the mouth for their moment.
  const lipFlap = Boolean(speaking) && !still && oneShot === null

  return (
    <g
      data-pet-skin="svg"
      data-pet-state={state}
      data-pet-oneshot={oneShot ?? "none"}
      data-pet-loop-sec={spec.durationSec}
      data-pet-blink={blink ? "on" : "off"}
      data-pet-held={held || undefined}
    >
      {/* Ground shadow — squashes slightly as the body bobs; detaches (fades)
          while airborne so the pet doesn't look glued to the floor mid-throw. */}
      <motion.ellipse
        data-pet-part="shadow"
        cx={50}
        cy={92}
        rx={22}
        ry={5}
        fill="#00000022"
        opacity={1}
        animate={
          still
            ? { scaleX: 1, opacity: 1 }
            : mode === "falling" || held
              ? { scaleX: 0.7, opacity: 0.35 }
              : { scaleX: [1, 0.9, 1], opacity: 1 }
        }
        transition={
          still
            ? { duration: 0 }
            : mode === "falling" || held
              ? { duration: 0.25 }
              : { duration: spec.durationSec, repeat: spec.loop ? Infinity : 0, ease: "easeInOut" }
        }
        style={{ transformOrigin: "50px 92px" }}
      />

      <motion.g
        animate={bodyAnimate}
        transition={bodyTransition}
        data-pet-flavor={flavorVfx ? (flavor ?? "normal") : "normal"}
        style={{
          transformOrigin: eggWobble ? "50px 90px" : "50px 58px",
          ...(flavorVfx && flavorVfx.saturate !== 1
            ? { filter: `saturate(${flavorVfx.saturate})` }
            : {}),
        }}
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
            {blink ? (
              <motion.g
                data-pet-part="blink"
                animate={{ scaleY: blink.scaleY }}
                transition={{
                  duration: blink.intervalSec,
                  times: blink.times,
                  repeat: Infinity,
                  ease: "easeInOut",
                }}
                style={{ transformOrigin: "50px 50px" }}
              >
                <PetEyesGroup kind={spec.eyes} />
              </motion.g>
            ) : (
              <PetEyesGroup kind={spec.eyes} />
            )}
            {lipFlap ? (
              <motion.g
                data-pet-part="lip-flap"
                animate={{ scaleY: [1, 0.5, 1] }}
                transition={{ duration: 0.35, repeat: Infinity, ease: "easeInOut" }}
                style={{ transformOrigin: "50px 66px" }}
              >
                <PetMouth shape={spec.mouth === "frown" ? spec.mouth : "o"} />
              </motion.g>
            ) : (
              <PetMouth shape={spec.mouth} />
            )}
          </>
        )}
      </motion.g>

      {!egg && (
        <PetVfx
          state={state}
          oneShot={oneShot}
          shiny={bones.shiny}
          rarity={bones.rarity}
          reducedMotion={still}
          lowPower={lowPower}
          flavorAuraColor={flavorVfx?.aura ? flavorVfx.auraColor : null}
        />
      )}
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
        style={{ overflow: "visible" }}
      >
        {/* The art faces right by default; walking left mirrors the content
            group. A motion tween squeezes scaleX through 0 over ~150ms — a
            cartoon turn instead of an instant 1-frame mirror teleport. */}
        <motion.g
          data-pet-facing-group
          animate={{ scaleX: facing === "left" ? -1 : 1 }}
          transition={props.reducedMotion ? { duration: 0 } : { duration: 0.15, ease: "easeInOut" }}
          style={{ transformOrigin: "50px 50px" }}
        >
          <PetSvgContent {...props} />
        </motion.g>
      </svg>
    )
  },
}
