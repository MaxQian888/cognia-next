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
import { StatCard } from "@/components/scheduler/stat-card"
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
  const { reduce, speed } = useFlowMotion()
  const { corpus } = insights

  const coveragePct = Math.round(corpus.vector.coverage * 100)

  const cards = [
    {
      key: "active",
      label: t("stats.active"),
      value: corpus.stats.active,
      icon: <BrainIcon className="size-4" />,
      accentGradient: "from-violet-500 to-purple-400",
      iconBgClassName: "bg-violet-500/15 text-violet-500",
    },
    {
      key: "semantic",
      label: tTypes("semantic"),
      value: corpus.stats.byType.semantic,
      icon: <NotebookPenIcon className="size-4" />,
      accentGradient: "from-sky-500 to-cyan-400",
      iconBgClassName: "bg-sky-500/15 text-sky-500",
    },
    {
      key: "episodic",
      label: tTypes("episodic"),
      value: corpus.stats.byType.episodic,
      icon: <ListChecksIcon className="size-4" />,
      accentGradient: "from-emerald-500 to-green-400",
      iconBgClassName: "bg-emerald-500/15 text-emerald-500",
    },
    {
      key: "procedural",
      label: tTypes("procedural"),
      value: corpus.stats.byType.procedural,
      icon: <ArchiveIcon className="size-4" />,
      accentGradient: "from-amber-500 to-orange-400",
      iconBgClassName: "bg-amber-500/15 text-amber-500",
    },
    {
      key: "conflicts",
      label: t("stats.conflicts"),
      value: corpus.stats.conflicts,
      icon: <TriangleAlertIcon className="size-4" />,
      accentGradient: "from-red-500 to-rose-400",
      iconBgClassName: "bg-red-500/15 text-red-500",
    },
  ]

  return (
    <div className="space-y-4">
      <motion.div
        className="grid grid-cols-2 gap-2 @2xl/memory-pane:grid-cols-5"
        variants={reduce ? undefined : STAGGER_CONTAINER}
        initial={reduce ? undefined : "initial"}
        animate={reduce ? undefined : "animate"}
      >
        {cards.map((card) => (
          <motion.div key={card.key} variants={reduce ? undefined : STAGGER_CHILD}>
            <StatCard
              label={card.label}
              value={<RollingNumber value={card.value} data-testid={`memory-stat-${card.key}`} />}
              icon={card.icon}
              accentGradient={card.accentGradient}
              iconBgClassName={card.iconBgClassName}
              size="sm"
              className="h-full"
            />
          </motion.div>
        ))}
      </motion.div>

      <RetrievalModeAlert
        mode={insights.retrievalMode}
        onEnableHybrid={onEnableHybrid}
        onAllowCloudEmbedding={onAllowCloudEmbedding}
      />

      <div className="space-y-1.5 rounded-lg border p-3">
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
                : { duration: MOBILE_DURATION.slow * speed, ease: MOBILE_EASE }
            }
            data-testid="memory-coverage-bar"
          />
        </div>
        <p className="text-[11px] text-muted-foreground">{t("coverage.hint")}</p>
      </div>

      <div className="space-y-1.5 rounded-lg border p-3">
        <p className="text-xs font-medium">{t("byScope.title")}</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 @2xl/memory-pane:grid-cols-4">
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
