"use client"

/**
 * One agent's profile (ADR-0220): everything about it on one page, laid out
 * to fill the width rather than split across tabs.
 *
 *  - The main column is what it does: one activity feed (what is live now,
 *    then the conversations, tasks and issues it finished, newest first), and
 *    its open work: unfinished durable tasks and assigned issues as one list
 *    drawn with the issue tracker's own status and priority glyphs. The
 *    kanban itself is the detail's `tasks` mode, at full width; the issues
 *    open in the tracker, filtered to this agent.
 *  - The side column is what it is: where it came from, where it runs and on
 *    which models, under which policy, what it did in the last 30 days, and
 *    what it can reach.
 *
 * Below the container's `4xl` the side column drops under the main one. An
 * empty section is one muted line, never a block of whitespace.
 */

import Link from "next/link"
import { useState } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import {
  ArchiveIcon,
  ArrowUpRightIcon,
  CircleCheckIcon,
  KanbanSquareIcon,
  ListTodoIcon,
  MessageSquareIcon,
  TicketIcon,
} from "lucide-react"
import type { Character } from "@cognia/agent-config-types"
import { IssuePriorityIcon, IssueStatusIcon } from "@/components/issues/issue-glyphs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { AgentCatalogs } from "@/hooks/agents/use-agent-catalogs"
import type { AgentActivity, AgentNowItem, AgentRecentItem } from "@/lib/agents/agent-activity"
import type { Issue } from "@/types/issues"
import type { AgentTask } from "@/types/agent/agent-task"
import { agentIssuesHref, issueHref } from "@/lib/issues/hrefs"
import { sessionHref } from "@/lib/issues/run/agent-task-adapter"
import {
  agentTaskPriorityToIssuePriority,
  agentTaskStatusToIssueStatus,
} from "@/lib/issues/sources/agent-status-map"
import { formatTokens, formatUsd } from "@/lib/observability/format-utils"
import { AgentRuntimeLabel, AgentStatusDot } from "../agent-visuals"
import { AgentCapabilitiesSection } from "./agent-capabilities-section"
import { AgentFactRow, AgentSection, AgentSectionEmpty } from "./agent-section"

/** Feed and work rows shown before "Show all". */
export const FEED_PREVIEW = 6

export interface AgentProfileProps {
  agent: Character
  activity: AgentActivity | undefined
  catalogs: AgentCatalogs
  /** "Source" row, already worded by the detail (built-in, cloned from …, yours). */
  sourceLabel: string
  /** Offer "Edit" on the capabilities; absent when the agent cannot be edited in place. */
  onEdit?: () => void
  /** Open the agent's task board (the detail's `tasks` mode). */
  onOpenTasks: () => void
  /**
   * Phone layout. The phone's issue list has no assignee filter, so "View in
   * Issues" would land on every issue; it is left out there.
   */
  compact?: boolean
}

type FeedItem = { live: true; item: AgentNowItem } | { live: false; item: AgentRecentItem }

type WorkItem = { kind: "task"; task: AgentTask } | { kind: "issue"; issue: Issue }

