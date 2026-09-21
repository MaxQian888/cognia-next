"use client"

/**
 * The acceptance report of a delegate run, as a table (ADR-0188 B4, DEL-01…03).
 *
 * Three rules are visible in what this renders, because they are the whole
 * point of the report:
 *
 * - the sandbox tier shown is the one the runner ATTESTED. A report that does
 *   not name a tier says "not attested" in amber — never the tier that was
 *   requested, and never silence, which would read as "it was sandboxed";
 * - the revision shown is the one the report is about. A report with no
 *   revision cannot prove anything about the delivered change, and says so;
 * - a check the runtime did not execute is labelled with who did, next to the
 *   note that only a runtime check is evidence (DEL-01).
 *
 * Counts are `null` when the report carries none; they render as "—" rather
 * than as zero, because "no tests discovered" and "the report did not say" are
 * different findings (DEL-02).
 */

import { useTranslations } from "next-intl"
import { AlertTriangleIcon, CheckCircle2Icon, CircleHelpIcon, XCircleIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

import { RunDetailRow } from "./fusion-run-details"
import {
  DELEGATE_VERIFICATION_LEVELS,
  type DelegateAcceptanceView,
  type DelegateCheckStatusView,
} from "./delegate-review-model"

const STATUS_ICON: Record<DelegateCheckStatusView, typeof CheckCircle2Icon> = {
  passed: CheckCircle2Icon,
  failed: XCircleIcon,
  inconclusive: CircleHelpIcon,
  not_applicable: CircleHelpIcon,
}

const STATUS_CLASS: Record<DelegateCheckStatusView, string> = {
  passed: "text-emerald-600 dark:text-emerald-400",
  failed: "text-red-600 dark:text-red-400",
  // Amber, not green: a report nobody could read is a question, not a pass.
  inconclusive: "text-amber-600 dark:text-amber-400",
  not_applicable: "text-muted-foreground",
}

const warnText = "text-amber-600 dark:text-amber-400"

export interface DelegateChecksTableProps {
  acceptance: DelegateAcceptanceView | null
}

export function DelegateChecksTable({ acceptance }: DelegateChecksTableProps) {
  const t = useTranslations("routerFusionDelegate.checks")

  if (!acceptance) {
    return (
      <section className="space-y-1" data-testid="delegate-checks">
        <h4 className="text-xs font-medium">{t("title")}</h4>
        <p role="status" className={cn("text-[11px]", warnText)}>
          {t("none")}
        </p>
      </section>
    )
  }

  const StatusIcon = STATUS_ICON[acceptance.status]
  const number = (value: number | null) => (value === null ? "—" : String(value))
  const hasCounts =
    acceptance.discovered !== null ||
    acceptance.passed !== null ||
    acceptance.failed !== null ||
    acceptance.skipped !== null
  const levelKnown = (DELEGATE_VERIFICATION_LEVELS as readonly string[]).includes(acceptance.level)

  return (
    <section className="space-y-1.5 text-xs" data-testid="delegate-checks">
      <div className="flex items-center gap-2">
        <h4 className="text-xs font-medium">{t("title")}</h4>
        <span
          className={cn("flex items-center gap-1 font-medium", STATUS_CLASS[acceptance.status])}
        >
          <StatusIcon className="size-3.5 shrink-0" aria-hidden />
          {t(`status.${acceptance.status}`)}
        </span>
      </div>

      <dl className="space-y-1.5">
        <RunDetailRow label={t("tier")}>
          {acceptance.tier ? (
            <Badge variant="outline" className="h-4 px-1 text-[10px] font-normal">
              {t(`tierValue.${acceptance.tier}`)}
            </Badge>
          ) : (
            <span className={warnText} data-testid="delegate-checks-tier-unattested">
              {t("tierUnattested")}
            </span>
          )}
        </RunDetailRow>
        <RunDetailRow label={t("revision")}>
          {acceptance.revision ? (
            <span className="font-mono text-[10px]">{acceptance.revision}</span>
          ) : (
            <span className={warnText}>{t("revisionMissing")}</span>
          )}
        </RunDetailRow>
        <RunDetailRow label={t("verifier")}>
          <span className="font-mono text-[10px]">
            {levelKnown ? t(`level.${acceptance.level}` as never) : acceptance.level} ·{" "}
            {acceptance.verifierVersion}
          </span>
        </RunDetailRow>
        {acceptance.exit !== null ? (
          <RunDetailRow label={t("exit")}>
            <span className="font-mono text-[10px]">{acceptance.exit}</span>
          </RunDetailRow>
        ) : null}
        {acceptance.report !== null ? (
          <RunDetailRow label={t("report")}>
            <span className="font-mono text-[10px]">{acceptance.report}</span>
          </RunDetailRow>
        ) : null}
      </dl>

      {hasCounts ? (
        <p className="tabular-nums text-muted-foreground" data-testid="delegate-checks-counts">
          {t("counts", {
            discovered: number(acceptance.discovered),
            passed: number(acceptance.passed),
            failed: number(acceptance.failed),
            skipped: number(acceptance.skipped),
          })}
          {acceptance.errored !== null && acceptance.errored > 0 ? (
            <span className={cn("ml-1", warnText)}>
              {t("errored", { count: acceptance.errored })}
            </span>
          ) : null}
        </p>
      ) : (
        <p className={cn("text-[11px]", warnText)}>{t("countsUnknown")}</p>
      )}

      {acceptance.checks.length > 0 ? (
        <table className="w-full table-fixed border-collapse text-[11px]">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="w-1/3 py-1 font-normal">{t("check")}</th>
              <th className="w-20 py-1 font-normal">{t("outcome")}</th>
              <th className="py-1 font-normal">{t("summary")}</th>
            </tr>
          </thead>
          <tbody>
            {acceptance.checks.map((check) => (
              <tr key={check.checkId} className="border-t align-top">
                <td className="py-1 pr-2 font-mono break-words">{check.checkId}</td>
                <td className={cn("py-1 pr-2", STATUS_CLASS[check.status])}>
                  {t(`status.${check.status}`)}
                </td>
                <td className="py-1 break-words">
                  {check.summary}
                  {check.executedBy !== "runtime" ? (
                    <Badge variant="outline" className="ml-1 h-4 px-1 text-[10px] font-normal">
                      {t(`executedBy.${check.executedBy}`)}
                    </Badge>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {acceptance.hasModelCheck ? (
        <p className={cn("flex items-start gap-1.5 text-[11px]", warnText)}>
          <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
          {t("modelClaim")}
        </p>
      ) : null}
    </section>
  )
}
