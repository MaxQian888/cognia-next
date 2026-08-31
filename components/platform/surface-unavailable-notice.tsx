"use client"

/**
 * "This cannot run here, and here is why", for any capability-gated surface.
 *
 * The generalisation of `components/connectors/connector-host-notice.tsx`,
 * which does the same job for the twenty connector controls.
 * `lib/platform/surface-reach.ts` holds the reasoning. This is its one
 * localized read-out.
 *
 * Renders nothing when the surface CAN run, so a call site can mount it
 * unconditionally beside the control it explains.
 */

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"

import { UnavailableNotice } from "@/components/connectors/unavailable-notice"
import type { SurfaceBlock, SurfaceReach } from "@/lib/platform/surface-reach"

/**
 * Blocks that have somewhere to send the user.
 *
 * `local-lacks-capability` is absent on purpose: when this build on this
 * machine cannot do the thing, there is no next step, and padding the read-out
 * out to look actionable is exactly what the connector notice was written to
 * stop doing.
 */
const BLOCKS_WITH_NEXT_STEP: readonly SurfaceBlock[] = Object.freeze([
  "no-host",
  "needs-desktop-shell",
  "host-lacks-capability",
] as const)

export interface SurfaceUnavailableNoticeProps {
  reach: SurfaceReach
  /** Rendered after the text, e.g. a "Pair a host" button. */
  action?: ReactNode
  className?: string
  "data-testid"?: string
}

export function SurfaceUnavailableNotice({
  reach,
  action,
  className,
  "data-testid": testId = "surface-unavailable-notice",
}: SurfaceUnavailableNoticeProps) {
  const t = useTranslations("surfaceReach")
  if (reach.available || !reach.block) return null
  const block = reach.block
  return (
    <UnavailableNotice
      reason={t(`block.${block}`)}
      nextStep={BLOCKS_WITH_NEXT_STEP.includes(block) ? t(`nextStep.${block}`) : null}
      cause={block}
      action={action}
      className={className}
      data-testid={testId}
    />
  )
}
