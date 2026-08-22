"use client"

/**
 * Welcome — what an agent in this machine can reach.
 *
 * Three chips inside the machine frame, each one a thing Cognia touches that a
 * chat box does not: the filesystem, the screen, the open web. All three are
 * drawn connected, because this scene is a claim about the product rather than
 * a report about the device — the *report* is the next scene, and it lights
 * only what the probe actually found.
 *
 * It reuses the column geometry the scan and express scenes use, so the
 * silhouette the user learns here is the one they keep seeing. What differs is
 * the content: glyphs rather than label bars, since these three are named
 * capabilities rather than whatever happens to be installed.
 */

import { useTranslations } from "next-intl"

import {
  CHIP,
  Connector,
  CoreNode,
  HAIRLINE,
  MachineFrame,
  SceneCanvas,
  chipCenterY,
  useSceneEntrance,
} from "./scene-primitives"

/** Glyph paths, drawn inside a 16×16 box whose top-left the caller places. */
const GLYPHS = {
  folder:
    "M1 4.5a1.5 1.5 0 0 1 1.5-1.5h3.4l1.6 2h6A1.5 1.5 0 0 1 15 6.5v6A1.5 1.5 0 0 1 13.5 14h-11A1.5 1.5 0 0 1 1 12.5Z",
  screen: "M1.5 3.5h13v8.5h-13Z M6 15h4 M8 12v3",
  globe:
    "M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z M1.5 8h13 M8 1.5c1.9 2 2.8 4.2 2.8 6.5S9.9 12.5 8 14.5 5.2 10.3 5.2 8 6.1 3.5 8 1.5Z",
} as const

const CHIPS = [
  { id: "fs", glyph: GLYPHS.folder },
  { id: "screen", glyph: GLYPHS.screen },
  { id: "web", glyph: GLYPHS.globe },
] as const

export function WelcomeScene() {
  const t = useTranslations("onboarding")
  const { enter } = useSceneEntrance()
  const total = CHIPS.length

  return (
    <SceneCanvas label={t("scene.welcome")} data-testid="onboarding-scene-welcome">
      <MachineFrame />

      {CHIPS.map((chip, index) => {
        const cy = chipCenterY(index, total)
        return (
          <g key={chip.id} {...enter(index + 2)} data-testid={`onboarding-scene-chip-${chip.id}`}>
            <rect
              x={CHIP.x}
              y={cy - CHIP.height / 2}
              width={CHIP.width}
              height={CHIP.height}
              rx={8}
              fill="var(--color-brand-wash)"
              stroke="var(--color-brand-action)"
              strokeWidth={HAIRLINE}
            />
            <g
              transform={`translate(${CHIP.x + 9}, ${cy - 8})`}
              fill="none"
              stroke="var(--color-brand-action)"
              strokeWidth={1.35}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d={chip.glyph} />
            </g>
            {/* Two label bars, varied in width so three chips do not read as
                one shape stamped three times. */}
            <rect
              x={CHIP.x + 34}
              y={cy - 5}
              width={[52, 44, 48][index]}
              height={3.5}
              rx={1.75}
              fill="var(--color-muted-foreground)"
              opacity={0.7}
            />
            <rect
              x={CHIP.x + 34}
              y={cy + 2}
              width={[34, 40, 28][index]}
              height={3.5}
              rx={1.75}
              fill="var(--color-muted-foreground)"
              opacity={0.4}
            />
          </g>
        )
      })}

      {CHIPS.map((chip, index) => (
        <Connector
          key={chip.id}
          index={index}
          total={total}
          tone="active"
          data-testid={`onboarding-scene-link-${chip.id}`}
        />
      ))}

      <CoreNode active index={1} />
    </SceneCanvas>
  )
}
