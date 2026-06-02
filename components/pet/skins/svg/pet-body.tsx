// The parametric body silhouette for the SVG skin. One component renders every
// species by reading its traits (ear/tail/face shape) and the bones palette +
// body type. All drawing happens in the 100×100 pet viewBox.

import type { PetBones, PetHat } from "@/types/pet"
import { getSpeciesTraits, type PetSpeciesTraits } from "@/lib/pet/skins/species-traits"

const CX = 50
const BODY_CY = 58

interface BodyDims {
  rx: number
  ry: number
}

function bodyDims(bones: PetBones, traits: PetSpeciesTraits): BodyDims {
  const base =
    bones.bodyType === "tall"
      ? { rx: 26, ry: 34 }
      : bones.bodyType === "wide"
        ? { rx: 34, ry: 26 }
        : { rx: 30, ry: 30 }
  // Pull toward a circle by the species roundness floor.
  const target = 30
  return {
    rx: base.rx + (target - base.rx) * traits.roundness,
    ry: base.ry + (target - base.ry) * traits.roundness,
  }
}

function Ears({ traits, accent }: { traits: PetSpeciesTraits; accent: string }) {
  const topY = BODY_CY - bodyDimsTopOffset(traits)
  switch (traits.ears) {
    case "none":
      return null
    case "cat":
      return (
        <g data-pet-part="ears" data-ears="cat" fill={accent}>
          <path d={`M ${CX - 18} ${topY} l -3 -16 l 14 7 z`} />
          <path d={`M ${CX + 18} ${topY} l 3 -16 l -14 7 z`} />
        </g>
      )
    case "rabbit":
      return (
        <g data-pet-part="ears" data-ears="rabbit" fill={accent}>
          <ellipse cx={CX - 10} cy={topY - 16} rx={5} ry={16} />
          <ellipse cx={CX + 10} cy={topY - 16} rx={5} ry={16} />
        </g>
      )
    case "round":
      return (
        <g data-pet-part="ears" data-ears="round" fill={accent}>
          <circle cx={CX - 18} cy={topY - 2} r={7} />
          <circle cx={CX + 18} cy={topY - 2} r={7} />
        </g>
      )
    case "tuft":
      return (
        <g data-pet-part="ears" data-ears="tuft" fill={accent}>
          <path d={`M ${CX - 16} ${topY} l -2 -12 l 9 6 z`} />
          <path d={`M ${CX + 16} ${topY} l 2 -12 l -9 6 z`} />
        </g>
      )
    case "fin":
      return (
        <g
          data-pet-part="ears"
          data-ears="fin"
          stroke={accent}
          strokeWidth={3}
          fill="none"
          strokeLinecap="round"
        >
          <path d={`M ${CX - 24} ${BODY_CY - 4} q -8 -4 -10 4`} />
          <path d={`M ${CX + 24} ${BODY_CY - 4} q 8 -4 10 4`} />
        </g>
      )
    case "antenna":
      return (
        <g data-pet-part="ears" data-ears="antenna" stroke={accent} strokeWidth={2.4}>
          <line x1={CX - 8} y1={topY} x2={CX - 12} y2={topY - 14} strokeLinecap="round" />
          <line x1={CX + 8} y1={topY} x2={CX + 12} y2={topY - 14} strokeLinecap="round" />
          <circle cx={CX - 12} cy={topY - 15} r={3} fill={accent} stroke="none" />
          <circle cx={CX + 12} cy={topY - 15} r={3} fill={accent} stroke="none" />
        </g>
      )
  }
}

function bodyDimsTopOffset(traits: PetSpeciesTraits): number {
  // Approx top of the body for ear anchoring (kept simple/stable).
  return 22 + traits.roundness * 4
}

function Tail({ traits, accent }: { traits: PetSpeciesTraits; accent: string }) {
  const x = CX + 26
  const y = BODY_CY + 14
  switch (traits.tail) {
    case "none":
      return null
    case "curl":
      return (
        <path
          data-pet-part="tail"
          data-tail="curl"
          d={`M ${x} ${y} q 10 -2 8 -10 q -2 -6 -8 -3`}
          stroke={accent}
          strokeWidth={3.5}
          fill="none"
          strokeLinecap="round"
        />
      )
    case "puff":
      return <circle data-pet-part="tail" data-tail="puff" cx={x + 2} cy={y} r={6} fill={accent} />
    case "point":
      return (
        <path
          data-pet-part="tail"
          data-tail="point"
          d={`M ${x} ${y} l 12 -4 l -4 10 z`}
          fill={accent}
        />
      )
    case "fan":
      return (
        <path
          data-pet-part="tail"
          data-tail="fan"
          d={`M ${x - 2} ${y} q 16 -6 14 8 q -8 4 -14 -2 z`}
          fill={accent}
        />
      )
  }
}

