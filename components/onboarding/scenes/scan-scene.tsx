"use client"

/**
 * Scan — what the probe actually found on this machine.
 *
 * The one scene in the flow that is a *report* rather than a claim, and the
 * reason the narrative panel earns its width at all: `useMachineScan` already
 * knows how many runtimes are installed, which of them are signed in, and how
 * many past conversations are sitting on disk. Before this, all of that
 * arrived as one spinner and the sentence "Looking around…".
 *
 * Every mark here is derived:
 *
 *  - one chip per slot, capped at {@link MAX_SLOTS}; found runtimes fill from
 *    the top, and the remainder stay as dashed empty slots so the picture
 *    shows what was looked for, not only what was hit
 *  - a signed-in runtime is `active` with a solid connector; an installed but
 *    unauthenticated one is `pending` with a dashed connector — the same
 *    distinction the step body draws in words, and the reason the flow can
 *    skip the sign-in step for one and not the other
 *  - the history badge carries the real count
 *
 * While the probe is still in flight the empty slots breathe in sequence. That
 * is a state, not decoration: it stops the moment `phase` leaves `scanning`,
 * which — given the soft 5s / hard 20s policy in `lib/onboarding/scan.ts` — is
 * the one place in this flow where the user is genuinely waiting on work.
 */

import { useTranslations } from "next-intl"

import {
  CHIP,
  Connector,
  CoreNode,
  CountBadge,
  HAIRLINE,
  MachineFrame,
  SceneCanvas,
  SlotChip,
  chipCenterY,
  useSceneEntrance,
} from "./scene-primitives"
import type { ScanPhase, ScannedRuntime } from "@/lib/onboarding/scan"

/**
 * How many slots the column draws. Four is what fits at the shared geometry
 * without the chips crowding the core, and it is also every vendor
 * `probeVendors()` can return — so in practice nothing is ever truncated.
 */
export const MAX_SLOTS = 4

export interface ScanSceneProps {
  phase: ScanPhase
  runtimes: readonly ScannedRuntime[]
  /** Past conversations found across every ADR-0062 source. */
  historyCount?: number
}

export function ScanScene({ phase, runtimes, historyCount = 0 }: ScanSceneProps) {
  const t = useTranslations("onboarding")
  const { reduce, enter } = useSceneEntrance()
  const shown = runtimes.slice(0, MAX_SLOTS)
  const total = MAX_SLOTS

  return (
    <SceneCanvas label={t("scene.scan")} data-testid="onboarding-scene-scan">
      <MachineFrame />

      {Array.from({ length: total }, (_, index) => {
        const runtime = shown[index]
        if (!runtime) {
          return (
            <EmptySlot
              key={`empty-${index}`}
              index={index}
              total={total}
              scanning={phase === "scanning" && !reduce}
            />
          )
        }
        return (
          <SlotChip
            key={runtime.id}
            index={index}
            total={total}
            tone={runtime.authenticated ? "active" : "pending"}
            done={runtime.authenticated}
            fill={0.7 + ((index * 3) % 4) / 10}
            data-testid={`onboarding-scene-runtime-${runtime.id}`}
          />
        )
      })}

      {shown.map((runtime, index) => (
        <Connector
          key={runtime.id}
          index={index}
          total={total}
          tone={runtime.authenticated ? "active" : "pending"}
          dashed={!runtime.authenticated}
          data-testid={`onboarding-scene-link-${runtime.id}`}
        />
      ))}

      <CoreNode active={shown.length > 0} index={1} />

      {historyCount > 0 && (
        <CountBadge
          value={historyCount > 999 ? "999+" : String(historyCount)}
          data-testid="onboarding-scene-history-count"
        />
      )}

      {/* Nothing found and nothing left to wait for: say so in the picture too,
          rather than leaving four dashed boxes that look like a failed load. */}
      {phase === "empty" && shown.length === 0 && (
        <line
          {...enter(5)}
          x1={CHIP.x}
          y1={chipCenterY(total - 1, total) + CHIP.height / 2 + 16}
          x2={CHIP.x + CHIP.width}
          y2={chipCenterY(total - 1, total) + CHIP.height / 2 + 16}
          stroke="var(--color-border)"
          strokeWidth={HAIRLINE}
          strokeDasharray="4 4"
        />
      )}
    </SceneCanvas>
  )
}

/**
 * A slot nothing has landed in yet.
 *
 * Sequenced opacity while the probe runs, held still otherwise. The delay is
 * keyed on the slot index so the column reads top-to-bottom — a synchronous
 * pulse on four boxes reads as a broken render.
 */
function EmptySlot({
  index,
  total,
  scanning,
}: {
  index: number
  total: number
  scanning: boolean
}) {
  const cy = chipCenterY(index, total)
  return (
    <rect
      x={CHIP.x}
      y={cy - CHIP.height / 2}
      width={CHIP.width}
      height={CHIP.height}
      rx={8}
      fill="transparent"
      stroke="var(--color-border)"
      strokeWidth={HAIRLINE}
      strokeDasharray="4 4"
      data-testid={`onboarding-scene-slot-${index}`}
      data-scanning={scanning}
      opacity={0.4}
      // Sequenced rather than synchronous: four boxes pulsing in lockstep
      // reads as a broken render, and the point is to look like a sweep.
      className={scanning ? "animate-pulse" : undefined}
      style={scanning ? { animationDelay: `${index * 180}ms` } : undefined}
    />
  )
}