export function AgentProfile({
  agent,
  activity,
  catalogs,
  sourceLabel,
  onEdit,
  onOpenTasks,
  compact = false,
}: AgentProfileProps) {
  const t = useTranslations("agentsConsole.profile")
  const tGeneral = useTranslations("settings.general")
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const [showAll, setShowAll] = useState(false)
  const [showAllWork, setShowAllWork] = useState(false)

  const feed: FeedItem[] = [
    ...(activity?.now ?? []).map((item) => ({ live: true as const, item })),
    ...(activity?.recent ?? []).map((item) => ({ live: false as const, item })),
  ]
  const visible = showAll ? feed : feed.slice(0, FEED_PREVIEW)
  const work: WorkItem[] = [
    ...(activity?.openTasks ?? []).map((task) => ({ kind: "task" as const, task })),
    ...(activity?.openIssues ?? []).map((issue) => ({ kind: "issue" as const, issue })),
  ].sort((a, b) => workUpdatedAt(b) - workUpdatedAt(a))
  const visibleWork = showAllWork ? work : work.slice(0, FEED_PREVIEW)
  const stats = activity?.stats
  const routing = agent.modelRouting
  const executeModel = routing?.execute ?? agent.model

  return (
    <div className="@container/agent-profile" data-testid="agent-profile">
      <div className="grid grid-cols-1 gap-x-10 @4xl/agent-profile:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]">
        <div className="min-w-0 divide-y divide-border/60">
          <AgentSection
            id="activity"
            title={t("activity.title")}
            meta={
              activity && activity.now.length > 0
                ? t("activity.live", { count: activity.now.length })
                : undefined
            }
          >
            {feed.length === 0 ? (
              <AgentSectionEmpty>{t("activity.empty")}</AgentSectionEmpty>
            ) : (
              <>
                <ul className="-mx-2.5 space-y-0.5" data-testid="agent-activity-feed">
                  {visible.map((entry) => (
                    <FeedRow
                      key={feedKey(entry)}
                      entry={entry}
                      when={
                        entry.live ? undefined : format.relativeTime(new Date(entry.item.at), now)
                      }
                      onOpenTasks={onOpenTasks}
                    />
                  ))}
                </ul>
                {feed.length > FEED_PREVIEW ? (
                  <Button
                    variant="link"
                    size="sm"
                    className="mt-2 h-auto p-0 text-xs text-muted-foreground"
                    onClick={() => setShowAll((value) => !value)}
                    data-testid="agent-activity-toggle"
                  >
                    {showAll
                      ? t("activity.showLess")
                      : t("activity.showAll", { count: feed.length })}
                  </Button>
                ) : null}
              </>
            )}
          </AgentSection>

          <AgentSection
            id="work"
            title={t("work.title")}
            meta={work.length > 0 ? t("work.open", { count: work.length }) : undefined}
            action={
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
                  onClick={onOpenTasks}
                  data-testid="agent-work-board"
                >
                  <KanbanSquareIcon className="size-3.5" aria-hidden />
                  {t("work.board")}
                </Button>
                {compact ? null : (
                  <Button
                    asChild
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
                  >
                    <Link href={agentIssuesHref(agent.id)} data-testid="agent-work-issues">
                      {t("work.viewInIssues")}
                      <ArrowUpRightIcon className="size-3.5" aria-hidden />
                    </Link>
                  </Button>
                )}
              </div>
            }
          >
            {work.length === 0 ? (
              <AgentSectionEmpty>{t("work.empty")}</AgentSectionEmpty>
            ) : (
              <>
                <ul className="-mx-2.5 space-y-0.5" data-testid="agent-work-list">
                  {visibleWork.map((entry) => (
                    <WorkRow
                      key={entry.kind === "task" ? `t:${entry.task.id}` : `i:${entry.issue.id}`}
                      entry={entry}
                      when={format.relativeTime(new Date(workUpdatedAt(entry)), now)}
                      onOpenTasks={onOpenTasks}
                    />
                  ))}
                </ul>
                {work.length > FEED_PREVIEW ? (
                  <Button
                    variant="link"
                    size="sm"
                    className="mt-2 h-auto p-0 text-xs text-muted-foreground"
                    onClick={() => setShowAllWork((value) => !value)}
                    data-testid="agent-work-toggle"
                  >
                    {showAllWork
                      ? t("activity.showLess")
                      : t("activity.showAll", { count: work.length })}
                  </Button>
                ) : null}
              </>
            )}
          </AgentSection>
        </div>

        <div className="mt-6 min-w-0 divide-y divide-border/60 border-t border-border/60 pt-6 @4xl/agent-profile:mt-0 @4xl/agent-profile:border-l @4xl/agent-profile:border-t-0 @4xl/agent-profile:pl-8 @4xl/agent-profile:pt-0">
          <AgentSection id="about" title={t("about.title")}>
            <dl className="-my-1.5" data-testid="agent-facts">
              <AgentFactRow label={t("about.source")}>{sourceLabel}</AgentFactRow>
              <AgentFactRow label={t("about.runtime")}>
                <AgentRuntimeLabel runtime={agent.runtime} />
              </AgentFactRow>
              <AgentFactRow label={t("about.model")} mono={Boolean(executeModel)}>
                {executeModel || t("about.modelDefault")}
              </AgentFactRow>
              {routing?.plan ? (
                <AgentFactRow label={t("about.planModel")} mono>
                  {routing.plan}
                </AgentFactRow>
              ) : null}
              {routing?.utility ? (
                <AgentFactRow label={t("about.utilityModel")} mono>
                  {routing.utility}
                </AgentFactRow>
              ) : null}
              <AgentFactRow label={t("about.permission")}>
                {agent.permissionMode
                  ? tGeneral(
                      `permission.${agent.permissionMode}` as `permission.${NonNullable<Character["permissionMode"]>}`
                    )
                  : t("about.inherit")}
              </AgentFactRow>
              {agent.workingDir ? (
                <AgentFactRow label={t("about.workingDir")} mono>
                  <span title={agent.workingDir}>{agent.workingDir}</span>
                </AgentFactRow>
              ) : null}
              <AgentFactRow label={t("about.updated")}>
                {format.relativeTime(new Date(agent.updatedAt), now)}
              </AgentFactRow>
            </dl>
          </AgentSection>

          <AgentSection id="stats" title={t("stats.title")}>
            <dl className="grid grid-cols-3 gap-x-4 gap-y-4" data-testid="agent-stats">
              <Stat label={t("stats.conversations")} value={String(stats?.conversations ?? 0)} />
              <Stat label={t("stats.turns")} value={String(stats?.turns ?? 0)} />
              <Stat
                label={t("stats.completed")}
                value={String((stats?.completedTasks ?? 0) + (stats?.completedIssues ?? 0))}
              />
              <Stat
                label={t("stats.tokens")}
                value={formatTokens((stats?.inputTokens ?? 0) + (stats?.outputTokens ?? 0))}
              />
              <Stat label={t("stats.cost")} value={formatUsd(stats?.costUsd ?? 0)} />
            </dl>
          </AgentSection>

          <AgentCapabilitiesSection agent={agent} catalogs={catalogs} onEdit={onEdit} />
        </div>
      </div>
    </div>
  )
}

