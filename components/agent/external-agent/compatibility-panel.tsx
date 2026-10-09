"use client"

/**
 * How closely Cognia's integration with the selected agent follows the
 * protocol's reference behaviour (the benchmark adaptation map, see
 * `ExternalAgentBenchmarkCapabilityEntry`).
 *
 * The map is an engineering record, so the panel leads with what a person can
 * act on: one sentence saying what the list is, a count per status, and one
 * line per entry. Reference vs. Cognia behaviour, evidence and a deviation's
 * reasoning sit behind each entry's own toggle instead of being printed for
 * every entry at once, which made eleven entries read as a wall of text.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDown } from "lucide-react"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import type {
  ExternalAgentBenchmarkAdaptationStatus,
  ExternalAgentBenchmarkCapabilityEntry,
  ExternalAgentBenchmarkGapGrade,
} from "@/types/agent/external-agent"

export interface ExternalAgentCompatibilityPanelProps {
  entries: readonly ExternalAgentBenchmarkCapabilityEntry[]
  className?: string
}

/** Display order: what needs attention first, settled work last. */
const STATUS_ORDER: readonly ExternalAgentBenchmarkAdaptationStatus[] = [
  "in-progress",
  "not-started",
  "intentional-deviation",
  "validated",
]

const STATUS_CLASS: Record<ExternalAgentBenchmarkAdaptationStatus, string> = {
  validated: "text-emerald-700 dark:text-emerald-400",
  "in-progress": "text-sky-700 dark:text-sky-400",
  "not-started": "text-muted-foreground",
  "intentional-deviation": "text-amber-700 dark:text-amber-400",
}

const STATUS_DOT: Record<ExternalAgentBenchmarkAdaptationStatus, string> = {
  validated: "bg-emerald-500",
  "in-progress": "bg-sky-500",
  "not-started": "bg-muted-foreground/50",
  "intentional-deviation": "bg-amber-500",
}

const GAP_CLASS: Record<ExternalAgentBenchmarkGapGrade, string> = {
  blocking: "text-destructive",
  major: "text-amber-700 dark:text-amber-400",
  minor: "text-muted-foreground",
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

function EntryRow({ entry }: { entry: ExternalAgentBenchmarkCapabilityEntry }) {
  const t = useTranslations("externalAgent.manager.diagnostics")
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <li
        className="rounded-lg transition-colors data-[state=open]:bg-muted/40"
        data-testid={`compatibility-entry-${entry.id}`}
      >
        <CollapsibleTrigger
          className="group flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`${entry.title} — ${open ? t("hideDetails") : t("showDetails")}`}
        >
          <span
            className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[entry.status])}
            aria-hidden
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{entry.title}</span>
            <span className={cn("block text-[11px]", GAP_CLASS[entry.gapGrade])}>
              {t(`gapGrade.${entry.gapGrade}`)}
            </span>
          </span>
          <span className={cn("hidden shrink-0 text-[11px] sm:inline", STATUS_CLASS[entry.status])}>
            {t(`compatibilityStatus.${entry.status}`)}
          </span>
          <ChevronDown
            className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180 motion-reduce:transition-none"
            aria-hidden
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down motion-reduce:animate-none">
          {/* Indented under the title (past the status dot) instead of boxed. */}
          <dl className="space-y-2 pt-1 pr-3 pb-3 pl-7 text-xs">
            <Detail label={t("compatibilityField.target")}>{entry.adaptationTarget}</Detail>
            {entry.referenceBehavior && (
              <Detail label={t("compatibilityField.reference")}>{entry.referenceBehavior}</Detail>
            )}
            {entry.cogniaBehavior && (
              <Detail label={t("compatibilityField.cognia")}>{entry.cogniaBehavior}</Detail>
            )}
            {entry.status === "validated" && (
              <Detail label={t("compatibilityField.evidence")}>
                {entry.evidence.length > 0 ? (
                  <span className="font-mono text-[11px]">
                    {entry.evidence.map((item) => item.reference).join(", ")}
                  </span>
                ) : (
                  t("evidenceMissing")
                )}
              </Detail>
            )}
            {entry.status === "intentional-deviation" && entry.deviation && (
              <>
                <Detail label={t("compatibilityField.rationale")}>
                  {entry.deviation.rationale}
                </Detail>
                <Detail label={t("compatibilityField.tradeOff")}>{entry.deviation.tradeOff}</Detail>
                <Detail label={t("compatibilityField.userImpact")}>
                  {entry.deviation.userImpact}
                </Detail>
                <Detail label={t("compatibilityField.review")}>
                  {entry.deviation.review.reviewLink ? (
                    <a
                      href={entry.deviation.review.reviewLink}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-2"
                    >
                      {entry.deviation.review.reviewedBy}
                    </a>
                  ) : (
                    entry.deviation.review.reviewedBy
                  )}
                </Detail>
              </>
            )}
          </dl>
        </CollapsibleContent>
      </li>
    </Collapsible>
  )
}

export function ExternalAgentCompatibilityPanel({
  entries,
  className,
}: ExternalAgentCompatibilityPanelProps) {
  const t = useTranslations("externalAgent.manager.diagnostics")
  const sorted = useMemo(
    () =>
      [...entries].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)),
    [entries]
  )
  const counts = useMemo(() => {
    const byStatus = new Map<ExternalAgentBenchmarkAdaptationStatus, number>()
    for (const entry of entries) byStatus.set(entry.status, (byStatus.get(entry.status) ?? 0) + 1)
    return STATUS_ORDER.flatMap((status) => {
      const count = byStatus.get(status)
      return count ? [{ status, count }] : []
    })
  }, [entries])

  return (
    <div className={cn("space-y-3", className)} data-testid="external-agent-benchmark-adaptation">
      <p className="text-xs text-muted-foreground">{t("compatibilityDesc")}</p>
      {entries.length === 0 ? (
        <p className="py-10 text-center text-xs text-muted-foreground">
          {t("noBenchmarkAdaptation")}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-x-4 gap-y-1" data-testid="compatibility-summary">
            {counts.map(({ status, count }) => (
              <span key={status} className="inline-flex items-center gap-1.5 text-xs">
                <span className={cn("size-1.5 rounded-full", STATUS_DOT[status])} aria-hidden />
                <span className="text-muted-foreground">{t(`compatibilityStatus.${status}`)}</span>
                <span className="font-medium tabular-nums">{count}</span>
              </span>
            ))}
          </div>
          <ul className="-mx-2 space-y-0.5">
            {sorted.map((entry) => (
              <EntryRow key={entry.id} entry={entry} />
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