function Hat({ hat, accent }: { hat: PetHat; accent: string }) {
  const topY = 26
  switch (hat) {
    case "none":
      return null
    case "crown":
      return (
        <path
          data-pet-part="hat"
          data-hat="crown"
          d={`M ${CX - 12} ${topY} l 3 -10 l 4 6 l 5 -9 l 5 9 l 4 -6 l 3 10 z`}
          fill="#f5c542"
          stroke="#caa12f"
          strokeWidth={1}
        />
      )
    case "tophat":
      return (
        <g data-pet-part="hat" data-hat="tophat" fill="#2a2a33">
          <rect x={CX - 8} y={topY - 14} width={16} height={14} rx={1} />
          <rect x={CX - 14} y={topY - 2} width={28} height={4} rx={2} />
        </g>
      )
    case "propeller":
      return (
        <g data-pet-part="hat" data-hat="propeller">
          <path d={`M ${CX - 12} ${topY} a 12 10 0 0 1 24 0 z`} fill={accent} />
          <line x1={CX} y1={topY - 12} x2={CX} y2={topY - 18} stroke="#2a2a33" strokeWidth={1.6} />
          <line
            x1={CX - 8}
            y1={topY - 18}
            x2={CX + 8}
            y2={topY - 18}
            stroke="#2a2a33"
            strokeWidth={2.4}
            strokeLinecap="round"
          />
        </g>
      )
    case "halo":
      return (
        <ellipse
          data-pet-part="hat"
          data-hat="halo"
          cx={CX}
          cy={topY - 14}
          rx={12}
          ry={4}
          fill="none"
          stroke="#f5e27a"
          strokeWidth={3}
        />
      )
    case "wizard":
      return (
        <g data-pet-part="hat" data-hat="wizard">
          <path d={`M ${CX} ${topY - 22} l -12 22 l 24 0 z`} fill="#6d5ae0" />
          <path
            d={`M ${CX - 2} ${topY - 8} l 1.4 3 l 3 0.4 l -2.2 2 l 0.6 3 l -2.8 -1.6 l -2.8 1.6 l 0.6 -3 l -2.2 -2 l 3 -0.4 z`}
            fill="#f5e27a"
          />
        </g>
      )
    case "beanie":
      return (
        <path
          data-pet-part="hat"
          data-hat="beanie"
          d={`M ${CX - 14} ${topY} a 14 12 0 0 1 28 0 z`}
          fill={accent}
          stroke="#00000022"
          strokeWidth={1}
        />
      )
    case "tinyduck":
      return (
        <g data-pet-part="hat" data-hat="tinyduck">
          <ellipse cx={CX} cy={topY - 4} rx={7} ry={6} fill="#ffd24a" />
          <circle cx={CX + 5} cy={topY - 7} r={3.5} fill="#ffd24a" />
          <path d={`M ${CX + 8} ${topY - 7} l 4 1 l -4 1 z`} fill="#ff9f1c" />
        </g>
      )
  }
}

export function PetBody({ bones }: { bones: PetBones }) {
  const traits = getSpeciesTraits(bones.species)
  const { rx, ry } = bodyDims(bones, traits)
  const { palette } = bones
  return (
    <g data-pet-part="body" data-species={bones.species} data-body-type={bones.bodyType}>
      {/* Tail and ears sit behind the body. */}
      <Tail traits={traits} accent={palette.accent} />
      <Ears traits={traits} accent={palette.accent} />
      {/* Body. */}
      <ellipse cx={CX} cy={BODY_CY} rx={rx} ry={ry} fill={palette.primary} />
      {/* Belly. */}
      <ellipse
        cx={CX}
        cy={BODY_CY + ry * 0.18}
        rx={rx * 0.62}
        ry={ry * 0.6}
        fill={palette.secondary}
        opacity={0.9}
      />
      {/* Cheeks. */}
      {traits.cheeks && (
        <g data-pet-part="cheeks" fill="#ff8aa0" opacity={0.55}>
          <circle cx={CX - 20} cy={58} r={4} />
          <circle cx={CX + 20} cy={58} r={4} />
        </g>
      )}
      <Hat hat={bones.hat} accent={palette.accent} />
    </g>
  )
}
