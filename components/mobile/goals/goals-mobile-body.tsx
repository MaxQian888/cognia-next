"use client"

/**
 * Phone-shaped Goals view — the `/goals` route below `md` and on the mobile
 * companion (ADR-0019).
 *
 * Same model as the desktop console, laid out for a thumb: a hairline count
 * strip, Overview / History / Analytics, and one surface of two-line rows.
 * Tapping a row opens the shared goal detail (`GoalDetailSheet` → the bottom
 * drawer), which carries the controls, the conversation link and every action.
 *
 * What changed, and why:
 *  - Rows no longer carry two full-width buttons each. On a list of five goals
 *    that was ten buttons and most of the screen; the drawer has them, and its
 *    controls pick the transport (`useGoalControls`: local runtime here in a
 *    browser, the companion RPCs on a paired phone). The old row controls always
 *    used the RPCs, so in a narrowed desktop window every press failed.
 *  - Goals waiting on an acceptance verdict sit in their own "Needs you" list
 *    with Accept / Request changes inline.
 *  - "Completed" counts completed goals out of finished ones, as on desktop. It
 *    used to count every terminal status, so the two surfaces disagreed.
 *  - A skeleton covers the first read; the empty state no longer flashes.
 *  - History has a search field, and every row names its conversation.
 *
 * A new goal starts in chat (`/goal`), or from Run again in a goal's menu,
 * which on a paired phone creates it on the desktop where the loop runs
 * (`goal_create`). The drawer's controls, verdict, delete, continue and
 * verifier reach the desktop the same way, for a device holding the
 * remote-control grant.
 */

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useLiveQuery } from "dexie-react-hooks"
import { useLocale, useNow, useTranslations } from "next-intl"
import { ChevronRightIcon, SearchIcon } from "lucide-react"
import type { ChatSession } from "@cognia/agent-config-types"

import { GoalAnalyticsPanel } from "@/components/goal/analytics/goal-analytics-panel"
import { GoalAcceptanceActions } from "@/components/goal/goal-acceptance-actions"
import { GoalDetailSheet } from "@/components/goal/goal-detail-sheet"
import { GoalStatusChip } from "@/components/goal/goal-status-chip"
import { PullToRefresh } from "@/components/interactions/pull-to-refresh"
import { EmptyState } from "@/components/mobile/empty-state"
import { MobileBackButton } from "@/components/mobile/shell/mobile-back-button"
import { Surface } from "@/components/surface/surface"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Skeleton } from "@/components/ui/skeleton"
import { GoalsMobileSectionSwitcher, type GoalMobileSection } from "@/components/mobile/goals/goals-mobile-section-switcher"
import { GoalsMobileStatStrip } from "@/components/mobile/goals/goals-mobile-stat-strip"
import { useGoalRowContext } from "@/hooks/goal/use-goal-row-context"
import { getGoal, listAllGoals, listOpenGoals } from "@/lib/db/goals"
import { sessionDisplayTitle } from "@/lib/chat/placeholder-title"
import { computeGoalAnalytics } from "@/lib/goal/analytics"
import { formatGoalDuration, goalRunDurationMs } from "@/lib/goal/format"
import { filterAndSortGoals } from "@/lib/goal/history-filter"
import { splitOpenGoals } from "@/lib/goal/overview-filter"
import { COMPACT_PAGE_MIN_H } from "@/lib/shell/compact-shell"
import { runSyncDown } from "@/lib/sync/companion-sync"
import { cn } from "@/lib/utils"
import type { Goal } from "@/types/goal"

