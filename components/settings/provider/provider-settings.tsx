"use client"

import dynamic from "next/dynamic"
import { useEffect, useMemo, useState, useCallback, useRef } from "react"
import { createPortal } from "react-dom"
import { Plus, Settings, PlugZap, Route, RotateCcw } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { getSubscriptionProvider } from "@/lib/subscription/core/provider-registry"
import { discoverSubscriptionModels } from "@/lib/subscription/core/model-discovery"
import { useProviderSettings } from "@/hooks/settings/use-provider-settings"
import { useProviderManager } from "@/hooks/ai/use-provider-manager"
import { useModelsDevCatalog } from "@/hooks/settings/use-models-dev-catalog"
import { useOpenRouterCatalog } from "@/hooks/settings/use-openrouter-catalog"
import { buildBuiltInProviderModelDiscoverySnapshot } from "@cognia/provider-core/providers/model-discovery"
import type { ProviderUIPreferences } from "@cognia/provider-types/provider"
import type { LocalModelInfo } from "@cognia/provider-types/local-provider"
import { PanelTransition } from "@/components/settings/common/panel-transition"
import { SettingsListDetail } from "@/components/settings/common/settings-master-detail"
import {
  ProviderRailHost,
  RAIL_DEFAULT_WIDTH,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
  type ProviderStackedView,
} from "./provider-rail-host"
import { COMPARISON_MAX_MODELS } from "./model-format"
import { ProviderDetailHost } from "./provider-detail-host"
import type { TestResult } from "./connection-status-card"
import { RoutingTab } from "./routing-tab"
import { useEdgeResize } from "@/hooks/ui/use-edge-resize"
import { useDebouncedCallback } from "@/hooks/workflow/use-debounced-callback"
import { ProviderSidebar } from "./provider-sidebar"
import { ProviderHostNotice } from "./provider-host-notice"
import { ProviderEmptyState } from "./provider-empty-state"
import { ProviderSkeleton } from "./provider-skeleton"
import { ProviderOnboardingBanner } from "./provider-onboarding-banner"
import { ExternalRuntimeConnectionsCard } from "./external-runtime-connections-card"
import { useExternalRuntimeConnections } from "./use-external-runtime-connections"
import { BatchTestProgress, TestResultsSummary } from "./batch-test-progress"
import { useSettingsStore } from "@/stores/settings"
import {
  normalizeCategoryFilter,
  pickInitialProviderId,
  type ProviderSortBy,
} from "./provider-status-utils"
import { getBuiltInProviderReadiness, getCustomProviderReadiness } from "./provider-readiness"
import { nextActionKey } from "./provider-setup-checklist"
import { useProviderBatchVerify } from "./use-provider-batch-verify"
import { useProviderRows } from "./use-provider-rows"

type ProviderStatusFilter = NonNullable<ProviderUIPreferences["statusFilter"]>
type ProviderWorkspace = NonNullable<ProviderUIPreferences["workspace"]>

const CustomProviderDialog = dynamic(
  () => import("./custom-provider-dialog").then((m) => m.CustomProviderDialog),
  { ssr: false }
)
const QuickAddProviderDialog = dynamic(
  () => import("./quick-add-provider-dialog").then((m) => m.QuickAddProviderDialog),
  { ssr: false }
)
// Provider-specific config panels — lazy because each is 18-27 KB and only
// loads for the one provider that needs it.
// Model comparison pane (side-by-side capabilities + pricing, max 4 models).
// Swaps into the detail column instead of a dialog so the table gets the full
// pane width; lazy because it is 20+ KB and most sessions never open it.
const ProviderComparisonView = dynamic(
  () => import("./provider-comparison-view").then((m) => m.ProviderComparisonView),
  { ssr: false }
)
// Export/import of the whole provider configuration. Renders as a two-button
// toolbar that owns its own dialogs (conflict detection + skip/overwrite/merge
// resolution live inside it).
const ProviderImportExport = dynamic(
  () => import("./provider-import-export").then((m) => m.ProviderImportExport),
  { ssr: false }
)

/* ── Main ───────────────────────────────────────────────────────────────────── */

interface ProviderSettingsProps {
  headerActionsTarget?: HTMLElement | null
}

