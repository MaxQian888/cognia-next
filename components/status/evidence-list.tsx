"use client"

/**
 * What each observer last saw for one component.
 *
 * One row per probe × client profile: where the evidence came from
 * (Cloudflare or an external host), which client profile it imitates, the
 * result with its translated reason, when it was checked and whether that is
 * still fresh. Origin-header profiles are labelled as simulated, because a
 * probe sending a mobile Origin is not a phone on a mobile network.
 */

import { useLocale, useTranslations } from "next-intl"
import { CheckCircle2Icon, CircleHelpIcon, CircleXIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  pickLocalized,
  type CheckResult,
  type EvidenceSummary,
  type ProbeSummary,
} from "@/lib/status/public-status"
import { cn } from "@/lib/utils"

import { formatUtcDateTime } from "./status-format"

const RESULT_STYLE: Record<CheckResult, { icon: typeof CheckCircle2Icon; text: string }> = {
  pass: { icon: CheckCircle2Icon, text: "text-emerald-700 dark:text-emerald-300" },
  fail: { icon: CircleXIcon, text: "text-rose-700 dark:text-rose-300" },
  unknown: { icon: CircleHelpIcon, text: "text-muted-foreground" },
}

export function EvidenceList({
  evidence,
  probes,
}: {
  evidence: readonly EvidenceSummary[]
  probes: readonly ProbeSummary[]
}) {
  const t = useTranslations("publicStatus")
  const locale = useLocale()

  if (evidence.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("evidence.empty")}</p>
  }

  return (
    <ul className="divide-y border-y" data-testid="evidence-list">
      {evidence.map((item) => {
        const probe = probes.find((candidate) => candidate.id === item.probeId)
        const style = RESULT_STYLE[item.result]
        const Icon = style.icon
        return (
          <li
            key={`${item.probeId}:${item.profileId}`}
            className="grid gap-2 py-3 text-sm"
            data-testid="evidence-row"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">
                {probe ? pickLocalized(probe.label, locale) : item.probeId}
              </span>
              <span
                className={cn("inline-flex items-center gap-1.5 text-xs font-medium", style.text)}
              >
                <Icon className="size-3.5" aria-hidden />
                {t(`results.${item.result}`)}
                {item.reason ? (
                  <span className="font-normal text-muted-foreground">
                    · {t(`reasons.${item.reason}`)}
                  </span>
                ) : null}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className="font-normal">
                {t(`sources.${item.source}`)}
              </Badge>
              <Badge variant="outline" className="font-normal">
                {t(`profiles.${item.profileId}`)}
              </Badge>
              {item.reference ? (
                <Badge variant="secondary" className="font-normal">
                  {t("evidence.reference")}
                </Badge>
              ) : null}
              <Badge
                variant="outline"
                className={cn(
                  "font-normal",
                  item.fresh ? "text-foreground" : "text-amber-800 dark:text-amber-300"
                )}
              >
                {item.fresh ? t("evidence.fresh") : t("evidence.stale")}
              </Badge>
            </div>
            {item.simulatedOrigin ? (
              <p className="text-xs text-muted-foreground">{t("evidence.simulatedOrigin")}</p>
            ) : null}
            <p className="flex flex-wrap gap-x-3 font-mono text-xs text-muted-foreground tabular-nums">
              <span>
                {item.checkedAt
                  ? t("evidence.checkedAt", { time: formatUtcDateTime(item.checkedAt, locale) })
                  : t("evidence.neverChecked")}
              </span>
              {item.consecutiveFailures > 0 ? (
                <span>
                  {t("evidence.consecutiveFailures", { count: item.consecutiveFailures })}
                </span>
              ) : null}
            </p>
          </li>
        )
      })}
    </ul>
  )
}