export function GoalsMobileBody() {
  const t = useTranslations("goal")
  const router = useRouter()
  const openGoals = useLiveQuery(() => listOpenGoals(), [])
  const allGoals = useLiveQuery(() => listAllGoals(), [])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = useLiveQuery(
    async () => (selectedId ? ((await getGoal(selectedId)) ?? null) : null),
    [selectedId]
  )
  const [section, setSection] = useState<GoalMobileSection>("overview")
  const [query, setQuery] = useState("")

  const analytics = useMemo(() => computeGoalAnalytics(allGoals ?? []), [allGoals])
  const { awaiting, running } = useMemo(() => splitOpenGoals(openGoals ?? []), [openGoals])
  const history = useMemo(
    () => filterAndSortGoals(allGoals ?? [], { query, sort: "created", dir: "desc" }),
    [allGoals, query]
  )
  const listed = section === "history" ? history : openGoals
  // Overview rows quote the latest judge verdict, as the desktop console does;
  // the verdicts come from the synced goal event log (`goalEvents`).
  const context = useGoalRowContext(listed, { judgeNotes: section === "overview" })

  const handleRefresh = async (): Promise<void> => {
    try {
      await runSyncDown({ only: ["goals", "goalEvents"] })
    } catch {
      // Orchestrator swallows handler-level failures.
    }
  }

  const loading = section === "history" ? allGoals === undefined : openGoals === undefined

  const renderRow = (goal: Goal, options: { acceptance?: boolean } = {}) => (
    <MobileGoalRow
      key={goal.id}
      goal={goal}
      session={context.sessionFor(goal)}
      judgeNote={section === "overview" ? context.judgeNoteFor(goal) : null}
      onOpen={() => setSelectedId(goal.id)}
      acceptance={options.acceptance}
    />
  )

  return (
    <main
      className={cn(
        COMPACT_PAGE_MIN_H,
        "flex w-full min-w-0 flex-col gap-3 bg-background pb-6 safe-area-pt"
      )}
      data-testid="mobile-goals-body"
    >
      <header className="flex items-center gap-1 px-4 pt-3">
        <MobileBackButton />
        <h1 className="text-2xl font-semibold tracking-tight">{t("console.title")}</h1>
      </header>

      <div className="px-4">
        {openGoals === undefined || allGoals === undefined ? (
          <Skeleton className="h-14 w-full rounded-panel" />
        ) : (
          <GoalsMobileStatStrip
            active={running.filter((goal) => goal.status === "active").length}
            paused={running.filter((goal) => goal.status === "paused").length + awaiting.length}
            completed={analytics.completed}
            finished={analytics.terminal}
          />
        )}
      </div>

      <GoalsMobileSectionSwitcher active={section} onSelect={setSection} />

      <PullToRefresh onRefresh={handleRefresh}>
        <section className="flex flex-col gap-4 px-4 pb-4" data-testid={`mobile-goals-${section}`}>
          {section === "analytics" ? (
            <div className="overflow-x-hidden">
              <GoalAnalyticsPanel goals={allGoals ?? []} loading={allGoals === undefined} />
            </div>
          ) : loading ? (
            <RowsSkeleton />
          ) : section === "overview" ? (
            awaiting.length === 0 && running.length === 0 ? (
              <EmptyState
                spotIcon="goals"
                title={t("console.activeEmpty")}
                // Goals start from /goal in a chat; the composer "+" menu
                // carries the Goal row that inserts the command.
                cta={{
                  label: t("console.openChat"),
                  onSelect: () => router.push("/"),
                  testId: "mobile-goals-open-chat",
                }}
              />
            ) : (
              <>
                {awaiting.length > 0 ? (
                  <div className="space-y-2" data-testid="mobile-goals-needs-you">
                    <h2 className="text-sm font-semibold">
                      {t("console.needsYou")}
                      <span className="ml-1.5 rounded-pill bg-warning/15 px-1.5 text-[11px] text-warning tabular-nums">
                        {awaiting.length}
                      </span>
                    </h2>
                    <RowSurface>{awaiting.map((goal) => renderRow(goal, { acceptance: true }))}</RowSurface>
                  </div>
                ) : null}
                {running.length > 0 ? (
                  <div className="space-y-2">
                    {awaiting.length > 0 ? (
                      <h2 className="text-sm font-semibold">{t("console.openGoalsHeading")}</h2>
                    ) : null}
                    <RowSurface>{running.map((goal) => renderRow(goal))}</RowSurface>
                  </div>
                ) : null}
              </>
            )
          ) : (allGoals ?? []).length === 0 ? (
            <EmptyState spotIcon="goals" title={t("history.empty")} />
          ) : (
            <>
              <InputGroup className="h-10">
                <InputGroupAddon>
                  <SearchIcon className="size-4" aria-hidden />
                </InputGroupAddon>
                <InputGroupInput
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("history.search")}
                  aria-label={t("history.search")}
                  data-testid="mobile-goals-search"
                />
              </InputGroup>
              {history.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {t("history.noResults")}
                </p>
              ) : (
                <RowSurface>{history.map((goal) => renderRow(goal))}</RowSurface>
              )}
            </>
          )}
        </section>
      </PullToRefresh>

      {selected ? (
        <GoalDetailSheet
          goal={selected}
          open
          onOpenChange={(open) => {
            if (!open) setSelectedId(null)
          }}
          onDeleted={() => setSelectedId(null)}
        />
      ) : null}
    </main>
  )
}

