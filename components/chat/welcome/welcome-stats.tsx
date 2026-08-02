"use client"

/**
 * Usage dashboard for the chat welcome page.
 *
 * Turns the landing screen into something worth landing on: a compact stat grid
 * (sessions / turns / tokens / cost / streaks / peak hour / top model), the
 * shared calendar heatmap, and a per-model breakdown — all over the trailing
 * window the user picks.
 *
 * Data unification is the point. Every figure comes from `useActivityStats`,
 * which reads the same `sessionUsage` table as Subscription → Usage through the
 * same pure helpers, and the heatmap is literally the same `UsageHeatmap`
 * component that tab renders. The window options match the tab's (7 / 30 / 90
 * days — `sessionUsage` is pruned at 90, so a longer one would be a lie).
 *
 * Layout is container-query driven, not viewport driven: the welcome page also
 * renders inside a split-view chat pane, so the grid has to reflow from its own
 * width (2 columns narrow → 4 wide) exactly like the starter cards above it.
 *
 * Customization lives on `AppSettings.welcomeStats` (see
 * `lib/chat/welcome-stats-prefs.ts`): which tiles appear, whether the heatmap is
 * drawn, the active face, the window, and the ✕ that hides the panel outright.
 * Settings → Appearance → Personalization brings it back.
 */

import { useMemo } from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  ClockIcon,
  CoinsIcon,
  CpuIcon,
  FlameIcon,
  HashIcon,
  LayersIcon,
  MessagesSquareIcon,
  Settings2Icon,
  SparklesIcon,
  TrophyIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { SectionHeading } from "@/components/chat/empty-state"
import { UsageHeatmap } from "@/components/usage/usage-heatmap"

import { useSettingsStore } from "@/stores/settings"
import { useActivityStats } from "@/hooks/usage/use-activity-stats"
import {
  resolveWelcomeStatsPrefs,
  WELCOME_STAT_IDS,
  WELCOME_STATS_RANGE_DAYS,
  WELCOME_STATS_VIEWS,
  type WelcomeStatId,
  type WelcomeStatsPrefs,
  type WelcomeStatsView,
} from "@/lib/chat/welcome-stats-prefs"
import type { ActivityStats } from "@/lib/usage/activity-stats"
import { formatCostInCurrency, formatTokens } from "@/types/system/usage"
import { cn } from "@/lib/utils"

/** Icon per tile — the only per-tile presentation that isn't derived. */
const TILE_ICONS: Record<WelcomeStatId, LucideIcon> = {
  sessions: MessagesSquareIcon,
  turns: HashIcon,
  tokens: SparklesIcon,
  cost: CoinsIcon,
  activeDays: LayersIcon,
  currentStreak: FlameIcon,
  longestStreak: TrophyIcon,
  peakHour: ClockIcon,
  topModel: CpuIcon,
}

/**
 * One tile's display value. Numbers stay locale-formatted, tokens and cost go
 * through the shared usage formatters (so "1.2M" / "$3.40" read identically to
 * the usage tab), and the two string tiles fall back to an em dash when empty.
 */
function tileValue(
  id: WelcomeStatId,
  stats: ActivityStats,
  fmt: {
    number: (n: number) => string
    hour: (h: number) => string
    streak: (days: number) => string
    none: string
  }
): string {
  switch (id) {
    case "sessions":
      return fmt.number(stats.sessions)
    case "turns":
      return fmt.number(stats.turns)
    case "tokens":
      return formatTokens(stats.totalTokens)
    case "cost":
      return formatCostInCurrency(stats.costUsd, "USD")
    case "activeDays":
      return fmt.number(stats.activeDays)
    case "currentStreak":
      return fmt.streak(stats.currentStreak)
    case "longestStreak":
      return fmt.streak(stats.longestStreak)
    case "peakHour":
      return stats.peakHour == null ? fmt.none : fmt.hour(stats.peakHour)
    case "topModel":
      return stats.topModel ?? fmt.none
  }
}

/**
 * Quiet stat tile. Bordered rather than card-elevated: the welcome page is
 * card-less by design, but a dense grid of numbers still needs an edge to read
 * as a grid instead of loose text.
 */
