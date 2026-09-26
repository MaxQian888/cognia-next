"use client"

/**
 * Samples the live sources behind the navigation's badges and reports them to
 * `lib/shell/nav-badges.ts`. Renders nothing.
 *
 * Mounted once per main window (`WindowTitleInitializer`), never by the rail
 * itself: the rail, the sidebar's hosted nav rows, the More menu and the app
 * badge all read one snapshot, and a source subscribed once cannot disagree
 * with itself across four surfaces.
 *
 * Each source is its own probe component, mounted only while the destination
 * it badges is on the navigation (pinned or in More). A hidden destination
 * shows no badge, so there is no reason to keep its Dexie query or its host
 * poll running — the Bots console reads a paired host every few seconds, which
 * is worth paying only while someone could see the answer. Unmounting a probe
 * reports zero, so a count never outlives the item that showed it.
 */

import { useEffect, useMemo, useSyncExternalStore } from "react"

import { useAttentionCount } from "@/hooks/attention/use-attention"
import { useBotInstallations } from "@/hooks/bots/use-bot-installations"
import { usePendingDrafts } from "@/hooks/connectors/use-pending-drafts"
import {
  pendingApprovalCount,
  subscribePendingApprovals,
} from "@/lib/connectors/hitl/approval-registry"
import {
  pendingAskUserCount,
  subscribePendingAskUsers,
} from "@/lib/connectors/hitl/ask-user-registry"
import { deriveAttention } from "@/lib/scheduler/attention"
import {
  getEffectiveSchedulerHostTarget,
  subscribeSchedulerHostTarget,
} from "@/lib/scheduler/scheduler-host-target"
import { toUnified } from "@/lib/scheduler/sources/app-source"
import { workspaceScopeForSchedulerHost } from "@/lib/scheduler/task-workspace-binding"
import { filterUnifiedItems } from "@/lib/scheduler/unified-filter"
import { setNavBadgeSourceCount, type NavBadgeSource } from "@/lib/shell/nav-badges"
import { useProjectStore } from "@/stores/project/project-store"
import { useSchedulerStore } from "@/stores/scheduler/scheduler-store"
import { useSidebarLayout } from "./use-sidebar-layout"

/** Report `count` for `source` while mounted; zero once unmounted. */
function useReportNavBadge(source: NavBadgeSource, count: number): void {
  useEffect(() => {
    setNavBadgeSourceCount(source, count)
  }, [source, count])
  useEffect(() => () => setNavBadgeSourceCount(source, 0), [source])
}

const zero = () => 0

function InboxBadgeProbe() {
  const drafts = usePendingDrafts().length
  // The registries live in the renderer that runs the connector runtime; a
  // shell without one (web, mobile) simply reports zero from both.
  const approvals = useSyncExternalStore(subscribePendingApprovals, pendingApprovalCount, zero)
  const questions = useSyncExternalStore(subscribePendingAskUsers, pendingAskUserCount, zero)
  useReportNavBadge("inbox.drafts", drafts)
  useReportNavBadge("inbox.approvals", approvals)
  useReportNavBadge("inbox.questions", questions)
  return null
}

function AgentRunsBadgeProbe() {
  useReportNavBadge("agent-runs.attention", useAttentionCount())
  return null
}

function SchedulerBadgeProbe() {
  // The store the scheduler page reads, already hydrated at desktop boot by
  // `SchedulerInitializer`; switching the managed host re-points it, so the
  // count follows the same host the page shows. Before it loads it is empty
  // and the badge says nothing rather than guessing.
  const tasks = useSchedulerStore((s) => s.tasks)
  const maxTasksPerSource = useSchedulerStore((s) => s.permissionPolicy.maxTasksPerSource)
  const hostTarget = useSyncExternalStore(
    subscribeSchedulerHostTarget,
    getEffectiveSchedulerHostTarget,
    () => "local" as const
  )
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const count = useMemo(() => {
    if (tasks.length === 0) return 0
    // Scoped the way the page scopes its list, so the badge never counts a
    // task the page would not show for this workspace.
    const items = filterUnifiedItems(tasks.map(toUnified), {
      projectId: workspaceScopeForSchedulerHost(hostTarget, activeProjectId),
    })
    const signals = deriveAttention({
      items,
      tasksById: new Map(tasks.map((task) => [task.id, task])),
      runs: [],
      pendingConfirmations: 0,
      hostSuspended: false,
      sourceErrors: {},
      maxTasksPerSource,
    })
    return signals.filter((signal) => signal.itemUnifiedId && signal.severity !== "info").length
  }, [tasks, hostTarget, activeProjectId, maxTasksPerSource])
  useReportNavBadge("scheduler.attention", count)
  return null
}

function BotsBadgeProbe() {
  useReportNavBadge("bots.attention", useBotInstallations().summary.needsAttention)
  return null
}

export function NavBadgeProbes() {
  const { resolved } = useSidebarLayout()
  const shown = useMemo(
    () => new Set([...resolved.pinned, ...resolved.overflow].map((item) => item.id)),
    [resolved.pinned, resolved.overflow]
  )
  return (
    <>
      {shown.has("inbox") ? <InboxBadgeProbe /> : null}
      {shown.has("agent-runs") ? <AgentRunsBadgeProbe /> : null}
      {shown.has("scheduler") ? <SchedulerBadgeProbe /> : null}
      {shown.has("bots") ? <BotsBadgeProbe /> : null}
    </>
  )
}