/**
 * One surface with hairline rows. A frame per goal turned a status list into
 * a stack of boxes.
 */
function RowSurface({ children }: { children: React.ReactNode }) {
  return (
    <Surface layer="raised" radius="panel" className="overflow-hidden border">
      <ul className="flex flex-col">{children}</ul>
    </Surface>
  )
}

function RowsSkeleton() {
  return (
    <div className="space-y-px overflow-hidden rounded-panel border" aria-busy data-testid="mobile-goals-loading">
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="space-y-2 bg-card p-3">
          <Skeleton className="h-4 w-16 rounded-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  )
}

/** Two lines: status and objective, then where it runs and how far along. */
function MobileGoalRow({
  goal,
  session,
  judgeNote = null,
  onOpen,
  acceptance = false,
}: {
  goal: Goal
  session: ChatSession | null | undefined
  /** The latest judge verdict's reason, quoted under the objective. */
  judgeNote?: string | null
  onOpen: () => void
  acceptance?: boolean
}) {
  const t = useTranslations("goal")
  const tRow = useTranslations("desktop.sessionRow")
  const locale = useLocale()
  const now = useNow({ updateInterval: 60_000 }).getTime()
  const conversation =
    session === null
      ? t("conversation.missing")
      : session
        ? sessionDisplayTitle(session.title, {
            untitled: tRow("untitled"),
            placeholder: tRow("placeholderTitle"),
          })
        : null

  return (
    <li className="not-last:border-b">
      <button
        type="button"
        onClick={onOpen}
        data-testid={`mobile-goal-${goal.id}`}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-3 text-left transition-colors active:bg-muted/50"
      >
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2">
            <GoalStatusChip goal={goal} size="sm" />
            <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {formatGoalDuration(goalRunDurationMs(goal, now), locale)}
            </span>
          </div>
          <p className="line-clamp-2 text-sm font-medium">{goal.safeObjective}</p>
          {judgeNote ? (
            <p
              className="line-clamp-1 text-xs italic text-muted-foreground"
              data-testid={`mobile-goal-judge-${goal.id}`}
            >
              {t("overview.reasonQuoted", { reason: judgeNote })}
            </p>
          ) : null}
          <p className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            {conversation ? <span className="truncate">{conversation}</span> : null}
            {conversation ? <span aria-hidden className="size-0.5 shrink-0 rounded-full bg-muted-foreground/60" /> : null}
            <span className="shrink-0 tabular-nums">
              {t("card.turnsInline", { used: goal.turnsUsed, max: goal.config.maxTurns })}
            </span>
          </p>
        </div>
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground/60" aria-hidden />
      </button>
      {acceptance ? (
        <div className="px-3 pb-3">
          <GoalAcceptanceActions goal={goal} />
        </div>
      ) : null}
    </li>
  )
}

GoalsMobileBody.displayName = "GoalsMobileBody"
