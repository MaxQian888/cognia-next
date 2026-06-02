// Particle / VFX layer for the SVG skin: floating hearts (petted), a starburst
// (level-up / evolving), a shiny shimmer overlay, and an error sweat-drop. All
// motion is suppressed under reduced motion (the layer renders nothing rather
// than popping a static artifact).

import { motion } from "motion/react"
import type { PetOneShot, PetVisualState } from "@/types/pet"

const INK = "var(--pet-ink, #2a2a33)"

function Heart({ x, delay }: { x: number; delay: number }) {
  return (
    <motion.path
      data-pet-vfx="heart"
      d={`M ${x} 44 c -2 -3 -7 -1 -7 3 c 0 3 4 5 7 8 c 3 -3 7 -5 7 -8 c 0 -4 -5 -6 -7 -3 z`}
      fill="#ff5d8f"
      initial={{ opacity: 0, y: 0, scale: 0.6 }}
      animate={{ opacity: [0, 1, 0], y: -26, scale: 1 }}
      transition={{ duration: 1, delay, ease: "easeOut" }}
    />
  )
}

function Sparkle({ cx, cy, delay }: { cx: number; cy: number; delay: number }) {
  return (
    <motion.path
      data-pet-vfx="sparkle"
      d={`M ${cx} ${cy - 4} l 1 3 l 3 1 l -3 1 l -1 3 l -1 -3 l -3 -1 l 3 -1 z`}
      fill="#ffe066"
      initial={{ opacity: 0, scale: 0 }}
      animate={{ opacity: [0, 1, 0], scale: [0, 1.4, 0] }}
      transition={{ duration: 0.9, delay, ease: "easeOut" }}
    />
  )
}

export function PetVfx({
  state,
  oneShot,
  shiny,
  reducedMotion,
}: {
  state: PetVisualState
  oneShot: PetOneShot | null
  shiny: boolean
  reducedMotion: boolean
}) {
  if (reducedMotion) return null

  return (
    <g data-pet-part="vfx">
      {oneShot === "petted" && (
        <>
          <Heart x={40} delay={0} />
          <Heart x={56} delay={0.2} />
        </>
      )}
      {(oneShot === "levelUp" || oneShot === "evolving") && (
        <>
          <Sparkle cx={26} cy={30} delay={0} />
          <Sparkle cx={74} cy={32} delay={0.15} />
          <Sparkle cx={50} cy={18} delay={0.3} />
          <Sparkle cx={30} cy={70} delay={0.2} />
          <Sparkle cx={72} cy={66} delay={0.35} />
        </>
      )}
      {shiny && (
        <motion.circle
          data-pet-vfx="shiny"
          cx={68}
          cy={40}
          r={2.4}
          fill="#fff"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 0.9, 0] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
        />
      )}
      {state === "error" && (
        <motion.path
          data-pet-vfx="sweat"
          d="M 72 40 q 3 6 0 9 q -3 -3 0 -9 z"
          fill="#7cc4ff"
          initial={{ opacity: 0, y: -2 }}
          animate={{ opacity: [0, 1, 0], y: 6 }}
          transition={{ duration: 1.1, repeat: Infinity, ease: "easeIn" }}
        />
      )}
    </g>
  )
}
