"use client"

/**
 * Everything about one goal, and everything that can be done to it
 * (ADR-0019). Rendered as the Goals console's inspector pane beside the list,
 * inside the composer pill's sheet, and in the phone drawer — one component,
 * so the three never drift.
 *
 *   header   status · ⋯ menu (open conversation, run again, copy, delete)
 *            objective (editable while the goal can move)
 *            conversation · agent · started · running for / ended
 *            controls (continue, pause / resume, stop) · open conversation
 *            acceptance verdict, when the gate is holding the goal
 *   tabs     Overview · Subgoals n/m · Activity n · Settings
 *
 * It reads the goal row live by id. The sheet used to render whatever snapshot
 * its opener held — History and the phone list passed the row they had when
 * tapped — so a goal paused, edited or saved while open kept showing the old
 * state, and the Settings tab's "unsaved" check compared against that stale
 * config. `initialGoal` only covers the first paint.
 */

import Link from "next/link"
import { useLiveQuery } from "dexie-react-hooks"
import { useFormatter, useLocale, useNow, useTranslations } from "next-intl"
import { MessageSquareIcon, TargetIcon, XIcon } from "lucide-react"

import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useCharacter } from "@/lib/data-hooks/context"
import { countGoalEvents, getGoal } from "@/lib/db/goals"
import { getSession } from "@/lib/db/sessions"
import { formatGoalDuration, goalRunDurationMs } from "@/lib/goal/format"
import { isAwaitingAcceptance } from "@/lib/goal/overview-filter"
import { cn } from "@/lib/utils"
import type { Goal } from "@/types/goal"

import { GoalAcceptanceActions } from "./goal-acceptance-actions"
import { GoalActionsMenu } from "./goal-actions-menu"
import { GoalControlBar } from "./goal-control-bar"
import { GoalConversationLink, goalConversationHref } from "./goal-conversation-link"
import { GoalObjectiveEditor } from "./goal-objective-editor"
import { GoalStatusChip } from "./goal-status-chip"
import { GoalActivityTab } from "./tabs/activity-tab"
import { GoalOverviewTab } from "./tabs/overview-tab"
import { GoalSettingsTab } from "./tabs/settings-tab"
import { GoalSubgoalsTab } from "./tabs/subgoals-tab"

export interface GoalDetailPanelProps {
  goalId: string
  /** The row the opener already holds — painted until the live read lands. */
  initialGoal?: Goal
  /** Renders a close button (the inspector pane; a sheet has its own). */
  onClose?: () => void
  /** The goal was deleted from here; the opener drops its selection. */
  onDeleted?: () => void
  className?: string
}

const TAB_TRIGGER_CLASS = "min-h-11 shrink-0 gap-1.5 md:min-h-0"

