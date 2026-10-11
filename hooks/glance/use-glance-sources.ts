"use client"

/**
 * Everything a `GlanceSnapshotV1` is built from (ADR-0225 §7, §9).
 *
 * Three callers: the desktop main window's publisher (for the tray panel, from
 * the stored tray layout, and a second time for paired phones, from their
 * demand), the settings preview (passive), and a phone building its own
 * slices from what it holds locally.
 *
 * `active` is "some consumer is visible right now". Each slice runs only when
 * the consumer is visible AND its module is visible in the layout, so a closed
 * panel computes nothing and a panel without the activity module never reads a
 * year of the usage ledger. The layout itself, the action catalogue, the
 * active workspace and the `when` state are always read: they are cheap, and a
 * consumer that becomes visible needs them before anything else.
 */

import { useEffect, useId, useMemo, useSyncExternalStore } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useLocale, useTranslations } from "next-intl"

import { useCostBudgetStatus } from "@/hooks/usage/use-cost-budget-status"
import { useUsageGlance } from "@/hooks/usage/use-usage-glance"
import { filterExposedSessions } from "@/lib/chat/session-exposure"
import { getDb } from "@/lib/db/schema"
import { listWorkspaceSessionIds, listWorkspaceSessions } from "@/lib/db/sessions"
import {
  buildFleetSlice,
  NO_RUNNING_WORKFLOWS,
  summarizeRunningWorkflows,
} from "@/lib/glance/build-fleet"
import { buildPetSlice } from "@/lib/glance/build-pet"
import { buildPluginsSlice } from "@/lib/glance/build-plugins"
import { glancePluginModules } from "@/lib/glance/plugin-registry"
import { buildRecentsSlice, type RecentSessionInput } from "@/lib/glance/build-recents"
import { buildUsageSlice } from "@/lib/glance/build-usage"
import {
  normalizeGlancePanelSettings,
  visibleModuleIds,
  visiblePluginEntryIds,
} from "@/lib/glance/presets"
import type { GlancePlatform } from "@/lib/glance/registry"
import type { GlanceFleetWorkflows, GlanceSnapshotV1 } from "@/lib/glance/snapshot"
import { resolveTrayPanelActions } from "@/lib/tray-panel/catalogue"
import {
  getIslandProjection,
  getIslandProjectionServerSnapshot,
  subscribeIslandProjection,
} from "@/lib/island/projection-store"
import { useTrayStateSnapshot } from "@/lib/tray/state-snapshot"
import { resolvePluginLabel } from "@/lib/plugin/i18n/plugin-label"
import { usageGlanceBudget } from "@/lib/usage/cost-budget"
import type { UsageGlanceQuery } from "@/lib/usage/usage-glance"
import { useChatStore } from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import type { GlanceModuleId, GlancePanelSettings } from "@/types/glance/layout"

import { useGlanceActivity } from "./use-glance-activity"
import { useGlanceAgenda } from "./use-glance-agenda"
import { useGlanceNow } from "./use-glance-now"
import { useGlanceQuota, type UseGlanceQuotaResult } from "./use-glance-quota"

export { GLANCE_TICK_MS } from "./use-glance-now"

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

export interface UseGlanceSourcesOptions {
  /**
   * Read what is already known without triggering remote work: no quota
   * refreshes, no login discovery. For the settings editor's live preview,
   * which must not fire network requests just because Settings is open.
   */
  passive?: boolean
  /**
   * Build for this layout instead of the stored tray layout: which modules are
   * on, the scope and the module options. A phone's own layout, or a paired
   * phone's demand on the desktop. `null`/absent means the tray layout.
   */
  config?: GlancePanelSettings | null
  /**
   * The workspace a scoped build filters to, instead of this window's active
   * project. A paired phone names its own. Unknown here means unscoped, which
   * the usage slice reports (`workspaceFiltered: false`).
   */
  workspaceId?: string | null
  /**
   * The platform the build is for: which plugin modules are offered
   * (ADR-0225 §6). The desktop's build for paired phones and a phone's own
   * build say `mobile`.
   */
  platform?: GlancePlatform
}

