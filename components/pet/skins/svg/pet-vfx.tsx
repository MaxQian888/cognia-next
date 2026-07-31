// Particle / VFX layer for the SVG skin: floating hearts (petted / love), a
// gold ring burst (level-up), sparkles (evolving), crumbs (fed), a "!" pop
// (surprised), drifting Zzz (sleeping / sleepy), landing dust, a shiny
// shimmer overlay, and an error sweat-drop. Under reduced motion the layer
// keeps IDENTITY (a static rarity aura + motes) but plays no animation.

import { motion } from "motion/react"
import type { PetOneShot, PetRarity, PetVisualState } from "@/types/pet"
import { resolveRarityVfx, resolveShinyVfx } from "@/lib/pet/skins/rarity-vfx"

/** Breathing aura ring for rare+ pets (static variant for reduced motion). */
function Aura({ color, still = false }: { color: string; still?: boolean }) {
  if (still) {
    return (
      <circle
        data-pet-vfx="aura"
        data-static="true"
        cx={50}
        cy={58}
        r={34}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        opacity={0.3}
      />
    )
  }
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

/**
 * The motes for epic/legendary auras. Animated mode renders ONE shared
 * rotating group containing every mote (instead of N independent rotating
 * wrappers — the audit's perf micro-fix); static mode renders plain circles.
 */
function Motes({ count, color, orbit }: { count: number; color: string; orbit: boolean }) {
  const dots = Array.from({ length: count }).map((_, i) => {
    const angle = (i / count) * Math.PI * 2
    return { cx: 50 + Math.cos(angle) * 36, cy: 58 + Math.sin(angle) * 36, i }
  })
  if (!orbit) {
    return (
      <g data-pet-vfx="motes">
        {dots.map(({ cx, cy, i }) => (
          <circle key={i} data-pet-vfx="mote" cx={cx} cy={cy} r={1.6} fill={color} opacity={0.7} />
        ))}
      </g>
    )
  }
  return (
    <motion.g
      data-pet-vfx="motes"
      animate={{ rotate: 360 }}
      transition={{ duration: 8, repeat: Infinity, ease: "linear" }}
      style={{ transformOrigin: "50px 58px" }}
    >
      {dots.map(({ cx, cy, i }) => (
        <motion.circle
          key={i}
          data-pet-vfx="mote"
          cx={cx}
          cy={cy}
          r={1.6}
          fill={color}
          initial={{ opacity: 0.3 }}
          animate={{ opacity: [0.3, 0.9, 0.3] }}
          transition={{ duration: 2, repeat: Infinity, delay: i * 0.3, ease: "easeInOut" }}
        />
      ))}
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

/** Expanding gold ring — the level-up burst (distinct from evolving sparkles). */
function LevelUpRing({ delay }: { delay: number }) {
  return (
    <motion.circle
      data-pet-vfx="levelup-ring"
      cx={50}
      cy={58}
      r={20}
      fill="none"
      stroke="#fbbf24"
      strokeWidth={2.5}
      initial={{ opacity: 0.9, scale: 0.5 }}
      animate={{ opacity: [0.9, 0], scale: [0.5, 1.6] }}
      transition={{ duration: 0.8, delay, ease: "easeOut" }}
      style={{ transformOrigin: "50px 58px" }}
    />
  )
}

/** Drifting Zzz glyphs for the sleeping loop / sleepy one-shot. */
function Zzz({ delay }: { delay: number }) {
  return (
    <motion.text
      data-pet-vfx="zzz"
      x={68}
      y={40}
      fontSize={9}
      fontWeight={700}
      fill="#7cc4ff"
      initial={{ opacity: 0, y: 0, x: 0 }}
      animate={{ opacity: [0, 0.9, 0], y: -14, x: 6 }}
      transition={{ duration: 2.4, delay, repeat: Infinity, ease: "easeOut" }}
    >
      z
    </motion.text>
  )
}

/** Falling crumbs while munching. */
function Crumb({ x, delay }: { x: number; delay: number }) {
  return (
    <motion.circle
      data-pet-vfx="crumb"
      cx={x}
      cy={70}
      r={1.4}
      fill="#c88a4b"
      initial={{ opacity: 0, y: 0 }}
      animate={{ opacity: [0, 1, 0], y: 16 }}
      transition={{ duration: 0.55, delay, ease: "easeIn" }}
    />
  )
}

/** Ground dust puffs on landing. */
function Dust({ x, dir, delay }: { x: number; dir: 1 | -1; delay: number }) {
  return (
    <motion.circle
      data-pet-vfx="dust"
      cx={x}
      cy={90}
      r={2.4}
      fill="#9ca3af"
      initial={{ opacity: 0.7, scale: 0.5, x: 0 }}
      animate={{ opacity: [0.7, 0], scale: [0.5, 1.6], x: dir * 10 }}
      transition={{ duration: 0.5, delay, ease: "easeOut" }}
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
  flavorAuraColor = null,
}: {
  state: PetVisualState
  oneShot: PetOneShot | null
  shiny: boolean
  rarity: PetRarity
  reducedMotion: boolean
  lowPower?: boolean
  /** Radiant evolution-flavor aura color, or null when none. */
  flavorAuraColor?: string | null
}) {
  const rarityVfx = resolveRarityVfx(rarity, { reducedMotion, lowPower })

  // Reduced motion: identity only — a fully static aura + motes, no animation.
  if (reducedMotion) {
    if (!rarityVfx) return null
    return (
      <g data-pet-part="vfx" data-vfx-static="true">
        {rarityVfx.aura && <Aura color={rarityVfx.auraColor} still />}
        <Motes count={rarityVfx.particleCount} color={rarityVfx.auraColor} orbit={false} />
      </g>
    )
  }

  const shinyVfx = resolveShinyVfx(shiny, { reducedMotion, lowPower })

  return (
    <g data-pet-part="vfx">
      {rarityVfx?.aura && <Aura color={rarityVfx.auraColor} />}
      {flavorAuraColor && (
        <g data-pet-vfx="flavor-aura">
          <Aura color={flavorAuraColor} />
        </g>
      )}
      {rarityVfx && rarityVfx.particleCount > 0 && (
        <Motes
          count={rarityVfx.particleCount}
          color={rarityVfx.auraColor}
          orbit={rarityVfx.orbit}
        />
      )}
      {(oneShot === "petted" || oneShot === "love") && (
        <>
          <Heart x={40} delay={0} />
          <Heart x={56} delay={0.2} />
          {oneShot === "love" && <Heart x={48} delay={0.4} />}
        </>
      )}
      {oneShot === "levelUp" && (
        <>
          <LevelUpRing delay={0} />
          <LevelUpRing delay={0.2} />
        </>
      )}
      {oneShot === "evolving" && (
        <>
          <Sparkle cx={26} cy={30} delay={0} />
          <Sparkle cx={74} cy={32} delay={0.15} />
          <Sparkle cx={50} cy={18} delay={0.3} />
          <Sparkle cx={30} cy={70} delay={0.2} />
          <Sparkle cx={72} cy={66} delay={0.35} />
        </>
      )}
      {oneShot === "hatch" && (
        <>
          <Sparkle cx={38} cy={36} delay={0} />
          <Sparkle cx={62} cy={34} delay={0.15} />
          <Sparkle cx={50} cy={24} delay={0.3} />
        </>
      )}
      {oneShot === "fed" && (
        <>
          <Crumb x={44} delay={0} />
          <Crumb x={52} delay={0.12} />
          <Crumb x={58} delay={0.22} />
        </>
      )}
      {oneShot === "surprised" && (
        <motion.text
          data-pet-vfx="exclaim"
          x={66}
          y={34}
          fontSize={14}
          fontWeight={800}
          fill="#f59e0b"
          initial={{ opacity: 0, scale: 0.4 }}
          animate={{ opacity: [0, 1, 1, 0], scale: [0.4, 1.3, 1, 1] }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          style={{ transformOrigin: "66px 34px" }}
        >
          !
        </motion.text>
      )}
      {oneShot === "land" && (
        <>
          <Dust x={34} dir={-1} delay={0} />
          <Dust x={66} dir={1} delay={0} />
          <Dust x={42} dir={-1} delay={0.08} />
          <Dust x={58} dir={1} delay={0.08} />
        </>
      )}
      {(state === "sleeping" || oneShot === "sleepy") && (
        <>
          <Zzz delay={0} />
          <Zzz delay={1.2} />
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
