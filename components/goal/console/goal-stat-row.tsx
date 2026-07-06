"use client"

/**
 * Two-cluster stat row for the Goals console Overview (ADR-0019).
 *
 * Unifies the previously-inconsistent stat-card behavior into two legible
 * clusters:
 *  - **Open** — Active / Paused are *filter* cards that scope the open-goals
 *    list (pressed ring, click again to clear). They never navigate away.
 *  - **Lifetime** — Completed / Avg turns / Token spend are read-only *metric*
 *    cards that switch the top section (Completed → History, the two averages →
 *    Analytics), signalled by a small "↗" affordance.
 *
 * Pure/presentational: the parent owns `statusFilter` + the section switcher, so
 * this component is trivially unit-testable without Dexie.
 */

import { useTranslations } from "next-intl"
import { motion } from "motion/react"
import {
  ActivityIcon,
  ArrowUpRightIcon,
  CheckCircle2Icon,
  CoinsIcon,
  PauseIcon,
  RepeatIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { StatCard } from "@/components/scheduler/stat-card"
import { STAGGER_CHILD, STAGGER_CONTAINER, useReducedMotionVariants } from "@/lib/ui/motion"
import type { GoalAnalytics } from "@/lib/goal/analytics"
import type { GoalConsoleTab } from "@/lib/goal/console-prefs"
import type { GoalStatus } from "@/types/goal"

export interface GoalStatRowProps {
  analytics: GoalAnalytics
  /** Currently-scoped open-goals status ("__all__" when unscoped). */
  statusFilter: string
  /** Toggle the open-goals scope to a status (or clear it). */
  onScope: (status: GoalStatus) => void
  /** Switch the console's top section. */
  onSwitchSection: (tab: GoalConsoleTab) => void
}

function kfmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

export function GoalStatRow({
  analytics,
  statusFilter,
  onScope,
  onSwitchSection,
}: GoalStatRowProps) {
  const t = useTranslations("goal")
  const container = useReducedMotionVariants(STAGGER_CONTAINER)
  const child = useReducedMotionVariants(STAGGER_CHILD)

  return (
    <div className="space-y-4" data-testid="goal-console-stats">
      {/* Open — filter cards */}
      <section>
        <ClusterLabel>{t("console.statGroups.open")}</ClusterLabel>
        <motion.div
          className="grid grid-cols-2 gap-3"
          variants={container}
          initial="initial"
          animate="animate"
        >
          <StatShortcut
            variants={child}
            actionLabel={t("console.stats.filterActive")}
            active={statusFilter === "active"}
            onActivate={() => onScope("active")}
            testid="goal-stat-active"
          >
            <StatCard
              label={t("console.stats.active")}
              value={analytics.active}
              icon={<ActivityIcon className="h-5 w-5 text-green-500" aria-hidden />}
              valueClassName="text-green-500"
              accentGradient="from-green-500 to-emerald-400"
              iconBgClassName="bg-green-500/10"
            />
          </StatShortcut>
          <StatShortcut
            variants={child}
            actionLabel={t("console.stats.filterPaused")}
            active={statusFilter === "paused"}
            onActivate={() => onScope("paused")}
            testid="goal-stat-paused"
          >
            <StatCard
              label={t("console.stats.paused")}
              value={analytics.paused}
              icon={<PauseIcon className="h-5 w-5 text-yellow-500" aria-hidden />}
              valueClassName="text-yellow-500"
              accentGradient="from-yellow-500 to-amber-400"
              iconBgClassName="bg-yellow-500/10"
            />
          </StatShortcut>
        </motion.div>
      </section>

      {/* Lifetime — metric cards that switch section */}
      <section>
        <ClusterLabel>{t("console.statGroups.lifetime")}</ClusterLabel>
        <motion.div
          className="grid grid-cols-1 gap-3 @sm/goal-console:grid-cols-3"
          variants={container}
          initial="initial"
          animate="animate"
        >
          <GoalMetricStat
            variants={child}
            actionLabel={t("console.stats.openHistory")}
            onActivate={() => onSwitchSection("history")}
            testid="goal-stat-done"
          >
            <StatCard
              label={t("console.stats.done")}
              value={analytics.completed}
              icon={<CheckCircle2Icon className="h-5 w-5 text-muted-foreground" aria-hidden />}
              valueClassName="text-foreground"
              accentGradient="from-border to-border/50"
              iconBgClassName="bg-muted/50"
            />
          </GoalMetricStat>
          <GoalMetricStat
            variants={child}
            actionLabel={t("console.stats.openAnalytics")}
            onActivate={() => onSwitchSection("analytics")}
            testid="goal-stat-avg-turns"
          >
            <StatCard
              label={t("console.stats.avgTurns")}
              value={analytics.avgTurns.toFixed(1)}
              icon={<RepeatIcon className="h-5 w-5 text-blue-500" aria-hidden />}
              valueClassName="text-blue-500"
              accentGradient="from-blue-500 to-sky-400"
              iconBgClassName="bg-blue-500/10"
            />
          </GoalMetricStat>
          <GoalMetricStat
            variants={child}
            actionLabel={t("console.stats.openAnalytics")}
            onActivate={() => onSwitchSection("analytics")}
            testid="goal-stat-token-spend"
          >
            <StatCard
              label={t("console.stats.tokenSpend")}
              value={kfmt(analytics.totalTokens)}
              icon={<CoinsIcon className="h-5 w-5 text-violet-500" aria-hidden />}
              valueClassName="text-violet-500"
              accentGradient="from-violet-500 to-purple-400"
              iconBgClassName="bg-violet-500/10"
            />
          </GoalMetricStat>
        </motion.div>
      </section>
    </div>
  )
}

function ClusterLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </p>
  )
}

/**
 * Filter card: the whole StatCard is a keyboard-reachable toggle. `active`
 * paints a ring when this card's status is the one scoping the open-goals list.
 */
function StatShortcut({
  actionLabel,
  active,
  onActivate,
  testid,
  variants,
  children,
}: {
  actionLabel: string
  active?: boolean
  onActivate: () => void
  testid: string
  variants: ReturnType<typeof useReducedMotionVariants>
  children: React.ReactNode
}) {
  return (
    <motion.div
      variants={variants}
      role="button"
      tabIndex={0}
      aria-label={actionLabel}
      aria-pressed={active}
      data-testid={testid}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onActivate()
        }
      }}
      className={cn(
        "cursor-pointer rounded-xl outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring",
        active && "ring-2 ring-primary"
      )}
    >
      {children}
    </motion.div>
  )
}

/**
 * Metric card: a keyboard-reachable shortcut that switches the top section. The
 * "↗" overlay lives on this (relative, non-clipping) wrapper — never inside the
 * shared `StatCard` primitive, which is `overflow-hidden`.
 */
function GoalMetricStat({
  actionLabel,
  onActivate,
  testid,
  variants,
  children,
}: {
  actionLabel: string
  onActivate: () => void
  testid: string
  variants: ReturnType<typeof useReducedMotionVariants>
  children: React.ReactNode
}) {
  return (
    <motion.div
      variants={variants}
      role="button"
      tabIndex={0}
      aria-label={actionLabel}
      data-testid={testid}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onActivate()
        }
      }}
      className="group relative cursor-pointer rounded-xl outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowUpRightIcon
        className="pointer-events-none absolute right-2 top-2 z-10 size-3.5 text-muted-foreground/50 transition-colors group-hover:text-foreground"
        aria-hidden
      />
      {children}
    </motion.div>
  )
}

GoalStatRow.displayName = "GoalStatRow"