export function GoalDetailPanel({
  goalId,
  initialGoal,
  onClose,
  onDeleted,
  className,
}: GoalDetailPanelProps) {
  const t = useTranslations("goal")
  const live = useLiveQuery(async () => (await getGoal(goalId)) ?? null, [goalId])
  const goal = live === undefined ? initialGoal : live

  if (goal === null) {
    return (
      <PanelFrame className={className} onClose={onClose} closeLabel={t("inspector.close")}>
        <Empty className="flex-1" data-testid="goal-detail-missing">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TargetIcon className="size-5" aria-hidden />
            </EmptyMedia>
            <EmptyTitle>{t("inspector.missingTitle")}</EmptyTitle>
            <EmptyDescription>{t("inspector.missing")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </PanelFrame>
    )
  }

  if (goal === undefined) {
    return (
      <PanelFrame className={className} onClose={onClose} closeLabel={t("inspector.close")}>
        <div className="space-y-3 p-4" aria-busy data-testid="goal-detail-loading">
          <Skeleton className="h-5 w-24 rounded-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-20 w-full" />
        </div>
      </PanelFrame>
    )
  }

  return <LoadedPanel goal={goal} onClose={onClose} onDeleted={onDeleted} className={className} />
}

function LoadedPanel({
  goal,
  onClose,
  onDeleted,
  className,
}: {
  goal: Goal
  onClose?: () => void
  onDeleted?: () => void
  className?: string
}) {
  const t = useTranslations("goal")
  const format = useFormatter()
  const locale = useLocale()
  const now = useNow({ updateInterval: 60_000 })
  const session = useLiveQuery(
    async () => (await getSession(goal.sessionId)) ?? null,
    [goal.sessionId]
  )
  const character = useCharacter(goal.characterId)
  const eventCount = useLiveQuery(() => countGoalEvents(goal.id), [goal.id])
  const awaiting = isAwaitingAcceptance(goal)
  const subgoals = goal.subgoals ?? []
  const subgoalsDone = subgoals.filter((step) => step.done).length
  const duration = formatGoalDuration(goalRunDurationMs(goal, now.getTime()), locale)

  const absolute = (ms: number) =>
    format.dateTime(new Date(ms), { dateStyle: "medium", timeStyle: "short" })

  return (
    <PanelFrame
      className={className}
      onClose={onClose}
      closeLabel={t("inspector.close")}
      testId="goal-detail-panel"
    >
      <div className="shrink-0 space-y-3 border-b px-4 pt-3 pb-4">
        <div className="flex min-w-0 items-center gap-2">
          <GoalStatusChip goal={goal} />
          {goal.awaitingPromise && goal.status === "active" ? (
            <span className="truncate text-[11px] text-warning" data-testid="goal-awaiting-promise">
              {t("overview.awaitingPromise")}
            </span>
          ) : null}
          <div className="ml-auto flex shrink-0 items-center">
            <GoalActionsMenu
              goal={goal}
              conversationMissing={session === null}
              onDeleted={onDeleted}
            />
            {onClose ? (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-8 text-muted-foreground"
                onClick={onClose}
                aria-label={t("inspector.close")}
                data-testid="goal-detail-close"
              >
                <XIcon className="size-4" aria-hidden />
              </Button>
            ) : null}
          </div>
        </div>

        <GoalObjectiveEditor goal={goal} />

        <dl
          className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs"
          data-testid="goal-detail-facts"
        >
          <dt className="text-muted-foreground">{t("inspector.conversation")}</dt>
          <dd className="min-w-0">
            <GoalConversationLink sessionId={goal.sessionId} session={session} />
          </dd>
          <dt className="text-muted-foreground">{t("inspector.agent")}</dt>
          <dd className="truncate">{character?.name ?? t("inspector.defaultAgent")}</dd>
          <dt className="text-muted-foreground">{t("inspector.started")}</dt>
          <dd>
            <time
              dateTime={new Date(goal.createdAt).toISOString()}
              title={absolute(goal.createdAt)}
            >
              {format.relativeTime(new Date(goal.createdAt), now)}
            </time>
          </dd>
          {goal.endedAt ? (
            <>
              <dt className="text-muted-foreground">{t("inspector.ended")}</dt>
              <dd>
                <time
                  dateTime={new Date(goal.endedAt).toISOString()}
                  title={absolute(goal.endedAt)}
                >
                  {format.relativeTime(new Date(goal.endedAt), now)}
                </time>
                <span className="text-muted-foreground">
                  {" · "}
                  {t("inspector.ranFor", { duration })}
                </span>
              </dd>
            </>
          ) : (
            <>
              <dt className="text-muted-foreground">{t("inspector.running")}</dt>
              <dd className="tabular-nums">{duration}</dd>
            </>
          )}
        </dl>

        <div className="flex flex-wrap items-center gap-2">
          <GoalControlBar goal={goal} variant="labelled" />
          {session ? (
            <Button
              asChild
              size="sm"
              variant="ghost"
              className="min-h-11 md:min-h-8"
              data-testid="goal-detail-open-conversation"
            >
              <Link href={goalConversationHref(goal.sessionId)}>
                <MessageSquareIcon className="size-3.5" aria-hidden />
                {t("actions.openConversation")}
              </Link>
            </Button>
          ) : null}
        </div>

        <PluginExtensionSlot
          point="goal.detail.actions"
          context={{ goalId: goal.id, status: goal.status }}
          className="flex flex-wrap items-center gap-2 empty:hidden"
        />

        {awaiting ? (
          // The judge declared the objective met and `requireAcceptance` parked
          // the goal for a human verdict.
          <div
            className="space-y-2 border-l-2 border-warning bg-warning/5 py-2 pr-2 pl-3"
            data-testid="goal-acceptance-banner"
          >
            <p className="text-sm font-medium">{t("acceptance.title")}</p>
            <p className="text-xs text-muted-foreground">{t("acceptance.description")}</p>
            <GoalAcceptanceActions goal={goal} />
          </div>
        ) : null}
      </div>

      {/* Keyed by goal so a new selection starts on Overview, not on whatever
          tab the previous goal was left on. */}
      <Tabs key={goal.id} defaultValue="overview" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mx-4 mt-3 flex w-auto shrink-0 justify-start overflow-x-auto md:grid md:grid-cols-4">
          <TabsTrigger
            value="overview"
            className={TAB_TRIGGER_CLASS}
            data-testid="goal-tab-overview"
          >
            {t("detailSheet.tabs.overview")}
          </TabsTrigger>
          <TabsTrigger
            value="subgoals"
            className={TAB_TRIGGER_CLASS}
            data-testid="goal-tab-subgoals"
          >
            {t("detailSheet.tabs.subgoals")}
            {subgoals.length > 0 ? (
              <TabCount>
                {t("subgoals.count", { done: subgoalsDone, total: subgoals.length })}
              </TabCount>
            ) : null}
          </TabsTrigger>
          <TabsTrigger
            value="activity"
            className={TAB_TRIGGER_CLASS}
            data-testid="goal-tab-activity"
          >
            {t("detailSheet.tabs.activity")}
            {eventCount ? <TabCount>{format.number(eventCount)}</TabCount> : null}
          </TabsTrigger>
          <TabsTrigger
            value="settings"
            className={TAB_TRIGGER_CLASS}
            data-testid="goal-tab-settings"
          >
            {t("detailSheet.tabs.settings")}
          </TabsTrigger>
        </TabsList>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-6">
          <TabsContent value="overview" className="mt-0">
            <GoalOverviewTab goal={goal} />
          </TabsContent>
          <TabsContent value="subgoals" className="mt-0">
            <GoalSubgoalsTab goal={goal} />
          </TabsContent>
          <TabsContent value="activity" className="mt-0">
            <GoalActivityTab goal={goal} />
          </TabsContent>
          <TabsContent value="settings" className="mt-0">
            <GoalSettingsTab goal={goal} />
          </TabsContent>
        </div>
      </Tabs>
    </PanelFrame>
  )
}

function TabCount({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-pill bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
      {children}
    </span>
  )
}

function PanelFrame({
  children,
  className,
  onClose,
  closeLabel,
  testId,
}: {
  children: React.ReactNode
  className?: string
  onClose?: () => void
  closeLabel: string
  testId?: string
}) {
  const t = useTranslations("goal")
  // The loaded panel draws its own close button in its header row; the
  // loading and missing states have no header, so they get one here.
  const ownsClose = onClose && testId !== "goal-detail-panel"
  return (
    <section
      className={cn("flex h-full min-h-0 w-full min-w-0 flex-col", className)}
      aria-label={t("inspector.title")}
      data-testid={testId}
    >
      {ownsClose ? (
        <div className="flex shrink-0 justify-end px-2 pt-2">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8 text-muted-foreground"
            onClick={onClose}
            aria-label={closeLabel}
            data-testid="goal-detail-close"
          >
            <XIcon className="size-4" aria-hidden />
          </Button>
        </div>
      ) : null}
      {children}
    </section>
  )
}

GoalDetailPanel.displayName = "GoalDetailPanel"
