"use client"

/**
 * Step 8 — the independent reviewer's verdict (ADR-0117).
 *
 * The reviewer's own resolved authority is displayed rather than assumed. If a
 * future change ever handed the reviewer write access, this line is where it
 * becomes visible instead of staying a property nobody checks.
 */

import { useTranslations } from "next-intl"
import { CircleAlert, Info } from "lucide-react"

import { cn } from "@/lib/utils"
import type { CreatorReviewFinding, CreatorReviewVerdict } from "@/types/creator"

export interface ReviewPanelProps {
  verdict: CreatorReviewVerdict | null
  className?: string
}

export function ReviewPanel({ verdict, className }: ReviewPanelProps) {
  const t = useTranslations("creator.review")

  return (
    <section className={cn("space-y-3 rounded-lg border p-4", className)}>
      <h2 className="text-sm font-medium">{t("title")}</h2>
      <p className="text-xs text-muted-foreground">{t("readOnly")}</p>

      {!verdict ? (
        <p className="text-sm text-muted-foreground">{t("pending")}</p>
      ) : (
        <div className="space-y-2">
          <p
            className={cn("text-sm", verdict.approved ? "text-emerald-600" : "text-destructive")}
            role="status"
          >
            {verdict.approved ? t("approved") : t("rejected")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("authority", { authority: verdict.reviewerAuthority })}
          </p>
          {verdict.findings.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noFindings")}</p>
          ) : (
            <ul className="space-y-1">
              {verdict.findings.map((finding) => (
                <FindingRow key={finding.id} finding={finding} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

function FindingRow({ finding }: { finding: CreatorReviewFinding }) {
  const t = useTranslations("creator.review.severity")
  const Icon =
    finding.severity === "blocker"
      ? CircleAlert
      : finding.severity === "warning"
        ? CircleAlert
        : Info
  const tone =
    finding.severity === "blocker"
      ? "text-destructive"
      : finding.severity === "warning"
        ? "text-amber-600"
        : "text-muted-foreground"

  return (
    <li className="flex items-start gap-2 text-sm">
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", tone)} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className={cn("text-xs font-medium", tone)}>{t(finding.severity)}</span>
        <span className="ml-2">{finding.summary}</span>
        {finding.path ? (
          <span className="block break-all font-mono text-xs text-muted-foreground">
            {finding.path}
          </span>
        ) : null}
      </span>
    </li>
  )
}

export default ReviewPanel
