"use client"

/**
 * Sign-in — one credential, and the link it completes.
 *
 * The sparsest scene in the flow, deliberately. Every other step is about
 * plurality — how many runtimes, how many transcripts, how many plan lines —
 * and this one is about a single missing piece, so it draws a single chip and
 * a single connector rather than a column with two empty slots under it.
 *
 * The connector is dashed and amber until a credential lands, then solid and
 * cyan. That is the same tone ladder the scan scene uses for an installed but
 * unauthenticated runtime, which is the point: "present but not signed in" and
 * "not signed in yet" are the same state, and the flow should not invent a
 * second visual language for it one step later.
 */

import { useTranslations } from "next-intl"

import {
  CHIP,
  Connector,
  CoreNode,
  HAIRLINE,
  MachineFrame,
  SceneCanvas,
  TONE_STROKE,
  chipCenterY,
  useSceneEntrance,
} from "./scene-primitives"

/** A key, drawn in a 16×16 box: ring on the left, bit on the right. */
const KEY_GLYPH = "M6 8a3.25 3.25 0 1 0 0 .01Z M9.25 8H15 M13 8v2.75 M11 8v2"

export interface ProviderSceneProps {
  /** True once a credential has been persisted on this device. */
  connected?: boolean
}

export function ProviderScene({ connected = false }: ProviderSceneProps) {
  const t = useTranslations("onboarding")
  const { enter } = useSceneEntrance()
  const tone = connected ? "active" : "pending"
  // A single chip, centred against the core: `total: 1` puts `chipCenterY` on
  // the core's own row, which is what makes the connector read as one link
  // rather than one branch of a fan.
  const cy = chipCenterY(0, 1)

  return (
    <SceneCanvas label={t("scene.provider")} data-testid="onboarding-scene-provider">
      <MachineFrame />

      <g {...enter(2)} data-testid="onboarding-scene-credential" data-tone={tone}>
        <rect
          x={CHIP.x}
          y={cy - CHIP.height / 2}
          width={CHIP.width}
          height={CHIP.height}
          rx={8}
          fill="var(--color-brand-wash)"
          stroke={TONE_STROKE[tone]}
          strokeWidth={HAIRLINE}
          strokeDasharray={connected ? undefined : "4 4"}
        />
        <g
          transform={`translate(${CHIP.x + 9}, ${cy - 8})`}
          fill="none"
          stroke={TONE_STROKE[tone]}
          strokeWidth={1.35}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d={KEY_GLYPH} />
        </g>
        <rect
          x={CHIP.x + 34}
          y={cy - 5}
          width={48}
          height={3.5}
          rx={1.75}
          fill="var(--color-muted-foreground)"
          opacity={0.7}
        />
        <rect
          x={CHIP.x + 34}
          y={cy + 2}
          width={32}
          height={3.5}
          rx={1.75}
          fill="var(--color-muted-foreground)"
          opacity={0.4}
        />
      </g>

      <Connector
        index={0}
        total={1}
        tone={tone}
        dashed={!connected}
        data-testid="onboarding-scene-link-credential"
      />

      <CoreNode active={connected} index={1} />
    </SceneCanvas>
  )
}
