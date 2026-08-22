"use client"

/**
 * First run — the core producing something.
 *
 * This is the only scene where the flow of information reverses. Everywhere
 * else the chips feed the core: this is what is on your machine, this is what
 * we will bring in, this is the credential. Here the core writes back out, and
 * the connectors run the other way, because the whole flow exists to reach the
 * moment when Cognia stops being configured and starts producing.
 *
 * The output block is a small stack of lines with a caret on the last one —
 * the one place a caret is honest, since the next thing the user sees after
 * this screen is a real turn streaming into a real conversation.
 */

import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import {
  CHIP,
  CORE,
  CoreNode,
  HAIRLINE,
  MachineFrame,
  SceneCanvas,
  chipCenterY,
  useSceneEntrance,
} from "./scene-primitives"

/** Widths of the output lines. Uneven, so the block reads as prose. */
const LINES = [72, 88, 58, 80, 40] as const

export function FirstRunScene() {
  const t = useTranslations("onboarding")
  const { enter, draw, reduce } = useSceneEntrance()
  // One notional row, so the output block sits on the core's own axis.
  const cy = chipCenterY(0, 1)
  const top = cy - (LINES.length * 9) / 2

  return (
    <SceneCanvas label={t("scene.firstRun")} data-testid="onboarding-scene-first-run">
      <MachineFrame />

      <g {...enter(2)} data-testid="onboarding-scene-output">
        <rect
          x={CHIP.x - 4}
          y={top - 12}
          width={CHIP.width + 8}
          height={LINES.length * 9 + 24}
          rx={10}
          fill="var(--color-brand-wash)"
          stroke="var(--color-brand-action)"
          strokeWidth={HAIRLINE}
        />
        {/* Staggered line by line, so the block reads as being written rather
            than pasted. The last one lands under the caret. */}
        {LINES.map((width, index) => (
          <rect
            key={index}
            {...enter(3 + index)}
            x={CHIP.x + 8}
            y={top + index * 9}
            width={width}
            height={3.5}
            rx={1.75}
            fill="var(--color-muted-foreground)"
            opacity={0.65 - index * 0.06}
            data-testid={`onboarding-scene-output-${index}`}
          />
        ))}
        {/* The caret, on the line still being written — the one place a caret
            is honest, since the next screen is a real turn streaming in. */}
        <rect
          {...enter(3 + LINES.length)}
          className={cn(enter(3 + LINES.length).className, !reduce && "animate-caret-blink")}
          x={CHIP.x + 10 + LINES[LINES.length - 1]}
          y={top + (LINES.length - 1) * 9 - 1.5}
          width={5}
          height={6.5}
          rx={1}
          fill="var(--color-brand-action)"
          data-testid="onboarding-scene-caret"
        />
      </g>

      {/* Reversed: it leaves the core and arrives at the output block. */}
      <path
        {...draw(0)}
        pathLength={1}
        d={`M${CORE.x - CORE.size / 2} ${CORE.y} C${CORE.x - 50} ${CORE.y} ${CORE.x - 50} ${cy} ${CHIP.x + CHIP.width + 6} ${cy}`}
        fill="none"
        stroke="var(--color-brand-action)"
        strokeWidth={HAIRLINE}
        strokeLinecap="round"
        opacity={0.85}
        data-testid="onboarding-scene-link-output"
      />

      <CoreNode active index={1} />
    </SceneCanvas>
  )
}
