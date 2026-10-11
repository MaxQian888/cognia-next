"use client"

/**
 * Everything a `GlanceSnapshotV1` is built from, in the main window
 * (ADR-0225 §7).
 *
 * `active` is "some consumer is visible right now". Each slice runs only when
 * the consumer is visible AND its module is visible in the layout, so a closed
 * panel computes nothing and a panel without the activity module never reads a
 * year of the usage ledger. The layout itself, the active workspace and the
 * `when` state are always read: they are cheap, and a consumer that becomes
 * visible needs them before anything else.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { useCostBudgetStatus } from "@/hooks/usage/use-cost-budget-status"
import { useUsageGlance } from "@/hooks/usage/use-usage-glance"
import { filterExposedSessions } from "@/lib/chat/session-exposure"
import { getDb } from "@/lib/db/schema"
import { listWorkspaceSessionIds, listWorkspaceSessions } from "@/lib/db/sessions"
import { buildFleetSlice } from "@/lib/glance/build-fleet"
import { buildPetSlice } from "@/lib/glance/build-pet"
import { buildRecentsSlice, type RecentSessionInput } from "@/lib/glance/build-recents"
import { buildUsageSlice } from "@/lib/glance/build-usage"
import { normalizeGlancePanelSettings, visibleModuleIds } from "@/lib/glance/presets"
import type { GlanceSnapshotV1 } from "@/lib/glance/snapshot"
import {
  getIslandProjection,
  getIslandProjectionServerSnapshot,
  subscribeIslandProjection,
} from "@/lib/island/projection-store"
import { useTrayStateSnapshot } from "@/lib/tray/state-snapshot"
import type { UsageGlanceBudget, UsageGlanceQuery } from "@/lib/usage/usage-glance"
import { useChatStore } from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import type { GlanceModuleId } from "@/types/glance/layout"

import { useGlanceActivity } from "./use-glance-activity"
import { useGlanceAgenda } from "./use-glance-agenda"
import { useGlanceQuota, type UseGlanceQuotaResult } from "./use-glance-quota"

/** How often relative states (stale, "in 14 h") are re-evaluated while visible. */
export const GLANCE_TICK_MS = 30_000

const RECENTS_SCAN = 40

/** A workspace with no sessions filters every row out; one stable empty set for it. */
const NO_SESSIONS: ReadonlySet<string> = new Set<string>()

export type GlanceSnapshotBody = Omit<GlanceSnapshotV1, "version" | "epoch" | "revision">

export interface UseGlanceSourcesResult {
  body: GlanceSnapshotBody
  quota: UseGlanceQuotaResult
  /** Re-read the external usage index (all-tools scope only). */
  refreshUsage: () => Promise<void>
}

/** A ticking clock while `active`, frozen otherwise. */
function useGlanceNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const tick = () => setNow(Date.now())
    // Re-read immediately on becoming visible, so a panel opened after an hour
    // closed does not judge freshness against the time it was last open.
    const first = setTimeout(tick, 0)
    const timer = setInterval(tick, GLANCE_TICK_MS)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [active])
  return now
}

