// Particle / VFX layer for the SVG skin: floating hearts (petted), a starburst
// (level-up / evolving), a shiny shimmer overlay, and an error sweat-drop. All
// motion is suppressed under reduced motion (the layer renders nothing rather
// than popping a static artifact).

import { motion } from "motion/react"
import type { PetOneShot, PetRarity, PetVisualState } from "@/types/pet"
import { resolveRarityVfx, resolveShinyVfx } from "@/lib/pet/skins/rarity-vfx"

/** Breathing aura ring for rare+ pets. */
function Aura({ color }: { color: string }) {
  return (
    <motion.circle
      data-pet-vfx="aura"
      cx={50}
      cy={58}
      r={34}
      fill="none"
      stroke={color}
      strokeWidth={1.5}
      initial={{ opacity: 0.15, scale: 0.96 }}
      animate={{ opacity: [0.15, 0.4, 0.15], scale: [0.96, 1.02, 0.96] }}
      transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
      style={{ transformOrigin: "50px 58px" }}
    />
  )
}

/** One orbiting (or static) mote for epic/legendary auras. */
function Mote({
  index,
  count,
  color,
  orbit,
}: {
  index: number
  count: number
  color: string
  orbit: boolean
}) {
  const angle = (index / count) * Math.PI * 2
  const cx = 50 + Math.cos(angle) * 36
  const cy = 58 + Math.sin(angle) * 36
  if (!orbit) {
    return <circle data-pet-vfx="mote" cx={cx} cy={cy} r={1.6} fill={color} opacity={0.7} />
  }
  return (
    <motion.g
      data-pet-vfx="mote"
      animate={{ rotate: 360 }}
      transition={{ duration: 8, repeat: Infinity, ease: "linear" }}
      style={{ transformOrigin: "50px 58px" }}
    >
      <motion.circle
        cx={cx}
        cy={cy}
        r={1.6}
        fill={color}
        initial={{ opacity: 0.3 }}
        animate={{ opacity: [0.3, 0.9, 0.3] }}
        transition={{ duration: 2, repeat: Infinity, delay: index * 0.3, ease: "easeInOut" }}
      />
    </motion.g>
  )
}

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
  rarity,
  reducedMotion,
  lowPower = false,
}: {
  state: PetVisualState
  oneShot: PetOneShot | null
  shiny: boolean
  rarity: PetRarity
  reducedMotion: boolean
  lowPower?: boolean
}) {
  if (reducedMotion) return null

  const rarityVfx = resolveRarityVfx(rarity, { reducedMotion, lowPower })
  const shinyVfx = resolveShinyVfx(shiny, { reducedMotion, lowPower })

  return (
    <g data-pet-part="vfx">
      {rarityVfx?.aura && <Aura color={rarityVfx.auraColor} />}
      {rarityVfx &&
        Array.from({ length: rarityVfx.particleCount }).map((_, i) => (
          <Mote
            key={i}
            index={i}
            count={rarityVfx.particleCount}
            color={rarityVfx.auraColor}
            orbit={rarityVfx.orbit}
          />
        ))}
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
      {shinyVfx &&
        Array.from({ length: shinyVfx.shimmerCount }).map((_, i) => (
          <motion.circle
            key={i}
            data-pet-vfx="shiny"
            cx={i === 0 ? 68 : 30 + i * 16}
            cy={i === 0 ? 40 : 34 + i * 6}
            r={2.4}
            fill={shinyVfx.rainbow ? ["#ff8fab", "#ffe066", "#7cc4ff"][i % 3] : "#fff"}
            initial={{ opacity: 0 }}
            animate={{ opacity: [0, 0.9, 0] }}
            transition={{ duration: 2.4, repeat: Infinity, delay: i * 0.4, ease: "easeInOut" }}
          />
        ))}
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