export function useGlanceSources(
  active: boolean,
  {
    passive = false,
    config: configOverride = null,
    workspaceId,
    platform = "desktop",
  }: UseGlanceSourcesOptions = {}
): UseGlanceSourcesResult {
  const storedLayout = useSettingsStore((s) => s.settings?.trayPanelLayout)
  const config = useMemo(
    () => configOverride ?? normalizeGlancePanelSettings(storedLayout),
    [configOverride, storedLayout]
  )
  const storedActions = useSettingsStore((s) => s.settings?.trayPanelActions)
  const actions = useMemo(() => resolveTrayPanelActions(storedActions), [storedActions])
  const visible = useMemo(() => new Set(visibleModuleIds(config.entries)), [config.entries])
  const on = (id: GlanceModuleId) => active && visible.has(id)
  const now = useGlanceNow(active)

  // Workspace.
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const projects = useProjectStore((s) => s.projects)
  const workspaceTarget = workspaceId === undefined ? activeProjectId : workspaceId
  const workspace = useMemo(() => {
    const project = projects.find((p) => p.id === workspaceTarget)
    return project ? { id: project.id, name: project.name } : null
  }, [projects, workspaceTarget])
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

  // Fleet: the island's own projection (null where there is no island, as on
  // a phone), plus the visual workflows running now.
  const fleetOn = on("fleet")
  const island = useSyncExternalStore(
    subscribeIslandProjection,
    getIslandProjection,
    getIslandProjectionServerSnapshot
  )
  const workflows = useLiveQuery<GlanceFleetWorkflows, GlanceFleetWorkflows>(
    async () => {
      if (!fleetOn) return NO_RUNNING_WORKFLOWS
      const runs = await getDb().workflowRuns.where("status").equals("running").toArray()
      if (runs.length === 0) return NO_RUNNING_WORKFLOWS
      const ids = [...new Set(runs.map((run) => run.workflowId))]
      const rows = await getDb().workflows.bulkGet(ids)
      const names = new Map<string, string>()
      for (const row of rows) if (row) names.set(row.id, row.name)
      return summarizeRunningWorkflows(runs, names)
    },
    [fleetOn],
    NO_RUNNING_WORKFLOWS
  )

  // Usage: one 30-day read; today and 7 days are sliced out of its buckets.
  const usageOn = on("usage")
  const usageScope = config.options.usage.scope
  const usageQuery = useMemo<UsageGlanceQuery>(
    () => ({ period: "30d", scope: usageScope, metric: "tokens" }),
    [usageScope]
  )
  const budgetStatus = useCostBudgetStatus()
  const budget = useMemo(() => usageGlanceBudget(budgetStatus.worst), [budgetStatus.worst])
  const { snapshot: usageGlance, refresh: refreshUsage } = useUsageGlance({
    query: usageQuery,
    enabled: usageOn,
    budget,
    sessionFilter,
  })

  const quota = useGlanceQuota(on("quota"), now, { passive })
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

  // Plugin modules: the catalogue always (an editor needs it before anything
  // is shown), data for the visible ones while a consumer looks. This build
  // reports what it shows, so a plugin knows when it may stop computing.
  const tRoot = useTranslations()
  // Titles follow the language, not the translator's identity (which is not
  // guaranteed stable across renders).
  const locale = useLocale()
  const pluginVersion = useSyncExternalStore(
    glancePluginModules.subscribe,
    glancePluginModules.getVersion,
    glancePluginModules.getVersion
  )
  const visiblePluginKey = visiblePluginEntryIds(config.entries).join("\n")
  const visiblePlugins = useMemo(
    () =>
      (visiblePluginKey ? visiblePluginKey.split("\n") : []) as ReturnType<
        typeof visiblePluginEntryIds
      >,
    [visiblePluginKey]
  )
  const buildId = useId()
  useEffect(() => {
    glancePluginModules.setOnScreen(buildId, active ? visiblePlugins : null)
  }, [buildId, active, visiblePlugins])
  useEffect(() => () => glancePluginModules.setOnScreen(buildId, null), [buildId])
  const plugins = useMemo(
    () =>
      buildPluginsSlice({
        catalog: glancePluginModules.catalog(),
        dataOf: (id) => glancePluginModules.dataOf(id),
        visible: active ? visiblePlugins : [],
        platform,
        resolveTitle: (entry) =>
          resolvePluginLabel(tRoot, entry.pluginId, entry.def.titleKey, entry.def.title),
        now,
      }),
    // `pluginVersion` is the registry's change signal (catalogue or data moved)
    // and `locale` the translator's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pluginVersion, active, visiblePlugins, platform, locale, now]
  )

  const body = useMemo<GlanceSnapshotBody>(
    () => ({
      generatedAt: now,
      config,
      workspace,
      when,
      actions,
      fleet: fleetOn ? buildFleetSlice(island, now, workflows) : null,
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
      plugins,
    }),
    [
      now,
      config,
      workspace,
      when,
      actions,
      fleetOn,
      island,
      workflows,
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
      plugins,
    ]
  )

  return { body, quota, refreshUsage }
}