function StatTile({
  label,
  value,
  icon: Icon,
  testid,
}: {
  label: string
  value: string
  icon: LucideIcon
  testid: string
}) {
  return (
    <div
      data-testid={testid}
      className="flex min-w-0 flex-col gap-1 rounded-xl border border-border/60 bg-muted/25 px-3 py-2.5 transition-colors hover:border-border hover:bg-muted/40"
    >
      <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <Icon className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </span>
      <span className="truncate text-lg font-semibold tabular-nums" title={value}>
        {value}
      </span>
    </div>
  )
}

/** Per-model breakdown: share-of-tokens bar + turns / tokens / cost. */
function ModelBreakdown({
  models,
  emptyLabel,
  turnsLabel,
}: {
  models: readonly {
    model: string
    turns: number
    costUsd: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
  }[]
  emptyLabel: string
  turnsLabel: (turns: number) => string
}) {
  const withTokens = models.map((m) => ({
    ...m,
    tokens: m.inputTokens + m.outputTokens + m.cacheReadTokens,
  }))
  const max = withTokens.reduce((acc, m) => Math.max(acc, m.tokens), 0)

  if (withTokens.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="welcome-stats-models-empty">
        {emptyLabel}
      </p>
    )
  }

  return (
    <ul className="flex flex-col gap-2" data-testid="welcome-stats-models">
      {withTokens.map((m) => (
        <li
          key={m.model}
          className="flex flex-col gap-1"
          data-testid={`welcome-stats-model-${m.model}`}
        >
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="truncate font-medium" title={m.model}>
              {m.model}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {turnsLabel(m.turns)} · {formatTokens(m.tokens)} ·{" "}
              {formatCostInCurrency(m.costUsd, "USD")}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary/70"
              style={{ width: `${max > 0 ? Math.max(2, (m.tokens / max) * 100) : 0}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Tile / heatmap picker behind the ⚙ in the section header. */
function CustomizePopover({
  prefs,
  onChange,
  labels,
}: {
  prefs: WelcomeStatsPrefs
  onChange: (patch: Partial<WelcomeStatsPrefs>) => void
  labels: { trigger: string; title: string; heatmap: string; tile: (id: WelcomeStatId) => string }
}) {
  function toggleTile(id: WelcomeStatId, checked: boolean) {
    const next = checked
      ? WELCOME_STAT_IDS.filter((t) => t === id || prefs.tiles.includes(t))
      : prefs.tiles.filter((t) => t !== id)
    onChange({ tiles: [...next] })
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground"
          aria-label={labels.trigger}
          data-testid="welcome-stats-customize"
        >
          <Settings2Icon className="size-3.5" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 p-3">
        <p className="mb-2 text-xs font-medium">{labels.title}</p>
        <div className="flex flex-col gap-2">
          {WELCOME_STAT_IDS.map((id) => (
            <div key={id} className="flex items-center gap-2">
              <Checkbox
                id={`welcome-stat-opt-${id}`}
                checked={prefs.tiles.includes(id)}
                onCheckedChange={(checked) => toggleTile(id, checked === true)}
                data-testid={`welcome-stats-opt-${id}`}
              />
              <Label htmlFor={`welcome-stat-opt-${id}`} className="text-xs font-normal">
                {labels.tile(id)}
              </Label>
            </div>
          ))}
          <div className="mt-1 flex items-center gap-2 border-t border-border/60 pt-2">
            <Checkbox
              id="welcome-stat-opt-heatmap"
              checked={prefs.heatmap}
              onCheckedChange={(checked) => onChange({ heatmap: checked === true })}
              data-testid="welcome-stats-opt-heatmap"
            />
            <Label htmlFor="welcome-stat-opt-heatmap" className="text-xs font-normal">
              {labels.heatmap}
            </Label>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function WelcomeStats({ className }: { className?: string }) {
  const t = useTranslations("chat.empty")
  const locale = useLocale()
  const stored = useSettingsStore((s) => s.settings?.welcomeStats)
  const save = useSettingsStore((s) => s.save)

  const prefs = useMemo(() => resolveWelcomeStatsPrefs(stored), [stored])
  const { loading, stats, daily, models, now } = useActivityStats(prefs.rangeDays)

  const numberFormat = useMemo(() => new Intl.NumberFormat(locale), [locale])
  // Locale-aware hour-of-day ("7 PM" / "19时") — no hard-coded clock format.
  const hourFormat = useMemo(() => new Intl.DateTimeFormat(locale, { hour: "numeric" }), [locale])

  function patch(next: Partial<WelcomeStatsPrefs>) {
    void save({ welcomeStats: { ...prefs, ...next } })
  }

  // The ✕ hides the panel outright; Settings → Appearance restores it.
  if (!prefs.enabled) return null

  const fmt = {
    number: (n: number) => numberFormat.format(n),
    hour: (h: number) => hourFormat.format(new Date(2024, 0, 1, h)),
    streak: (days: number) => t("stats.dayCount", { count: days }),
    none: t("stats.none"),
  }

  const controls = (
    <>
      <ToggleGroup
        type="single"
        size="sm"
        value={prefs.view}
        onValueChange={(value) => {
          if ((WELCOME_STATS_VIEWS as readonly string[]).includes(value)) {
            patch({ view: value as WelcomeStatsView })
          }
        }}
        aria-label={t("stats.view.label")}
        data-testid="welcome-stats-view"
      >
        {WELCOME_STATS_VIEWS.map((view) => (
          <ToggleGroupItem
            key={view}
            value={view}
            className="h-6 px-2 text-[11px]"
            data-testid={`welcome-stats-view-${view}`}
          >
            {t(`stats.view.${view}`)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <ToggleGroup
        type="single"
        size="sm"
        value={String(prefs.rangeDays)}
        onValueChange={(value) => {
          const days = Number(value)
          if (WELCOME_STATS_RANGE_DAYS.includes(days)) patch({ rangeDays: days })
        }}
        aria-label={t("stats.range.label")}
        data-testid="welcome-stats-range"
      >
        {WELCOME_STATS_RANGE_DAYS.map((days) => (
          <ToggleGroupItem
            key={days}
            value={String(days)}
            className="h-6 px-2 text-[11px] tabular-nums"
            data-testid={`welcome-stats-range-${days}`}
          >
            {t("stats.range.days", { days })}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <CustomizePopover
        prefs={prefs}
        onChange={patch}
        labels={{
          trigger: t("stats.customize"),
          title: t("stats.customizeTitle"),
          heatmap: t("stats.heatmap"),
          tile: (id) => t(`stats.tiles.${id}`),
        }}
      />
    </>
  )

  return (
    <section className={cn("w-full", className)} data-testid="welcome-stats">
      <SectionHeading
        label={t("stats.title")}
        actions={controls}
        dismissLabel={t("dismiss")}
        onDismiss={() => patch({ enabled: false })}
      />

      {loading ? (
        <div
          className="grid grid-cols-2 gap-2 @2xl:grid-cols-4"
          data-testid="welcome-stats-loading"
          aria-busy="true"
        >
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-[62px] rounded-xl" />
          ))}
        </div>
      ) : stats.turns === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="welcome-stats-empty">
          {t("stats.empty")}
        </p>
      ) : prefs.view === "models" ? (
        <ModelBreakdown
          models={models}
          emptyLabel={t("stats.models.empty")}
          turnsLabel={(turns) => t("stats.models.turns", { count: turns })}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {prefs.tiles.length > 0 ? (
            <div
              className="grid grid-cols-2 gap-2 @2xl:grid-cols-4"
              data-testid="welcome-stats-grid"
            >
              {prefs.tiles.map((id) => (
                <StatTile
                  key={id}
                  testid={`welcome-stat-${id}`}
                  label={t(`stats.tiles.${id}`)}
                  value={tileValue(id, stats, fmt)}
                  icon={TILE_ICONS[id]}
                />
              ))}
            </div>
          ) : null}
          {prefs.heatmap ? (
            <div className="overflow-x-auto pb-1">
              <UsageHeatmap
                daily={daily}
                rangeDays={prefs.rangeDays}
                now={now}
                testIdPrefix="welcome-stats-heatmap"
              />
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}