const ROW =
  "flex min-h-9 w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm hover:bg-accent/60"

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-xs leading-tight text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate text-lg font-semibold leading-tight tabular-nums">{value}</dd>
    </div>
  )
}

function workUpdatedAt(entry: WorkItem): number {
  return entry.kind === "task" ? entry.task.updatedAt : entry.issue.updatedAt
}

/**
 * One piece of open work, drawn the way the issue tracker draws a row: status
 * glyph, priority glyph, identifier, title, status word, last touched. A task
 * maps onto the tracker's statuses the same way the tracker's agent-task
 * source maps it, but keeps its own status word (paused, blocked) since that
 * is what the board will show.
 */
function WorkRow({
  entry,
  when,
  onOpenTasks,
}: {
  entry: WorkItem
  when: string
  onOpenTasks: () => void
}) {
  const t = useTranslations("agentsConsole.profile.work")
  const tTask = useTranslations("agentTaskBoard")
  const tIssues = useTranslations("issues")

  if (entry.kind === "task") {
    const { task } = entry
    return (
      <li>
        <button
          type="button"
          onClick={onOpenTasks}
          className={ROW}
          data-testid="agent-work-task"
          data-task-status={task.status}
        >
          <IssueStatusIcon status={agentTaskStatusToIssueStatus(task.status)} />
          <IssuePriorityIcon priority={agentTaskPriorityToIssuePriority(task.priority)} />
          <span className="hidden w-16 shrink-0 items-center gap-1 text-xs text-muted-foreground @lg/agent-profile:flex">
            <ListTodoIcon className="size-3.5" aria-hidden />
            {t("task")}
          </span>
          <span className="min-w-0 flex-1 truncate">{task.title}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {tTask(`status.${task.status}`)}
          </span>
          <span className="hidden w-20 shrink-0 text-right text-xs text-muted-foreground @lg/agent-profile:block">
            {when}
          </span>
        </button>
      </li>
    )
  }
  const { issue } = entry
  return (
    <li>
      <Link href={issueHref(issue.id)} className={ROW} data-testid="agent-work-issue">
        <IssueStatusIcon status={issue.status} />
        <IssuePriorityIcon priority={issue.priority} />
        <span className="hidden w-16 shrink-0 truncate font-mono text-xs text-muted-foreground @lg/agent-profile:block">
          {issue.identifier}
        </span>
        <span className="min-w-0 flex-1 truncate">{issue.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {tIssues(`status.${issue.status}`)}
        </span>
        <span className="hidden w-20 shrink-0 text-right text-xs text-muted-foreground @lg/agent-profile:block">
          {when}
        </span>
      </Link>
    </li>
  )
}

function feedKey(entry: FeedItem): string {
  const { item } = entry
  const prefix = entry.live ? "now" : "recent"
  switch (item.kind) {
    case "session":
      return `${prefix}:s:${item.session.id}`
    case "task":
      return `${prefix}:t:${item.task.id}`
    case "issue":
      return `${prefix}:i:${item.issue.id}`
  }
}

function FeedRow({
  entry,
  when,
  onOpenTasks,
}: {
  entry: FeedItem
  /** Relative time of a finished item; live rows say their state instead. */
  when?: string
  onOpenTasks: () => void
}) {
  const t = useTranslations("agentsConsole.profile.activity")
  const tTask = useTranslations("agentTaskBoard")

  if (entry.live) {
    const { item } = entry
    if (item.kind === "session") {
      const awaiting = item.status === "awaiting_approval"
      return (
        <li>
          <Link href={sessionHref(item.session.id)} className={ROW} data-testid="agent-feed-live">
            <AgentStatusDot status={awaiting ? "awaiting" : "running"} />
            <MessageSquareIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{item.session.title || t("untitled")}</span>
            <span
              className={
                awaiting
                  ? "shrink-0 text-xs text-amber-600 dark:text-amber-400"
                  : "shrink-0 text-xs text-emerald-600 dark:text-emerald-400"
              }
            >
              {awaiting ? t("awaiting") : t("running")}
            </span>
          </Link>
        </li>
      )
    }
    return (
      <li>
        <button type="button" onClick={onOpenTasks} className={ROW} data-testid="agent-feed-live">
          <AgentStatusDot status="running" />
          <ListTodoIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{item.task.title}</span>
          <span className="shrink-0 text-xs text-emerald-600 dark:text-emerald-400">
            {tTask(`status.${item.task.status}`)}
          </span>
        </button>
      </li>
    )
  }

  const { item } = entry
  if (item.kind === "session") {
    return (
      <li>
        <Link href={sessionHref(item.session.id)} className={ROW} data-testid="agent-feed-row">
          <span className="size-2 shrink-0" aria-hidden />
          <MessageSquareIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{item.session.title || t("untitled")}</span>
          {item.session.archivedAt ? (
            <Badge variant="outline" className="gap-1 px-1.5 text-[10px] font-normal">
              <ArchiveIcon className="size-3" aria-hidden />
              {t("archived")}
            </Badge>
          ) : null}
          <span className="shrink-0 text-xs text-muted-foreground">{when}</span>
        </Link>
      </li>
    )
  }
  if (item.kind === "issue") {
    return (
      <li>
        <Link href={issueHref(item.issue.id)} className={ROW} data-testid="agent-feed-row">
          <span className="size-2 shrink-0" aria-hidden />
          <TicketIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {item.issue.identifier}
          </span>
          <span className="min-w-0 flex-1 truncate">{item.issue.title}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{when}</span>
        </Link>
      </li>
    )
  }
  return (
    <li>
      <button type="button" onClick={onOpenTasks} className={ROW} data-testid="agent-feed-row">
        <span className="size-2 shrink-0" aria-hidden />
        <CircleCheckIcon className="size-3.5 shrink-0 text-emerald-600" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{item.task.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{when}</span>
      </button>
    </li>
  )
}