export function useGlanceSources(active: boolean): UseGlanceSourcesResult {
  const storedLayout = useSettingsStore((s) => s.settings?.trayPanelLayout)
  const config = useMemo(() => normalizeGlancePanelSettings(storedLayout), [storedLayout])
  const visible = useMemo(() => new Set(visibleModuleIds(config.entries)), [config.entries])
  const on = (id: GlanceModuleId) => active && visible.has(id)
  const now = useGlanceNow(active)

  // Workspace.
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const projects = useProjectStore((s) => s.projects)
  const workspace = useMemo(() => {
    const project = projects.find((p) => p.id === activeProjectId)
    return project ? { id: project.id, name: project.name } : null
  }, [projects, activeProjectId])
  const scoped = config.scope === "workspace" && workspace !== null
  const sessionIds = useLiveQuery<string[] | null, null>(
    async () => (active && scoped && workspace ? listWorkspaceSessionIds(workspace.id) : null),
    [active, scoped, workspace?.id],
    null
  )
  // Scoped: the workspace's sessions (empty until the first read lands, so a
  // scoped panel never flashes global numbers). Unscoped: no filter at all.
  const sessionFilter = useMemo<ReadonlySet<string> | null>(
    () => (scoped ? (sessionIds ? new Set(sessionIds) : NO_SESSIONS) : null),
    [scoped, sessionIds]
  )

  // App state for the quick actions' `when`. Usage is a slice of its own.
  const tray = useTrayStateSnapshot()
  const when = useMemo(() => ({ ...tray, usage: null }), [tray])

  // Fleet: the island's own projection.
  const fleetOn = on("fleet")
  const island = useSyncExternalStore(
    subscribeIslandProjection,
    getIslandProjection,
    getIslandProjectionServerSnapshot
  )

  // Usage: one 30-day read; today and 7 days are sliced out of its buckets.
  const usageOn = on("usage")
  const usageScope = config.options.usage.scope
  const usageQuery = useMemo<UsageGlanceQuery>(
    () => ({ period: "30d", scope: usageScope, metric: "tokens" }),
    [usageScope]
  )
  const budgetStatus = useCostBudgetStatus()
  const budget = useMemo<UsageGlanceBudget | null>(() => {
    const worst = budgetStatus.worst
    if (!worst) return null
    return {
      ratio: worst.ratio,
      target: worst.target,
      period: worst.period,
      blocked: worst.level === "exceeded",
    }
  }, [budgetStatus.worst])
  const { snapshot: usageGlance, refresh: refreshUsage } = useUsageGlance({
    query: usageQuery,
    enabled: usageOn,
    budget,
    sessionFilter,
  })

  const quota = useGlanceQuota(on("quota"), now)
  const agenda = useGlanceAgenda(on("agenda"), now)
  const activity = useGlanceActivity(
    on("activity"),
    config.options.activity.range,
    usageScope,
    sessionFilter,
    now
  )

  // Recents: a bounded newest-first read, exposed conversations only.
  const recentsOn = on("recents")
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const recentRows = useLiveQuery<RecentSessionInput[], RecentSessionInput[]>(
    async () => {
      if (!recentsOn) return []
      const rows =
        scoped && workspace
          ? (await listWorkspaceSessions(workspace.id)).slice(0, RECENTS_SCAN)
          : await getDb().sessions.orderBy("updatedAt").reverse().limit(RECENTS_SCAN).toArray()
      return filterExposedSessions(rows, "main-list").map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        archivedAt: s.archivedAt ?? null,
      }))
    },
    [recentsOn, scoped, workspace?.id],
    []
  )

  // Pet.
  const petOn = on("pet")
  const petEnabled = useSettingsStore((s) => s.settings?.petSettings?.enabled ?? false)
  const petProfile = useLiveQuery(
    async () => (petOn && petEnabled ? ((await getDb().petProfile.get("global")) ?? null) : null),
    [petOn, petEnabled],
    null
  )

  const body = useMemo<GlanceSnapshotBody>(
    () => ({
      generatedAt: now,
      config,
      workspace,
      when,
      fleet: fleetOn ? buildFleetSlice(island, now) : null,
      usage: usageOn
        ? buildUsageSlice({
            glance: usageGlance,
            scope: usageScope,
            showSpend: config.options.usage.showSpend,
            workspaceFiltered: scoped,
            now,
          })
        : null,
      quota: quota.slice,
      agenda,
      activity,
      recents: recentsOn ? buildRecentsSlice(recentRows, activeSessionId, now) : null,
      pet: petOn ? buildPetSlice(petEnabled, petProfile, now) : null,
    }),
    [
      now,
      config,
      workspace,
      when,
      fleetOn,
      island,
      usageOn,
      usageGlance,
      usageScope,
      scoped,
      quota.slice,
      agenda,
      activity,
      recentsOn,
      recentRows,
      activeSessionId,
      petOn,
      petEnabled,
      petProfile,
    ]
  )

  return { body, quota, refreshUsage }
}