export function ProviderSettings({ headerActionsTarget }: ProviderSettingsProps = {}) {
  const t = useTranslations("providers")
  const tSubscription = useTranslations("subscription.managedKey")
  const s = useProviderSettings()
  const setProviderConfig = useSettingsStore((store) => store.setProviderConfig)
  const setProviderUIPreferences = useSettingsStore((store) => store.setProviderUIPreferences)
  const defaultProvider = useSettingsStore((store) => store.settings?.defaultProvider)
  // Before Dexie hydrates, `providerSettings` is {} — every row would derive
  // "not-configured", the auto-select effect would pick the alphabetically
  // first provider, and all the badges would flip once the real settings
  // landed. Show the skeleton until we actually know.
  const settingsLoaded = useSettingsStore((store) => store.loaded)
  const { providers: liveProviderHealth } = useProviderManager()
  // External agents bring their own model access. Without them on this page,
  // a Pi-only setup read as "every provider unconfigured, nothing works".
  const externalRuntimes = useExternalRuntimeConnections()

  const [search, setSearch] = useState("")
  const [categoryFilterOverride, setCategoryFilterOverride] = useState<string | null>(null)
  // `normalizeCategoryFilter` maps values persisted by the retired AI / Voice /
  // Vision strip back to "all" so an old preference can't hide every row.
  const categoryFilter = normalizeCategoryFilter(
    categoryFilterOverride ?? s.uiPreferences.categoryFilter
  )
  const setCategoryFilter = useCallback(
    (category: string) => {
      setCategoryFilterOverride(category)
      void setProviderUIPreferences({ categoryFilter: category === "all" ? undefined : category })
    },
    [setProviderUIPreferences]
  )
  const [sortByOverride, setSortByOverride] = useState<ProviderSortBy | null>(null)
  const sortBy: ProviderSortBy = sortByOverride ?? s.uiPreferences.sortBy ?? "name"
  const setSortBy = useCallback(
    (next: ProviderSortBy) => {
      setSortByOverride(next)
      void setProviderUIPreferences({ sortBy: next })
    },
    [setProviderUIPreferences]
  )
  // Rail width: persisted per user, dragged from the column's right edge.
  const [railWidthOverride, setRailWidthOverride] = useState<number | null>(null)
  const railWidth = Math.min(
    RAIL_MAX_WIDTH,
    Math.max(
      RAIL_MIN_WIDTH,
      railWidthOverride ?? s.uiPreferences.sidebarWidth ?? RAIL_DEFAULT_WIDTH
    )
  )
  // The drag emits per pointer move; persist on the trailing edge only.
  const persistRailWidth = useDebouncedCallback((width: number) => {
    void setProviderUIPreferences({ sidebarWidth: Math.round(width) })
  }, 250)
  const railResize = useEdgeResize({
    width: railWidth,
    min: RAIL_MIN_WIDTH,
    max: RAIL_MAX_WIDTH,
    onChange: (width) => {
      setRailWidthOverride(width)
      persistRailWidth.call(width)
    },
    onReset: () => {
      setRailWidthOverride(RAIL_DEFAULT_WIDTH)
      persistRailWidth.call(RAIL_DEFAULT_WIDTH)
    },
    edge: "right",
  })
  const [statusFilterOverride, setStatusFilterOverride] = useState<ProviderStatusFilter | null>(
    null
  )
  const statusFilter = statusFilterOverride ?? s.uiPreferences.statusFilter ?? "all"
  const setStatusFilter = useCallback(
    (status: ProviderStatusFilter) => {
      setStatusFilterOverride(status)
      void setProviderUIPreferences({ statusFilter: status })
    },
    [setProviderUIPreferences]
  )
  const [showQuickAdd, setShowQuickAdd] = useState(false)
  const [customDialogOpen, setCustomDialogOpen] = useState(false)
  const [editingCustomId, setEditingCustomId] = useState<string | null>(null)
  // Below the split threshold the pane is one page at a time: the list, or
  // the detail (provider / compare / routing) with a back button. Starts on
  // the list because that is what a phone shows first; a split pane never
  // reads it.
  const [stackedView, setStackedView] = useState<ProviderStackedView>("list")
  // Optimistic for the duration of the write, and not one render longer.
  // `setProviderUIPreferences` is queued behind every other provider mutation,
  // so reading the persisted value straight through would make the tab switch
  // visibly lag the click. Keeping the local copy indefinitely was the other
  // failure: it shadowed the preference permanently, so a workspace change
  // from anywhere else (settings sync, a restore, another surface) never
  // reached this component. Releasing it when the write settles gives instant
  // feedback and leaves the store as the single source of truth.
  const [workspaceOverride, setWorkspaceOverride] = useState<ProviderWorkspace | null>(null)
  const selectWorkspace = useCallback(
    (workspace: ProviderWorkspace) => {
      setWorkspaceOverride(workspace)
      // `Promise.resolve` because the release must happen even if the action
      // ever returns a non-promise. An override that is never released is the
      // permanent shadow this replaced.
      void Promise.resolve(setProviderUIPreferences({ workspace })).finally(() =>
        // Only if a later click has not already claimed the override.
        setWorkspaceOverride((current) => (current === workspace ? null : current))
      )
    },
    [setProviderUIPreferences]
  )
  const activeWorkspace: ProviderWorkspace =
    workspaceOverride ?? s.uiPreferences.workspace ?? "providers"
  // The comparison selection, `${providerId}:${modelId}` keys. Same optimistic
  // shape as the workspace: the compare column on the Models tab must tick on
  // the click, not when the preference write lands behind every other
  // provider mutation.
  const [comparisonOverride, setComparisonOverride] = useState<string[] | null>(null)
  const persistedComparisonKeys = s.uiPreferences.comparisonModelKeys
  const comparisonKeys = useMemo<readonly string[]>(
    () => comparisonOverride ?? persistedComparisonKeys ?? [],
    [comparisonOverride, persistedComparisonKeys]
  )
  const setComparisonKeys = useCallback(
    (next: string[]) => {
      const keys = next.slice(0, COMPARISON_MAX_MODELS)
      setComparisonOverride(keys)
      void Promise.resolve(setProviderUIPreferences({ comparisonModelKeys: keys })).finally(() =>
        setComparisonOverride((current) => (current === keys ? null : current))
      )
    },
    [setProviderUIPreferences]
  )
  const toggleComparisonKey = useCallback(
    (key: string) => {
      if (comparisonKeys.includes(key)) {
        setComparisonKeys(comparisonKeys.filter((k) => k !== key))
      } else if (comparisonKeys.length < COMPARISON_MAX_MODELS) {
        setComparisonKeys([...comparisonKeys, key])
      }
    },
    [comparisonKeys, setComparisonKeys]
  )
  const [testingConnection, setTestingConnection] = useState<Record<string, boolean>>({})
  // Deleting a custom provider drops its saved credentials and cannot be
  // undone, so it gets a confirmation step instead of firing on first click.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)

  const { rows: sidebarProviders, modelDiagnosticBadges } = useProviderRows({
    settings: s,
    liveProviderHealth,
    search,
    categoryFilter,
    sortBy,
  })

  // Auto-select: the app default provider (what chat actually uses), then the
  // first connected row, then the first row — never whatever sorts first
  // alphabetically. Runs once the list is non-empty and nothing is selected.
  const initialProviderId = pickInitialProviderId(sidebarProviders, defaultProvider)
  useEffect(() => {
    if (!s.selectedProviderId && initialProviderId) {
      void s.setSelectedProviderId(initialProviderId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialProviderId])

  const selectedId = s.selectedProviderId
  const selectedBuiltIn = selectedId
    ? s.filteredProviders.find(([id]) => id === selectedId)?.[1]
    : undefined
  const selectedCustom = selectedId ? s.customProviders[selectedId] : undefined
  const isCustom = !!selectedCustom
  // Local inference engines (Ollama, LM Studio, llama.cpp, …) are keyless and
  // get their own purpose-built dashboard (auto-detect + model manager +
  // setup wizard) instead of the generic cloud-provider Config/Models/Cost
  // tabs, which assume an API key and don't apply here.
  const isLocalProvider = selectedBuiltIn?.category === "local"

  const selectedSettings = selectedId ? s.providerSettings[selectedId] : undefined
  const modelRefresh = useRef<AbortController | null>(null)
  useEffect(
    () => () => {
      modelRefresh.current?.abort()
    },
    [selectedId, selectedSettings]
  )
  const isEnabled = isCustom
    ? (selectedCustom?.enabled ?? false)
    : (selectedSettings?.enabled ?? false)
  const selectedReadiness = useMemo(() => {
    if (!selectedId) return null
    if (selectedCustom) {
      const outcome = s.customTestResults[selectedId]
      return getCustomProviderReadiness(
        s.readinessCustomProviders?.[selectedId] ?? selectedCustom,
        outcome === undefined || outcome === null ? undefined : { success: outcome === "success" }
      )
    }
    return getBuiltInProviderReadiness(
      selectedId,
      (s.readinessProviderSettings ?? s.providerSettings)[selectedId],
      s.testResults[selectedId]
        ? {
            success: !!s.testResults[selectedId]?.success,
            outcome: s.testResults[selectedId]?.outcome,
          }
        : undefined
    )
  }, [
    selectedCustom,
    selectedId,
    s.providerSettings,
    s.readinessProviderSettings,
    s.readinessCustomProviders,
    s.customTestResults,
    s.testResults,
  ])
  // What the Config tab's status card shows: this session's test result when
  // there is one, otherwise the PERSISTED verification (status, timestamp,
  // message) — which readiness re-derives, so a key changed since the last
  // pass reads "stale". Before, a reload left the card empty even though the
  // row carried the last outcome.
  const configTestResult = useMemo<TestResult | null>(() => {
    if (!selectedId || isCustom) return null
    const live = s.testResults[selectedId]
    if (live) {
      return {
        success: !!live.success,
        latency: live.latency_ms,
        error: live.success ? undefined : live.message,
        outcome: live.outcome,
      }
    }
    if (!selectedSettings?.lastVerifiedAt) return null
    const status = selectedReadiness?.verificationStatus ?? selectedSettings.verificationStatus
    if (status === "verified") {
      return { success: true, testedAt: selectedSettings.lastVerifiedAt, persisted: true }
    }
    if (status === "stale") {
      return {
        success: false,
        outcome: "stale",
        testedAt: selectedSettings.lastVerifiedAt,
        persisted: true,
      }
    }
    if (selectedSettings.verificationMessage) {
      return {
        success: false,
        error: selectedSettings.verificationMessage,
        testedAt: selectedSettings.lastVerifiedAt,
        persisted: true,
      }
    }
    return null
  }, [isCustom, s.testResults, selectedId, selectedReadiness, selectedSettings])
  const canEnable = selectedReadiness?.eligibility.enable.allowed ?? false
  const canSetDefault = isEnabled && (isCustom ? Boolean(selectedCustom?.defaultModel) : true)
  // Human-readable "why not": the readiness core carries a `nextAction` per
  // blocked step; map it to an i18n string for the switch / button tooltips.
  const enableBlockedReason = useMemo(() => {
    if (canEnable || !selectedReadiness) return undefined
    const nextAction = selectedReadiness.setupChecklist.nextAction
    return nextAction
      ? `${t("readiness.enableBlocked")} ${t(nextActionKey(nextAction) as never)}`
      : t("readiness.enableBlocked")
  }, [canEnable, selectedReadiness, t])
  const setDefaultBlockedReason = canSetDefault ? undefined : t("readiness.setDefaultBlocked")

  const selectedName = isCustom ? selectedCustom?.customName : selectedBuiltIn?.name

  const {
    eligibleCount: batchEligibleCount,
    retryCount: batchRetryCount,
    verification: batchVerification,
    operationType: batchOperationType,
    runVerifyEnabled: runBatchVerification,
    runRetryFailed: runBatchRetryFailed,
    cancel: cancelBatch,
  } = useProviderBatchVerify(s)

  // models.dev catalog (reactive) → enrich the built-in provider's model list
  // with models.dev-authoritative metadata (pricing/context/capabilities) plus
  // the extra display fields (variants/family/release date/adapter).
  const {
    row: modelsDevRow,
    isLoading: modelsDevLoading,
    sync: syncModelsDevCatalog,
  } = useModelsDevCatalog()
  // OpenRouter's live `/models` catalog (what "Refresh models" syncs for it).
  // Only the OpenRouter row is subscribed, and only while OpenRouter is
  // selected — the hook is cheap but the row is large.
  const { row: openRouterCatalogRow, sync: syncOpenRouterCatalog } = useOpenRouterCatalog({
    enabled: selectedId === "openrouter",
  })
  const enrichedBuiltInModels = useMemo(() => {
    if (!selectedBuiltIn || !selectedId) return []
    const devModels = modelsDevRow?.providers[selectedId]?.models ?? []
    // For OpenRouter the synced live catalog is the authoritative list; the
    // static + models.dev entries only seed it. Before this the Models tab
    // ignored the row that "Refresh models" had just written.
    const liveCatalogModels =
      selectedId === "openrouter" ? (openRouterCatalogRow?.models ?? []) : []
    const settingsWithLiveCatalog =
      liveCatalogModels.length > 0
        ? {
            ...(selectedSettings ?? { providerId: selectedId, enabled: false, defaultModel: "" }),
            discoveredModels: [
              ...liveCatalogModels,
              ...(selectedSettings?.discoveredModels ?? []).filter(
                (m) => !liveCatalogModels.some((live) => live.id === m.id)
              ),
            ],
          }
        : selectedSettings
    const snapshot = buildBuiltInProviderModelDiscoverySnapshot({
      providerId: selectedId,
      catalogModels: selectedBuiltIn.models,
      modelsDevModels: devModels,
      settings: settingsWithLiveCatalog,
    })
    const devById = new Map(devModels.map((d) => [d.id, d]))
    return snapshot.models.map((m) => {
      const meta = devById.get(m.id)
      return {
        id: m.id,
        name: m.name,
        contextLength: m.contextLength,
        maxOutputTokens: m.maxOutputTokens ?? meta?.maxOutputTokens,
        supportsTools: m.supportsTools,
        supportsVision: m.supportsVision,
        pricing:
          m.pricing?.promptPer1M !== undefined && m.pricing?.completionPer1M !== undefined
            ? { promptPer1M: m.pricing.promptPer1M, completionPer1M: m.pricing.completionPer1M }
            : undefined,
        capabilities: [
          m.supportsTools ? "tools" : null,
          m.supportsVision ? "vision" : null,
          m.supportsStreaming ? "streaming" : null,
          m.supportsReasoning ? "reasoning" : null,
          m.supportsAudio || meta?.supportsAudio ? "audio" : null,
          m.supportsVideo || meta?.supportsVideo ? "video" : null,
          m.supportsImageGeneration || meta?.supportsImageGeneration ? "image-gen" : null,
          m.supportsEmbedding || meta?.supportsEmbedding ? "embedding" : null,
          meta?.supportsStructuredOutput ? "structured" : null,
          meta?.supportsAttachment ? "attachment" : null,
          meta?.supportsInterleaved ? "interleaved" : null,
        ].filter((c): c is string => c !== null),
        variants: meta?.variants,
        modeCount: meta?.modes?.length,
        openWeights: meta?.openWeights,
        family: meta?.family,
        releaseDate: meta?.releaseDate,
        adapter: meta?.adapter,
        status: meta?.status,
        knowledge: meta?.knowledge,
        lastUpdated: meta?.lastUpdated,
      }
    })
  }, [selectedBuiltIn, selectedId, selectedSettings, modelsDevRow, openRouterCatalogRow])

  // Default-model options for the Config tab. Static `PROVIDERS[id].models` is a
  // hand-curated subset; aggregators that refresh their list at runtime
  // (OpenRouter's synced live catalog, or any provider's per-account
  // `discoveredModels`) carry far more. Fold those dynamic sources in — deduped
  // by id, static first — so the Default Model dropdown actually lists the models
  // a dynamic provider can serve instead of an empty/stale set.
  const configModelOptions = useMemo<
    Array<{ id: string; name: string; source: "catalog" | "discovered" | "user" }>
  >(() => {
    if (!selectedBuiltIn || !selectedId) return []
    const byId = new Map<
      string,
      { id: string; name: string; source: "catalog" | "discovered" | "user" }
    >()
    for (const m of selectedBuiltIn.models) {
      byId.set(m.id, { id: m.id, name: m.name, source: "catalog" })
    }
    for (const m of selectedSettings?.discoveredModels ?? []) {
      byId.set(m.id, { id: m.id, name: m.name ?? m.id, source: "discovered" })
    }
    if (selectedId === "openrouter") {
      for (const m of openRouterCatalogRow?.models ?? []) {
        if (!byId.has(m.id)) {
          byId.set(m.id, { id: m.id, name: m.name ?? m.id, source: "catalog" })
        }
      }
    }
    const manual = selectedSettings?.defaultModel
    if (manual && !byId.has(manual)) {
      byId.set(manual, { id: manual, name: manual, source: "user" })
    }
    return [...byId.values()]
  }, [
    selectedBuiltIn,
    selectedId,
    selectedSettings?.discoveredModels,
    selectedSettings?.defaultModel,
    openRouterCatalogRow,
  ])

  const persistLocalProviderModels = useCallback(
    async (models: LocalModelInfo[]) => {
      if (!selectedId || !isLocalProvider) return
      const discoveredModels = models.map((model) => ({
        id: model.id,
        name: model.id,
        provider: model.owned_by,
        contextLength: model.context_length,
      }))
      // The Models tab polls the engine every 30 s and reports the list each
      // time. Only write when the discovered set actually changed — an
      // unconditional write here was a settings-singleton save (and a
      // companion sync re-emit) every poll while the tab was open.
      const previous = selectedSettings?.discoveredModels ?? []
      const unchanged =
        previous.length === discoveredModels.length &&
        previous.every(
          (model, index) =>
            model.id === discoveredModels[index]?.id &&
            model.contextLength === discoveredModels[index]?.contextLength
        )
      if (unchanged && selectedSettings?.discoveredModelsLastFetched) return
      const enabledDiscoveredModel = selectedSettings?.enabledModels?.find((id) =>
        discoveredModels.some((model) => model.id === id)
      )
      const nextDefaultModel =
        discoveredModels.length > 0 &&
        !discoveredModels.some((model) => model.id === selectedSettings?.defaultModel)
          ? (enabledDiscoveredModel ?? discoveredModels[0]?.id)
          : undefined

      await setProviderConfig(selectedId, {
        discoveredModels,
        discoveredModelsLastFetched: Date.now(),
        ...(nextDefaultModel ? { defaultModel: nextDefaultModel } : {}),
      })
    },
    [
      isLocalProvider,
      selectedId,
      selectedSettings?.defaultModel,
      selectedSettings?.enabledModels,
      selectedSettings?.discoveredModels,
      selectedSettings?.discoveredModelsLastFetched,
      setProviderConfig,
    ]
  )

  /**
   * Actually refresh the model list for the selected built-in provider.
   *
   * This used to call `s.testProvider(...)`, which only writes
   * `discoveredModels` on the `bedrock` branch — so for every other provider
   * the "Refresh models" button ran a connection test and changed no models at
   * all. Each provider family has a real refresh path already:
   *   - bedrock     → `testProvider` (its `testAndDiscoverBedrock` branch does
   *                   discover + persist)
   *   - openrouter  → the live `/models` catalog
   *   - subscription plugins → their declared model API with a vault-owned key
   *   - everything  → the models.dev catalog, which feeds
   *     else          `enrichedBuiltInModels` via
   *                   `buildBuiltInProviderModelDiscoverySnapshot`
   */
  const handleRefreshModels = useCallback(async () => {
    if (!selectedId) return
    setTestingConnection((prev) => ({ ...prev, [selectedId]: true }))
    const subscription = getSubscriptionProvider(selectedId)
    const controller = new AbortController()
    modelRefresh.current?.abort()
    modelRefresh.current = controller
    try {
      if (subscription?.source === "plugin") {
        const before = useSettingsStore.getState().settings?.providerSettings?.[selectedId]
        const result = await discoverSubscriptionModels({
          definition: subscription,
          signal: controller.signal,
        })
        if (
          controller.signal.aborted ||
          getSubscriptionProvider(selectedId) !== subscription ||
          useSettingsStore.getState().settings?.providerSettings?.[selectedId] !== before
        )
          return
        await setProviderConfig(selectedId, {
          discoveredModels: result.models,
          discoveredModelsLastFetched: result.fetchedAt,
        })
      } else if (selectedId === "bedrock") {
        await s.testProvider(selectedId)
      } else if (selectedId === "openrouter") {
        await syncOpenRouterCatalog(selectedSettings?.apiKey)
      } else {
        await syncModelsDevCatalog()
      }
    } catch {
      if (!controller.signal.aborted) toast.error(tSubscription("modelLoadFailed"))
    } finally {
      setTestingConnection((prev) => ({ ...prev, [selectedId]: false }))
    }
  }, [
    selectedId,
    s,
    selectedSettings,
    syncOpenRouterCatalog,
    syncModelsDevCatalog,
    setProviderConfig,
    tSubscription,
  ])

  /** Connection test, split out of the refresh button so each says what it does. */
  const handleTestConnection = useCallback(async () => {
    if (!selectedId) return
    setTestingConnection((prev) => ({ ...prev, [selectedId]: true }))
    try {
      await s.testProvider(selectedId)
    } finally {
      setTestingConnection((prev) => ({ ...prev, [selectedId]: false }))
    }
  }, [selectedId, s])

  // Open custom provider editor
  const handleEditCustom = useCallback(() => {
    setEditingCustomId(selectedId)
    setCustomDialogOpen(true)
  }, [selectedId])

  // Sidebar component (shared between desktop and mobile)
  const sidebar = (
    <ProviderSidebar
      providers={sidebarProviders}
      selectedId={selectedId}
      onSelect={(id) => {
        void s.setSelectedProviderId(id)
        selectWorkspace("providers")
        setStackedView("detail")
      }}
      onCompareClick={() => {
        selectWorkspace("compare")
        setStackedView("detail")
      }}
      compareSelected={activeWorkspace === "compare"}
      compareCount={comparisonKeys.length}
      onRoutingClick={() => {
        selectWorkspace("routing")
        setStackedView("detail")
      }}
      routingSelected={activeWorkspace === "routing"}
      globalTotal={s.filteredProviders.length + s.visibleCustomProviderIds.length}
      categoryFilter={categoryFilter}
      onCategoryChange={setCategoryFilter}
      statusFilter={statusFilter}
      onStatusFilterChange={setStatusFilter}
      sortBy={sortBy}
      onSortByChange={setSortBy}
      searchQuery={search}
      onSearchChange={setSearch}
      emptyState={
        <ProviderEmptyState
          onAddProvider={() => setShowQuickAdd(true)}
          importButton={<ProviderImportExport />}
        />
      }
      hasActiveFilters={search.trim() !== "" || categoryFilter !== "all" || statusFilter !== "all"}
      onClearFilters={() => {
        setSearch("")
        setCategoryFilter("all")
        setStatusFilter("all")
      }}
      addButton={
        <div className="flex items-center gap-2">
          <Button
            size="icon"
            variant="outline"
            className="shrink-0 @[420px]/provider-rail:w-auto @[420px]/provider-rail:px-3"
            title={t("addProvider")}
            onClick={() => setShowQuickAdd(true)}
          >
            <Plus className="h-4 w-4" />
            <span className="sr-only @[420px]/provider-rail:not-sr-only">{t("addProvider")}</span>
          </Button>
          <ProviderImportExport compact />
        </div>
      }
    />
  )

  if (!settingsLoaded) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-4 p-1" data-testid="provider-skeleton">
        <ProviderSkeleton />
      </div>
    )
  }

  // Ghost icon buttons with tooltips — same shape as the shell's own header
  // actions (finder trigger, actions menu) so the whole row reads uniformly.
  const verifyEnabledButton = (
    <div className="flex items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            data-testid="verify-enabled-providers"
            disabled={batchVerification.isRunning || batchEligibleCount === 0}
            aria-label={t("batchOperationVerifyEnabled")}
            onClick={() => void runBatchVerification()}
          >
            <PlugZap className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {batchEligibleCount === 0
            ? t("batchNoEligibleProviders")
            : t("batchOperationVerifyEnabled")}
        </TooltipContent>
      </Tooltip>
      {/* Only offered once something has actually failed — an always-visible
          disabled button would just be noise next to Verify. */}
      {batchRetryCount > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              data-testid="retry-failed-providers"
              disabled={batchVerification.isRunning}
              aria-label={`${t("batchOperationRetryFailed")} (${batchRetryCount})`}
              onClick={() => void runBatchRetryFailed()}
            >
              <RotateCcw className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t("batchOperationRetryFailed")} ({batchRetryCount})
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
  // The progress strip and its summary only take layout space while a batch
  // is running or has produced a result — otherwise the empty wrapper left a
  // phantom gap under the header.
  const showBatchStrip = batchVerification.isRunning || batchVerification.total > 0

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* Companion hosts: keys entered here never reach the paired host. */}
      <ProviderHostNotice kind="companion" />
      <ExternalRuntimeConnectionsCard connections={externalRuntimes} />
      <ProviderOnboardingBanner
        externalRuntimeReady={externalRuntimes.workingCount > 0}
        onScrollToProvider={(id) => {
          // Clear any active search/category filter so the target row is
          // guaranteed to be mounted for the banner's own `getElementById`
          // scroll, and select it so the detail panel opens too.
          setSearch("")
          setCategoryFilter("all")
          void s.setSelectedProviderId(id)
        }}
      />

      {headerActionsTarget ? (
        createPortal(verifyEnabledButton, headerActionsTarget)
      ) : (
        <div className="flex justify-end">{verifyEnabledButton}</div>
      )}

      {showBatchStrip && (
        <div className="space-y-2" data-testid="batch-strip">
          <BatchTestProgress
            isRunning={batchVerification.isRunning}
            progress={
              batchVerification.total === 0
                ? 0
                : (batchVerification.completed / batchVerification.total) * 100
            }
            cancelRequested={batchVerification.cancelRequested}
            onCancel={cancelBatch}
          />
          {!batchVerification.isRunning && (
            <TestResultsSummary
              success={batchVerification.success}
              failed={batchVerification.failed}
              total={batchVerification.completed}
              operationType={batchOperationType}
              completed={batchVerification.completed}
              expectedTotal={batchVerification.total}
              canceled={batchVerification.canceled}
            />
          )}
        </div>
      )}

      {/* Master/detail on the shared container-query frame, not on `useIsMobile`.
          This pane never gets the viewport: it gets the window minus the app
          rail, minus the 15rem settings sidebar, minus padding. At a 1000px
          window the old fixed `320px minmax(0,1fr)` grid left the detail column
          328px, and at 820px it left 340px, because the 768px viewport
          breakpoint had not fired yet. A 1024px iPad was worse: the Capacitor
          shell pins `useIsMobile()` to true, so a tablet got the phone layout.

          The rail column is now `clamp(200px, 30cqi, railWidth)`, so it gives
          up width proportionally instead of pinning 320px and letting the
          detail absorb every lost pixel. Below @[560px] the rail moves into a
          drawer and the detail stays put, rather than the old push-navigation
          that replaced the whole pane. */}
      <SettingsListDetail listWidth={railWidth} data-testid="provider-layout">
        <ProviderRailHost
          rail={sidebar}
          railWidth={railWidth}
          railResize={railResize}
          selectedName={
            activeWorkspace === "compare"
              ? t("comparison.title")
              : activeWorkspace === "routing"
                ? t("sidebar.routing")
                : selectedName
          }
          stackedView={stackedView}
          onShowList={() => setStackedView("list")}
          onAdd={() => setShowQuickAdd(true)}
          // ── Detail panel ─────────────────────────────────────────────
          // `@container/provider-pane`: the pane is pinned beside a fixed 320px
          // rail, so its width and the viewport width are different numbers.
          // Children that sized themselves with `md:`/`sm:` were reading the
          // window and laying out 2- and 4-column grids into a ~430px pane at
          // the md breakpoint. Same fix the subscription pane already uses.
          //
          // On a stacked pane the rail host mounts this only in its detail
          // page (a list → detail push), so the border is unconditional
          // rather than `SETTINGS_DETAIL_PANE_CLASS`, which drops it below
          // 440px while our split threshold is 560px.
          detail={
            <div className="@container/provider-pane flex min-h-0 flex-col overflow-hidden rounded-lg border">
              {/* Selecting a provider swapped this whole subtree instantly, which is
              exactly what `PanelTransition` exists for — Appearance and
              Subscription already crossfade their master/detail bodies with it.
              Keyed on the selection (plus the empty state) so the outgoing pane
              fades out before the incoming one settles. It collapses to a plain
              wrapper under reduced motion. */}
              <PanelTransition
                activeKey={
                  activeWorkspace === "routing"
                    ? "__routing__"
                    : activeWorkspace === "compare"
                      ? "__compare__"
                      : (selectedId ?? "__empty__")
                }
                className="flex min-h-0 flex-1 flex-col"
              >
                {activeWorkspace === "routing" ? (
                  <div className="flex min-h-0 flex-1 flex-col">
                    <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
                      <Route className="h-5 w-5 text-muted-foreground" />
                      <div>
                        <h3 className="text-base font-semibold">{t("sidebar.routing")}</h3>
                        <p className="text-xs text-muted-foreground">
                          {t("routingWorkspaceDescription")}
                        </p>
                      </div>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto p-4">
                      <div className="mx-auto w-full max-w-4xl">
                        <RoutingTab />
                      </div>
                    </div>
                  </div>
                ) : activeWorkspace === "compare" ? (
                  <ProviderComparisonView
                    onBack={() => selectWorkspace("providers")}
                    selectedModelKeys={comparisonKeys}
                    onSelectedModelKeysChange={setComparisonKeys}
                  />
                ) : selectedId === null ? (
                  <div className="flex h-full items-center justify-center">
                    <div className="flex flex-col items-center gap-4 py-12 text-center">
                      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
                        <Settings className="h-8 w-8 text-muted-foreground/40" />
                      </div>
                      <div>
                        <h3 className="text-base font-semibold text-foreground">
                          {t("detailPanel.emptyTitle")}
                        </h3>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {t("detailPanel.emptyDescription")}
                        </p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <ProviderDetailHost
                    // Explicit key: `PanelTransition` only remounts when motion is
                    // enabled, so under reduced motion the active tab / revealed
                    // key state leaked from one provider to the next.
                    key={selectedId}
                    selectedId={selectedId}
                    selectedBuiltIn={selectedBuiltIn}
                    selectedCustom={selectedCustom}
                    selectedSettings={selectedSettings}
                    selectedName={selectedName}
                    selectedReadiness={selectedReadiness}
                    isCustom={isCustom}
                    isLocalProvider={isLocalProvider}
                    isEnabled={isEnabled}
                    canEnable={canEnable}
                    enableBlockedReason={enableBlockedReason}
                    canSetDefault={canSetDefault}
                    setDefaultBlockedReason={setDefaultBlockedReason}
                    isDefault={selectedId === defaultProvider}
                    settings={s}
                    liveProviderHealth={liveProviderHealth}
                    setProviderConfig={setProviderConfig}
                    configModelOptions={configModelOptions}
                    enrichedBuiltInModels={enrichedBuiltInModels}
                    modelsDevLoading={modelsDevLoading}
                    diagnosticStatusByModel={modelDiagnosticBadges}
                    configTestResult={configTestResult}
                    isRefreshingModels={!!testingConnection[selectedId]}
                    onRefreshModels={handleRefreshModels}
                    onTestConnection={handleTestConnection}
                    onEditCustom={handleEditCustom}
                    onPersistLocalModels={persistLocalProviderModels}
                    onRequestDelete={() => setPendingDeleteId(selectedId)}
                    compare={{
                      keys: comparisonKeys,
                      onToggle: toggleComparisonKey,
                      onOpen: () => {
                        selectWorkspace("compare")
                        setStackedView("detail")
                      },
                      onClear: () => setComparisonKeys([]),
                    }}
                  />
                )}
              </PanelTransition>
            </div>
          }
        />
      </SettingsListDetail>

      {/* ── Dialogs ────────────────────────────────────────────────────── */}
      {showQuickAdd && (
        <QuickAddProviderDialog
          open={showQuickAdd}
          onOpenChange={setShowQuickAdd}
          onAddCustom={() => {
            setEditingCustomId(null)
            setCustomDialogOpen(true)
          }}
          onAdded={(providerId, name) => {
            // Reveal what was just added: clear filters that could hide the
            // new custom row, select it, and say so — the dialog used to just
            // close, leaving the row at the bottom of a possibly filtered list.
            setSearch("")
            setCategoryFilter("all")
            setStatusFilter("all")
            selectWorkspace("providers")
            setStackedView("detail")
            void s.setSelectedProviderId(providerId)
            toast.success(t("quickAdd.addedToast", { name }))
          }}
        />
      )}
      {customDialogOpen && (
        <CustomProviderDialog
          open={customDialogOpen}
          onOpenChange={setCustomDialogOpen}
          editingProviderId={editingCustomId}
        />
      )}
      <AlertDialog
        open={pendingDeleteId !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDeleteId(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteProviderTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteProviderConfirm", {
                name:
                  (pendingDeleteId ? s.customProviders[pendingDeleteId]?.customName : undefined) ??
                  pendingDeleteId ??
                  "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="cancel-delete-custom-provider">
              {t("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirm-delete-custom-provider"
              onClick={() => {
                if (!pendingDeleteId) return
                void s.removeCustomProvider(pendingDeleteId)
                void s.setSelectedProviderId(null)
                setPendingDeleteId(null)
              }}
            >
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default ProviderSettings
