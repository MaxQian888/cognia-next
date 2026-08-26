"use client"

/**
 * "This host cannot drive that control, and here is why."
 *
 * The replacement for eleven copies of "requires the desktop runtime" and the
 * web-mode banner that told a cloud companion its adapters need the desktop
 * app while those adapters were running on the paired server.
 * `lib/connectors/control-reach.ts` holds the reasoning; this is its one
 * localized read-out, and `useConnectorControlReach` is the hook the twenty
 * control sites gate on.
 */

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"

import { UnavailableNotice } from "@/components/connectors/unavailable-notice"
import { useHostProfile } from "@/hooks/use-host-profile"
import {
  connectorControlReach,
  type ConnectorControlReach,
  type ConnectorControlRequirement,
} from "@/lib/connectors/control-reach"

/**
 * Whether the connector controls on this screen can run, and why not.
 *
 * Replaces `const desktop = isTauri()`. Same answer on every profile that
 * renders this UI today — the browser genuinely cannot reach `connectors_*` —
 * but routed through one resolver, so raising those commands to the device
 * plane flips twenty controls by editing one file rather than eighteen.
 */
export function useConnectorControlReach(
  requirement: ConnectorControlRequirement = "connector-runtime"
): ConnectorControlReach {
  return connectorControlReach(useHostProfile(), requirement)
}

export interface ConnectorHostNoticeProps {
  reach: ConnectorControlReach
  /** Rendered after the text. */
  action?: ReactNode
  className?: string
  "data-testid"?: string
}

/**
 * Renders nothing when the control CAN run — unlike the capability notice,
 * whose caller has already narrowed to the unavailable case. Every call site
 * here holds a reach that is usually fine, so the guard belongs inside rather
 * than repeated twenty times.
 */
export function ConnectorHostNotice({
  reach,
  action,
  className,
  "data-testid": testId = "connector-host-notice",
}: ConnectorHostNoticeProps) {
  const t = useTranslations("connectors.control")
  if (reach.available || !reach.block) return null
  return (
    <UnavailableNotice
      reason={t(`block.${reach.block}`)}
      nextStep={t(`nextStep.${reach.block}`)}
      cause={reach.block}
      action={action}
      className={className}
      data-testid={testId}
    />
  )
}
