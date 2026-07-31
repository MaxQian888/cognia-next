"use client"

import { useTranslations } from "next-intl"
import { ShieldCheckIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import type { SkillsShRisk } from "@/lib/skills/marketplace-skillssh"
import type { AuditEntry } from "@/hooks/skills"

/** Risk level → Badge variant, following the security-scanner convention. */
const RISK_VARIANT: Record<SkillsShRisk, "default" | "secondary" | "outline" | "destructive"> = {
  safe: "secondary",
  low: "secondary",
  medium: "default",
  high: "destructive",
  critical: "destructive",
  unknown: "outline",
}

const RISK_DOT: Record<SkillsShRisk, string> = {
  safe: "bg-emerald-500",
  low: "bg-emerald-500",
  medium: "bg-amber-500",
  high: "bg-destructive",
  critical: "bg-destructive",
  unknown: "bg-muted-foreground/40",
}

interface Props {
  audit: AuditEntry | undefined
  /** Compact = single worst-risk dot for list rows. */
  compact?: boolean
  className?: string
}

/**
 * Per-provider security-audit badges (Socket / Snyk / ZeroLeaks / Agent Trust
 * Hub) for skills.sh items. Full mode renders one pill per provider; compact
 * mode collapses to a worst-risk dot. Renders nothing until the lazy fetch
 * resolved (undefined) in compact mode.
 */
export function SkillAuditBadges({ audit, compact = false, className }: Props) {
  const t = useTranslations("skills.marketplace.audit")

  if (compact) {
    if (audit === undefined || audit === "loading" || audit === null) return null
    return (
      <span
        data-testid="skill-audit-dot"
        title={t(`risk.${audit.worstRisk}`)}
        aria-label={t(`risk.${audit.worstRisk}`)}
        className={cn(
          "inline-block size-2 shrink-0 rounded-full",
          RISK_DOT[audit.worstRisk],
          className
        )}
      />
    )
  }

  return (
    <section className={className} aria-label={t("ariaLabel")} data-testid="skill-audit-badges">
      <h4 className="flex items-center gap-1.5 text-xs font-medium">
        <ShieldCheckIcon className="size-3.5" />
        {t("title")}
      </h4>
      <div className="mt-1.5">
        {audit === "loading" || audit === undefined ? (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            {t("loading")}
          </span>
        ) : audit === null ? (
          <span className="text-xs text-muted-foreground">{t("noData")}</span>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {audit.providers.map((p) => (
              <Badge
                key={p.provider}
                variant={RISK_VARIANT[p.risk]}
                className="h-5 gap-1 text-[10px]"
                title={p.summary}
              >
                <span className={cn("size-1.5 rounded-full", RISK_DOT[p.risk])} />
                {p.provider}
                {" · "}
                {t(`risk.${p.risk}`)}
                {typeof p.score === "number" ? ` (${p.score})` : null}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
