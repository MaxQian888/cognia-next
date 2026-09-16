"use client"

/**
 * Where this agent's run actually ended up (ADR-0182).
 *
 * The standing counterpart of the runtime-environment panel: the panel says
 * what a run would ASK for, this says what the Host ANSWERED — the tier it
 * attested, the user the image really runs as, the digest it pulled, and
 * whether egress and credentials are actually confined. Those three can all
 * differ from the request, so this is the only surface allowed to state them.
 *
 * Renders nothing for an agent that never asked for a runtime environment, so
 * a deployment with the pool off sees no trace of it (Q39) and call sites can
 * mount it unconditionally.
 */

import { useTranslations } from "next-intl"
import { BanIcon, BoxIcon, HourglassIcon, TriangleAlertIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useSandboxPlacement } from "@/hooks/sandbox/use-sandbox-placement"
import {
  FALLBACK_KEYS,
  HOST_FALLBACK_KEYS,
  outcomeMessageValues,
  REFUSAL_KEYS,
} from "@/lib/sandbox/environment-outcome-message"
import type { SandboxPlacementReport } from "@/lib/sandbox/placement-report"
import { cn } from "@/lib/utils"

export interface SandboxPlacementBadgeProps {
  agentId: string
  className?: string
}

export function SandboxPlacementBadge({ agentId, className }: SandboxPlacementBadgeProps) {
  const t = useTranslations("externalAgent.placement")
  const tOutcome = useTranslations("projectEnvironment.outcome")
  const { requested, report } = useSandboxPlacement(agentId)

  // The Host's answer wins whenever there is one: it is what happened.
  if (report?.kind === "sandbox") {
    return <Sandboxed report={report} className={className} />
  }

  if (report?.kind === "fallback") {
    const key = report.code ? HOST_FALLBACK_KEYS[report.code] : undefined
    return (
      <Labeled
        testId="sandbox-placement-fallback"
        variant="outline"
        icon={<TriangleAlertIcon className="size-3" aria-hidden="true" />}
        label={t("fallback")}
        className={cn("border-amber-500/60 text-amber-700 dark:text-amber-400", className)}
        lines={[
          key ? tOutcome(key) : tOutcome("hostFallback.unknown", { code: report.code ?? "" }),
        ]}
      />
    )
  }

  if (report?.kind === "unknown") {
    return (
      <Labeled
        testId="sandbox-placement-unknown"
        variant="outline"
        label={t("unknown")}
        className={className}
        lines={[]}
      />
    )
  }

  // No answer yet: say what was asked, never what was granted.
  if (!requested || requested.kind === "off") return null

  if (requested.kind === "refused") {
    return (
      <Labeled
        testId="sandbox-placement-refused"
        variant="destructive"
        icon={<BanIcon className="size-3" aria-hidden="true" />}
        label={t("refused")}
        className={className}
        lines={[tOutcome(REFUSAL_KEYS[requested.code], outcomeMessageValues(requested.detail))]}
      />
    )
  }

  if (requested.kind === "fallback") {
    return (
      <Labeled
        testId="sandbox-placement-fallback"
        variant="outline"
        icon={<TriangleAlertIcon className="size-3" aria-hidden="true" />}
        label={t("fallback")}
        className={cn("border-amber-500/60 text-amber-700 dark:text-amber-400", className)}
        lines={[tOutcome(FALLBACK_KEYS[requested.code])]}
      />
    )
  }

  return (
    <Labeled
      testId="sandbox-placement-pending"
      variant="outline"
      icon={<HourglassIcon className="size-3" aria-hidden="true" />}
      label={t("pending")}
      className={className}
      lines={[t("pendingTooltip")]}
    />
  )
}

function Sandboxed({ report, className }: { report: SandboxPlacementReport; className?: string }) {
  const t = useTranslations("externalAgent.placement")
  const tTier = useTranslations("projectEnvironment.runtime.tier")
  const notReported = t("tooltip.notReported")
  const tier = report.tier ? tTier(report.tier) : undefined
  const egressTier = report.egressTier ?? notReported
  const lines = [
    report.image ? t("tooltip.image", { image: report.image }) : undefined,
    tier ? t("tooltip.tier", { tier }) : undefined,
    report.user
      ? report.userRemapped
        ? t("tooltip.userRemapped", { user: report.user })
        : t("tooltip.user", { user: report.user })
      : undefined,
    report.bundleReleaseTag
      ? t("tooltip.bundle", { tag: report.bundleReleaseTag, libc: report.libc ?? notReported })
      : undefined,
    // Only an explicit answer is rendered: a Host that did not say whether
    // egress is enforced has not said it is unenforced either.
    report.egressEnforced === true
      ? t("tooltip.egressEnforced", { tier: egressTier })
      : report.egressEnforced === false
        ? t("tooltip.egressNotEnforced", { tier: egressTier })
        : undefined,
    report.credentialsMode ? t("tooltip.credentials", { mode: report.credentialsMode }) : undefined,
  ].filter((line): line is string => line !== undefined)

  return (
    <Labeled
      testId="sandbox-placement-sandboxed"
      variant="secondary"
      icon={<BoxIcon className="size-3" aria-hidden="true" />}
      label={tier ? t("sandboxed", { tier }) : t("sandboxedUntiered")}
      className={className}
      lines={lines}
    />
  )
}

function Labeled({
  testId,
  variant,
  icon,
  label,
  className,
  lines,
}: {
  testId: string
  variant: "secondary" | "outline" | "destructive"
  icon?: React.ReactNode
  label: string
  className?: string
  lines: string[]
}) {
  const badge = (
    <Badge variant={variant} className={cn("gap-1", className)} data-testid={testId}>
      {icon}
      {label}
    </Badge>
  )
  if (lines.length === 0) return badge
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent className="max-w-xs space-y-0.5">
        {lines.map((line) => (
          <p key={line} className="break-all text-xs">
            {line}
          </p>
        ))}
      </TooltipContent>
    </Tooltip>
  )
}
