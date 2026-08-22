"use client"

/**
 * The external agent's capability profile, rendered.
 *
 * One table, driven by `ExternalAgentCapabilityProfileV1` (ADR-0090 external
 * SSOT) — the same artifact the CLI's `--backend` selection, the TUI's feature
 * rows and the execution resolver read. Before this, the desktop had no
 * capability view at all: a user whose `/compact` did nothing, or whose MCP
 * servers never reached the agent, had nowhere to look.
 *
 * Three things it deliberately shows that a boolean list cannot:
 *   - `unknown` as its own state. "Nobody has measured this" is not the same
 *     claim as "this does not work", and collapsing them is what let a stale
 *     table pass for knowledge.
 *   - the EVIDENCE behind each verdict, so "the protocol spec says so" is
 *     distinguishable from "this session's handshake said so".
 *   - drift — a live fact that contradicted a checked-in manifest row, which
 *     means the row needs updating and not that the session is broken.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import {
  EXTERNAL_AGENT_CAPABILITY_IDS,
  type ExternalAgentCapabilityCell,
  type ExternalAgentCapabilityId,
  type ExternalAgentCapabilityProfileV1,
} from "@cognia/agent-config-types/external-agent-capability"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

const LEVEL_CLASS: Record<ExternalAgentCapabilityCell["level"], string> = {
  native: "text-emerald-700 dark:text-emerald-400",
  equivalent: "text-sky-700 dark:text-sky-400",
  unknown: "text-amber-700 dark:text-amber-400",
  unsupported: "text-muted-foreground",
}

export interface ExternalAgentCapabilityMatrixProps {
  profile: ExternalAgentCapabilityProfileV1 | null | undefined
  /** Hide `unsupported` rows, which are the majority for most protocols. */
  onlyAvailable?: boolean
  className?: string
}

export function ExternalAgentCapabilityMatrix({
  profile,
  onlyAvailable = false,
  className,
}: ExternalAgentCapabilityMatrixProps) {
  const t = useTranslations("externalAgent.capabilities")

  const rows = useMemo(() => {
    if (!profile) return []
    return EXTERNAL_AGENT_CAPABILITY_IDS.map((id: ExternalAgentCapabilityId) => ({
      id,
      cell: profile.effective[id],
    })).filter(({ cell }) => !onlyAvailable || cell.level !== "unsupported")
  }, [profile, onlyAvailable])

  if (!profile) {
    // Not an error state: a profile only exists after the handshake, and saying
    // "no capabilities" here would be a claim nobody has earned.
    return <p className="text-xs text-muted-foreground">{t("notNegotiated")}</p>
  }

  return (
    <div className={cn("grid gap-2 text-xs", className)} data-testid="external-agent-capabilities">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{t("protocol", { protocol: profile.protocol })}</Badge>
        <Badge variant={profile.negotiated ? "secondary" : "outline"}>
          {profile.negotiated ? t("negotiated") : t("declaredOnly")}
        </Badge>
        <span className="text-muted-foreground">
          {t("digest", { digest: profile.digest.slice(0, 14) })}
        </span>
      </div>

      {profile.drift.length > 0 && (
        <p
          className="text-amber-700 dark:text-amber-400"
          data-testid="external-agent-capability-drift"
        >
          {t("drift", {
            entries: profile.drift
              .map((entry) =>
                t("driftEntry", {
                  capability: entry.capability,
                  declared: entry.declaredLevel,
                  observed: entry.observedLevel,
                })
              )
              .join(" | "),
          })}
        </p>
      )}

      <ul className="grid gap-1">
        {rows.map(({ id, cell }) => (
          <li
            key={id}
            className="flex flex-wrap items-baseline gap-x-2"
            data-testid={`capability-${id}`}
          >
            <span className="font-mono">{id}</span>
            <span className={LEVEL_CLASS[cell.level]}>{t(`level.${cell.level}`)}</span>
            <span className="text-muted-foreground">{t(`evidence.${cell.evidence}`)}</span>
            {cell.reasonKey && (
              <span className="text-muted-foreground">
                {t.has(`reason.${cell.reasonKey}`) ? t(`reason.${cell.reasonKey}`) : cell.reasonKey}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
