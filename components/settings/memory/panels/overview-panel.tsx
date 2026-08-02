"use client"

import Link from "next/link"
import { motion } from "motion/react"
import { useTranslations } from "next-intl"
import {
  ArchiveIcon,
  BrainIcon,
  ExternalLinkIcon,
  ListChecksIcon,
  NotebookPenIcon,
  TriangleAlertIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { STAGGER_CHILD, STAGGER_CONTAINER, MOBILE_DURATION, MOBILE_EASE } from "@/lib/ui/motion"
import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { RollingNumber } from "@/components/settings/subagents/motion/rolling-number"
import { Button } from "@/components/ui/button"
import type { MemoryInsights } from "@/hooks/memory/use-memory-insights"
import { RetrievalModeAlert } from "../retrieval-mode-alert"

export interface OverviewPanelProps {
  insights: MemoryInsights
  onEnableHybrid: () => void
  onAllowCloudEmbedding: () => void
}

export function OverviewPanel({
  insights,
  onEnableHybrid,
  onAllowCloudEmbedding,
}: OverviewPanelProps) {
  const t = useTranslations("settings.memory.overview")
  const tTypes = useTranslations("memory.types")
  const tScopes = useTranslations("memory.scopes")
  const { reduce, durationScale } = useFlowMotion()
  const { corpus } = insights

  const coveragePct = Math.round(corpus.vector.coverage * 100)

  // One metric strip, not five cards: these are five readings of the same
  // corpus, so they belong in one divided container the eye scans across —
  // five bordered, shadowed, gradient-accented tiles inside an already-bordered
  // detail pane was chrome competing with a two-digit number.
  const stats = [
    {
      key: "active",
      label: t("stats.active"),
      value: corpus.stats.active,
      icon: <BrainIcon className="size-4" />,
      iconBgClassName: "bg-violet-500/15 text-violet-500",
    },
    {
      key: "semantic",
      label: tTypes("semantic"),
      value: corpus.stats.byType.semantic,
      icon: <NotebookPenIcon className="size-4" />,
      iconBgClassName: "bg-sky-500/15 text-sky-500",
    },
    {
      key: "episodic",
      label: tTypes("episodic"),
      value: corpus.stats.byType.episodic,
      icon: <ListChecksIcon className="size-4" />,
      iconBgClassName: "bg-emerald-500/15 text-emerald-500",
    },
    {
      key: "procedural",
      label: tTypes("procedural"),
      value: corpus.stats.byType.procedural,
      icon: <ArchiveIcon className="size-4" />,
      iconBgClassName: "bg-amber-500/15 text-amber-500",
    },
    {
      key: "conflicts",
      label: t("stats.conflicts"),
      value: corpus.stats.conflicts,
      icon: <TriangleAlertIcon className="size-4" />,
      iconBgClassName: "bg-red-500/15 text-red-500",
    },
  ]

  return (
    <div className="space-y-5">
      {/* Dividers come from a per-cell outline, not a `gap-px` over a
          border-coloured container: five readings never fill a 2- or 3-column
          grid evenly, and the container trick painted the leftover cell as a
          solid grey block. Outlines overlap, so neighbours share one hairline
          and the empty tail of the grid stays empty. */}
      <motion.dl
        className="grid grid-cols-2 overflow-hidden rounded-lg border border-border/60 @lg/memory-pane:grid-cols-3 @2xl/memory-pane:grid-cols-5"
        variants={reduce ? undefined : STAGGER_CONTAINER}
        initial={reduce ? undefined : "initial"}
        animate={reduce ? undefined : "animate"}
        data-testid="memory-stat-strip"
      >
        {stats.map((stat) => (
          <motion.div
            key={stat.key}
            variants={reduce ? undefined : STAGGER_CHILD}
            className="flex items-center gap-2.5 p-3 outline outline-border/60 -outline-offset-[0.5px]"
          >
            <span
              aria-hidden
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-md",
                stat.iconBgClassName
              )}
            >
              {stat.icon}
            </span>
            <span className="min-w-0">
              <dt className="truncate text-[10px] tracking-wider text-muted-foreground uppercase">
                {stat.label}
              </dt>
              <dd className="text-lg leading-tight font-bold tabular-nums">
                <RollingNumber value={stat.value} data-testid={`memory-stat-${stat.key}`} />
              </dd>
            </span>
          </motion.div>
        ))}
      </motion.dl>

      <RetrievalModeAlert
        mode={insights.retrievalMode}
        onEnableHybrid={onEnableHybrid}
        onAllowCloudEmbedding={onAllowCloudEmbedding}
      />

      <div className="space-y-1.5 border-t border-border/60 pt-4">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-xs font-medium">{t("coverage.title")}</p>
          <p className="text-xs tabular-nums text-muted-foreground">
            {t("coverage.readout", {
              percent: coveragePct,
              embedded: corpus.vector.embedded,
              active: corpus.vector.active,
            })}
          </p>
        </div>
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
          role="meter"
          aria-label={t("coverage.title")}
          aria-valuenow={coveragePct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <motion.div
            className="h-full rounded-full bg-sky-500"
            initial={reduce ? false : { width: 0 }}
            animate={{ width: `${coveragePct}%` }}
            transition={
              reduce
                ? { duration: 0 }
                : { duration: MOBILE_DURATION.slow * durationScale, ease: MOBILE_EASE }
            }
            data-testid="memory-coverage-bar"
          />
        </div>
        <p className="text-[11px] text-muted-foreground">{t("coverage.hint")}</p>
      </div>

      <div className="space-y-1.5 border-t border-border/60 pt-4">
        <p className="text-xs font-medium">{t("byScope.title")}</p>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 @2xl/memory-pane:grid-cols-4">
          {(["global", "workspace", "character", "agent"] as const).map((scope) => (
            <div key={scope} className="flex items-baseline justify-between gap-2">
              <dt className="truncate text-[11px] text-muted-foreground">{tScopes(scope)}</dt>
              <dd
                className={cn("text-xs font-medium tabular-nums")}
                data-testid={`memory-scope-count-${scope}`}
              >
                {corpus.byScope[scope]}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <Button asChild variant="outline" size="sm">
        <Link href="/memory">
          <ExternalLinkIcon className="size-3.5" />
          {t("manage")}
        </Link>
      </Button>
    </div>
  )
}
