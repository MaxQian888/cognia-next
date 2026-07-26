"use client"

import dynamic from "next/dynamic"
import { useEffect, useMemo, useState, useCallback, useRef } from "react"
import { Plus, Menu, Settings, Key, Globe, PlugZap, Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useProviderSettings } from "@/hooks/settings/use-provider-settings"
import { useProviderManager, type ProviderHealth } from "@/hooks/ai/use-provider-manager"
import { useModelsDevCatalog } from "@/hooks/settings/use-models-dev-catalog"
import { useOpenRouterCatalog } from "@/hooks/settings/use-openrouter-catalog"
import { buildBuiltInProviderModelDiscoverySnapshot } from "@cognia/provider-core/providers/model-discovery"
import { PROVIDERS } from "@cognia/provider-types/provider"
import type { CustomProviderSettings, ProviderUIPreferences } from "@cognia/provider-types/provider"
import { validateBedrockConnectionSettings } from "@cognia/provider-types"
import { PanelTransition } from "@/components/settings/common/panel-transition"
import { ProviderDetailPanel } from "./provider-detail-panel"
import { ProviderConfigTab } from "./provider-config-tab"
import { ProviderModelsTab } from "./provider-models-tab"
import { ProviderCostTab } from "./provider-cost-tab"
import { ProviderParametersTab } from "./provider-parameters-tab"
import { RoutingTab } from "./routing-tab"
import { HealthTab } from "./health-tab"
import { ProviderSidebar } from "./provider-sidebar"
import { ProviderEmptyState } from "./provider-empty-state"
import { ProviderSkeleton } from "./provider-skeleton"
import { ProviderOnboardingBanner } from "./provider-onboarding-banner"
import { ProviderCompareDialog } from "./provider-compare-dialog"
import { BatchTestProgress, TestResultsSummary } from "./batch-test-progress"
import { OAuthLoginButton } from "./oauth-login-button"
import { useSettingsStore } from "@/stores/settings"
import type { ProviderConnectionStatus } from "./provider-sidebar-item"
import { deriveStatus, providerMatchesCategory } from "./provider-status-utils"
import {
  getBuiltInProviderReadiness,
  getCustomProviderReadiness,
  getVisibleEligibleBuiltInProviderIds,
  getVisibleEligibleCustomProviderIds,
} from "./provider-readiness"

type SidebarProvider = {
  id: string
  name: string
  subtitle: string
  status: ProviderConnectionStatus
  isCustom: boolean
  modelCount?: number
}

type ProviderStatusFilter = NonNullable<ProviderUIPreferences["statusFilter"]>

function preferLiveHealth(
  health: ProviderHealth | undefined,
  fallbackOk: boolean | undefined,
  fallbackOutcome: "verified" | "failed" | "limited" | "success" | "error" | null | undefined
): {
  ok: boolean | undefined
  outcome: "verified" | "failed" | "limited" | "success" | "error" | null | undefined
} {
  if (!health || health.totalRequests === 0) {
    return { ok: fallbackOk, outcome: fallbackOutcome }
  }
  if (health.status === "healthy") return { ok: true, outcome: "verified" }
  if (health.status === "degraded") return { ok: undefined, outcome: "limited" }
  if (health.status === "error") return { ok: false, outcome: "failed" }
  return { ok: fallbackOk, outcome: fallbackOutcome }
}

const CustomProviderDialog = dynamic(
  () => import("./custom-provider-dialog").then((m) => m.CustomProviderDialog),
  { ssr: false }
)
const QuickAddProviderDialog = dynamic(
  () => import("./quick-add-provider-dialog").then((m) => m.QuickAddProviderDialog),
  { ssr: false }
)
const LocalProviderSettings = dynamic(
  () => import("./local-provider-settings").then((m) => m.LocalProviderSettings),
  { ssr: false }
)
// Provider-specific config panels — lazy because each is 18-27 KB and only
// loads for the one provider that needs it.
const OpenRouterSettings = dynamic(
  () => import("./openrouter-settings").then((m) => m.OpenRouterSettings),
  { ssr: false }
)
const OpenRouterKeyManagement = dynamic(
  () => import("./openrouter-key-management").then((m) => m.OpenRouterKeyManagement),
  { ssr: false }
)
const CLIProxyAPISettings = dynamic(
  () => import("./cliproxyapi-settings").then((m) => m.CLIProxyAPISettings),
  { ssr: false }
)
// Export/import of the whole provider configuration. Renders as a two-button
// toolbar that owns its own dialogs (conflict detection + skip/overwrite/merge
// resolution live inside it).
const ProviderImportExport = dynamic(
  () => import("./provider-import-export").then((m) => m.ProviderImportExport),
  { ssr: false }
)

/* ── Custom provider inline config ──────────────────────────────────────────── */

// Custom-provider credentials live on the `customProviders` row itself
// (written via `updateCustomProvider`), NOT in the `providerSettings` map —
// read and write the same source or the controlled inputs reset on every
// keystroke and edits get silently mangled.
function CustomProviderInlineConfig({
  cp,
  onApiKeyChange,
  onBaseURLChange,
  onDefaultModelChange,
  onEditClick,
  onTestConnection,
  testResult,
  isTesting = false,
}: {
  cp: CustomProviderSettings
  onApiKeyChange: (key: string) => void
  onBaseURLChange: (url: string) => void
  onDefaultModelChange: (model: string) => void
  onEditClick: () => void
  onTestConnection: () => void
  testResult?: "success" | "error" | "limited" | null
  isTesting?: boolean
}) {
  const t = useTranslations("providers")
  const [showKey, setShowKey] = useState(false)

  return (
    <div className="space-y-5">
      {/* API Key */}
      <div className="space-y-2">
        <Label className="flex items-center gap-1.5 text-sm font-medium">
          <Key className="h-3.5 w-3.5" />
          {t("configTab.apiKeyLabel") || "API Key"}
        </Label>
        <div className="relative">
          <Input
            type={showKey ? "text" : "password"}
            value={cp.apiKey ?? ""}
            onChange={(e) => onApiKeyChange(e.target.value)}
            placeholder={t("configTab.apiKeyPlaceholder") || "Enter your API key"}
            className="pr-10"
            autoComplete="new-password"
            data-lpignore="true"
            data-form-type="other"
          />
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2"
            onClick={() => setShowKey((prev) => !prev)}
            type="button"
          >
            {showKey ? "H" : "S"}
          </Button>
        </div>
      </div>

      {/* Base URL */}
      <div className="space-y-2">
        <Label className="flex items-center gap-1.5 text-sm font-medium">
          <Globe className="h-3.5 w-3.5" />
          {t("baseURL") || "Base URL"}
        </Label>
        <Input
          type="text"
          value={cp.baseURL ?? ""}
          onChange={(e) => onBaseURLChange(e.target.value)}
          placeholder={cp.baseURL}
        />
        <p className="text-xs text-muted-foreground">{t("baseURLHint")}</p>
      </div>

      {/* Default model */}
      {cp.customModels && cp.customModels.length > 0 && (
        <div className="space-y-2">
          <Label className="text-sm font-medium">{t("defaultModel") || "Default Model"}</Label>
          <Select value={cp.defaultModel ?? ""} onValueChange={onDefaultModelChange}>
            <SelectTrigger className="h-9 text-sm">
              <SelectValue placeholder={t("selectModel") || "Select model"} />
            </SelectTrigger>
            <SelectContent>
              {cp.customModels.map((modelId: string) => (
                <SelectItem key={modelId} value={modelId}>
                  {cp.customModelMetadata?.[modelId]?.name ?? modelId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Protocol badge + test/edit buttons */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary" className="text-[10px]">
            {cp.apiProtocol}
          </Badge>
          {testResult && (
            <span
              data-testid="custom-provider-test-result"
              className={
                testResult === "success"
                  ? "truncate text-[11px] text-emerald-600 dark:text-emerald-400"
                  : testResult === "limited"
                    ? "truncate text-[11px] text-amber-600 dark:text-amber-400"
                    : "truncate text-[11px] text-destructive"
              }
            >
              {testResult === "success"
                ? t("customTestSuccess")
                : testResult === "limited"
                  ? t("customTestLimited")
                  : t("customTestError")}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {/* `testCustomProvider` was fully implemented but had zero callers, so
              `customTestResults` stayed empty forever and a custom provider's
              status badge could never leave "warning". */}
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={onTestConnection}
            disabled={isTesting}
            data-testid="custom-provider-test"
          >
            {isTesting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <PlugZap className="h-3 w-3" />
            )}
            {t("testConnection")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={onEditClick}
            data-testid="custom-provider-edit"
          >
            <Settings className="h-3 w-3" />
            {t("editCustomProvider") || "Edit"}
          </Button>
        </div>
      </div>
    </div>
  )
}

/* ── Main ───────────────────────────────────────────────────────────────────── */

export function ProviderSettings() {
  const t = useTranslations("providers")
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

  const [search, setSearch] = useState("")
  const [categoryFilterOverride, setCategoryFilterOverride] = useState<string | null>(null)
  const categoryFilter = categoryFilterOverride ?? s.uiPreferences.categoryFilter ?? "all"
  const setCategoryFilter = useCallback(
    (category: string) => {
      setCategoryFilterOverride(category)
      void setProviderUIPreferences({ categoryFilter: category === "all" ? undefined : category })
    },
    [setProviderUIPreferences]
  )
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
  const [activeTab, setActiveTab] = useState<"parameters" | "routing" | "health">("parameters")
  const [compareOpen, setCompareOpen] = useState(false)
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false)
  const [testingConnection, setTestingConnection] = useState<Record<string, boolean>>({})
  const batchCancelRequested = useRef(false)
  const [batchVerification, setBatchVerification] = useState({
    isRunning: false,
    cancelRequested: false,
    total: 0,
    completed: 0,
    success: 0,
    failed: 0,
    canceled: false,
  })
  // Deleting a custom provider drops its saved credentials and cannot be
  // undone, so it gets a confirmation step instead of firing on first click.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)

  // Build sidebar providers with category filter
  const sidebarProviders = useMemo<SidebarProvider[]>(() => {
    const builtIn = s.filteredProviders
      .filter(([id]) => {
        const q = search.trim().toLowerCase()
        if (categoryFilter === "custom") return false
        if (categoryFilter !== "all" && !providerMatchesCategory(categoryFilter, id)) return false
        if (!q) return true
        const cfg = PROVIDERS[id]
        if (!cfg) return false
        return id.toLowerCase().includes(q) || cfg.name.toLowerCase().includes(q)
      })
      .map(([id, cfg]) => {
        const settings = s.providerSettings[id]
        const test = s.testResults[id]
        const effectiveTest = preferLiveHealth(liveProviderHealth[id], test?.success, test?.outcome)
        return {
          id,
          name: cfg.name,
          subtitle: settings?.defaultModel ?? cfg.defaultModel,
          status: deriveStatus(
            settings?.apiKey,
            settings?.baseURL,
            effectiveTest.ok,
            effectiveTest.outcome,
            id === "bedrock" && !!settings?.bedrock
              ? validateBedrockConnectionSettings(settings.bedrock).valid
              : false,
            settings?.verificationStatus ?? null
          ),
          isCustom: false,
          modelCount: cfg.models.length,
        }
      })

    const custom: SidebarProvider[] = []
    for (const id of s.visibleCustomProviderIds) {
      const cp = s.customProviders[id]
      if (!cp) continue
      if (categoryFilter !== "all" && categoryFilter !== "custom") continue
      const q = search.trim().toLowerCase()
      if (q && !cp.customName.toLowerCase().includes(q) && !id.toLowerCase().includes(q)) {
        continue
      }
      const testOutcome = s.customTestResults[id]
      const testOk = testOutcome === "success" ? true : testOutcome === "error" ? false : undefined
      const effectiveTest = preferLiveHealth(liveProviderHealth[id], testOk, testOutcome)
      custom.push({
        id,
        name: cp.customName,
        subtitle: cp.defaultModel ?? cp.baseURL,
        status: deriveStatus(cp.apiKey, cp.baseURL, effectiveTest.ok, effectiveTest.outcome),
        isCustom: true,
        modelCount: cp.customModels?.length ?? 0,
      })
    }

    return [...builtIn, ...custom]
  }, [
    s.filteredProviders,
    s.providerSettings,
    s.testResults,
    s.visibleCustomProviderIds,
    s.customProviders,
    s.customTestResults,
    liveProviderHealth,
    search,
    categoryFilter,
  ])

  // Auto-select first provider
  useEffect(() => {
    if (!s.selectedProviderId && sidebarProviders.length > 0) {
      void s.setSelectedProviderId(sidebarProviders[0].id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarProviders.length])

  const selectedId = s.selectedProviderId
  const selectedBuiltIn = selectedId ? PROVIDERS[selectedId] : undefined
  const selectedCustom = selectedId ? s.customProviders[selectedId] : undefined
  const isCustom = !!selectedCustom
  // Local inference engines (Ollama, LM Studio, llama.cpp, …) are keyless and
  // get their own purpose-built dashboard (auto-detect + model manager +
  // setup wizard) instead of the generic cloud-provider Config/Models/Cost
  // tabs, which assume an API key and don't apply here.
  const isLocalProvider = selectedBuiltIn?.category === "local"

  const selectedSettings = selectedId ? s.providerSettings[selectedId] : undefined
  const isEnabled = isCustom
    ? (selectedCustom?.enabled ?? false)
    : (selectedSettings?.enabled ?? false)
  const selectedReadiness = useMemo(() => {
    if (!selectedId) return null
    if (selectedCustom) {
      const outcome = s.customTestResults[selectedId]
      return getCustomProviderReadiness(
        selectedCustom,
        outcome === undefined || outcome === null ? undefined : { success: outcome === "success" }
      )
    }
    return getBuiltInProviderReadiness(
      selectedId,
      selectedSettings,
      s.testResults[selectedId]
        ? {
            success: !!s.testResults[selectedId]?.success,
            outcome: s.testResults[selectedId]?.outcome,
          }
        : undefined
    )
  }, [selectedCustom, selectedId, selectedSettings, s.customTestResults, s.testResults])
  const canEnable = selectedReadiness?.eligibility.enable.allowed ?? false
  const canSetDefault = isEnabled && (isCustom ? Boolean(selectedCustom?.defaultModel) : true)

  const selectedName = isCustom ? selectedCustom?.customName : selectedBuiltIn?.name

  const batchEligibleBuiltInIds = useMemo(
    () =>
      getVisibleEligibleBuiltInProviderIds(
        s.filteredProviders.map(([providerId]) => providerId),
        s.providerSettings,
        s.testResults
      ),
    [s.filteredProviders, s.providerSettings, s.testResults]
  )
  const batchEligibleCustomIds = useMemo(
    () =>
      getVisibleEligibleCustomProviderIds(
        s.visibleCustomProviderIds,
        s.customProviders,
        s.customTestResults
      ),
    [s.customProviders, s.customTestResults, s.visibleCustomProviderIds]
  )
  const batchEligibleCount = batchEligibleBuiltInIds.length + batchEligibleCustomIds.length

  const runBatchVerification = useCallback(async () => {
    if (batchVerification.isRunning || batchEligibleCount === 0) return
    batchCancelRequested.current = false
    setBatchVerification({
      isRunning: true,
      cancelRequested: false,
      total: batchEligibleCount,
      completed: 0,
      success: 0,
      failed: 0,
      canceled: false,
    })

    const jobs = [
      ...batchEligibleBuiltInIds.map((providerId) => ({
        providerId,
        run: () => s.testProvider(providerId),
      })),
      ...batchEligibleCustomIds.map((providerId) => ({
        providerId,
        run: () => s.testCustomProvider(providerId),
      })),
    ]

    let completed = 0
    let success = 0
    let failed = 0
    for (const job of jobs) {
      if (batchCancelRequested.current) break
      const result = await job.run()
      completed += 1
      if (result?.success) success += 1
      else failed += 1
      setBatchVerification((current) => ({
        ...current,
        completed,
        success,
        failed,
      }))
    }

    setBatchVerification((current) => ({
      ...current,
      isRunning: false,
      completed,
      success,
      failed,
      canceled: batchCancelRequested.current,
    }))
  }, [
    batchEligibleBuiltInIds,
    batchEligibleCount,
    batchEligibleCustomIds,
    batchVerification.isRunning,
    s,
  ])

  // models.dev catalog (reactive) → enrich the built-in provider's model list
  // with models.dev-authoritative metadata (pricing/context/capabilities) plus
  // the extra display fields (variants/family/release date/adapter).
  const {
    row: modelsDevRow,
    isLoading: modelsDevLoading,
    sync: syncModelsDevCatalog,
  } = useModelsDevCatalog()
  const enrichedBuiltInModels = useMemo(() => {
    if (!selectedBuiltIn || !selectedId) return []
    const devModels = modelsDevRow?.providers[selectedId]?.models ?? []
    const snapshot = buildBuiltInProviderModelDiscoverySnapshot({
      providerId: selectedId,
      catalogModels: selectedBuiltIn.models,
      modelsDevModels: devModels,
      settings: selectedSettings,
    })
    return snapshot.models.map((m) => {
      const meta = devModels.find((d) => d.id === m.id)
      return {
        id: m.id,
        name: m.name,
        contextLength: m.contextLength,
        maxOutputTokens: m.maxOutputTokens ?? meta?.maxOutputTokens,
        supportsTools: m.supportsTools,
        supportsVision: m.supportsVision,
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
  }, [selectedBuiltIn, selectedId, selectedSettings, modelsDevRow])

  // Default-model options for the Config tab. Static `PROVIDERS[id].models` is a
  // hand-curated subset; aggregators that refresh their list at runtime
  // (OpenRouter's synced live catalog, or any provider's per-account
  // `discoveredModels`) carry far more. Fold those dynamic sources in — deduped
  // by id, static first — so the Default Model dropdown actually lists the models
  // a dynamic provider can serve instead of an empty/stale set.
  const { row: openRouterCatalogRow, sync: syncOpenRouterCatalog } = useOpenRouterCatalog()
  const configModelOptions = useMemo<Array<{ id: string; name: string }>>(() => {
    if (!selectedBuiltIn || !selectedId) return []
    const byId = new Map<string, string>()
    for (const m of selectedBuiltIn.models) byId.set(m.id, m.name)
    for (const m of selectedSettings?.discoveredModels ?? []) {
      byId.set(m.id, m.name ?? m.id)
    }
    if (selectedId === "openrouter") {
      for (const m of openRouterCatalogRow?.models ?? []) {
        byId.set(m.id, m.name ?? m.id)
      }
    }
    return Array.from(byId, ([id, name]) => ({ id, name }))
  }, [selectedBuiltIn, selectedId, selectedSettings?.discoveredModels, openRouterCatalogRow])

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
   *   - everything  → the models.dev catalog, which feeds
   *     else          `enrichedBuiltInModels` via
   *                   `buildBuiltInProviderModelDiscoverySnapshot`
   */
  const handleRefreshModels = useCallback(async () => {
    if (!selectedId) return
    setTestingConnection((prev) => ({ ...prev, [selectedId]: true }))
    try {
      if (selectedId === "bedrock") {
        await s.testProvider(selectedId)
      } else if (selectedId === "openrouter") {
        await syncOpenRouterCatalog(selectedSettings?.apiKey)
      } else {
        await syncModelsDevCatalog()
      }
    } finally {
      setTestingConnection((prev) => ({ ...prev, [selectedId]: false }))
    }
  }, [selectedId, s, selectedSettings?.apiKey, syncOpenRouterCatalog, syncModelsDevCatalog])

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
        setMobileSheetOpen(false)
      }}
      onCompareClick={() => setCompareOpen(true)}
      categoryFilter={categoryFilter}
      onCategoryChange={setCategoryFilter}
      statusFilter={statusFilter}
      onStatusFilterChange={setStatusFilter}
      searchQuery={search}
      onSearchChange={setSearch}
      emptyState={
        <ProviderEmptyState
          onAddProvider={() => setShowQuickAdd(true)}
          importButton={<ProviderImportExport />}
        />
      }
      hasActiveFilters={search.trim() !== "" || categoryFilter !== "all"}
      onClearFilters={() => {
        setSearch("")
        setCategoryFilter("all")
      }}
      addButton={
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={() => setShowQuickAdd(true)}>
            <Plus className="mr-1 h-4 w-4" />
            <span className="sr-only @[420px]/provider-rail:not-sr-only">
              {t("addProvider" as never) as string}
            </span>
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

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <ProviderOnboardingBanner
        onScrollToProvider={(id) => {
          // Clear any active search/category filter so the target row is
          // guaranteed to be mounted for the banner's own `getElementById`
          // scroll, and select it so the detail panel opens too.
          setSearch("")
          setCategoryFilter("all")
          void s.setSelectedProviderId(id)
        }}
      />

      <div className="space-y-2">
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            data-testid="verify-enabled-providers"
            disabled={batchVerification.isRunning || batchEligibleCount === 0}
            title={batchEligibleCount === 0 ? t("batchNoEligibleProviders") : undefined}
            onClick={() => void runBatchVerification()}
          >
            <PlugZap className="h-3.5 w-3.5" />
            {t("batchOperationVerifyEnabled")}
          </Button>
        </div>
        <BatchTestProgress
          isRunning={batchVerification.isRunning}
          progress={
            batchVerification.total === 0
              ? 0
              : (batchVerification.completed / batchVerification.total) * 100
          }
          cancelRequested={batchVerification.cancelRequested}
          onCancel={() => {
            batchCancelRequested.current = true
            setBatchVerification((current) => ({ ...current, cancelRequested: true }))
          }}
        />
        {!batchVerification.isRunning && (
          <TestResultsSummary
            success={batchVerification.success}
            failed={batchVerification.failed}
            total={batchVerification.completed}
            operationType="verify-enabled"
            completed={batchVerification.completed}
            expectedTotal={batchVerification.total}
            canceled={batchVerification.canceled}
          />
        )}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-[320px_1fr]">
        {/* ── Desktop sidebar ──────────────────────────────────────────── */}
        <div className="hidden min-h-0 md:flex md:flex-col md:overflow-hidden md:rounded-lg md:border">
          {sidebar}
        </div>

        {/* ── Mobile top bar ───────────────────────────────────────────── */}
        <div className="flex items-center gap-2 md:hidden">
          <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="sm" className="shrink-0 gap-1.5">
                <Menu className="h-4 w-4" />
                {t("mobile.openProviders") || "Providers"}
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[300px] p-0">
              <SheetHeader className="px-3 pt-3">
                <SheetTitle className="text-sm">{t("title") || "AI Providers"}</SheetTitle>
              </SheetHeader>
              {sidebar}
            </SheetContent>
          </Sheet>
          {selectedId && (
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{selectedName ?? selectedId}</p>
            </div>
          )}
        </div>

        {/* ── Detail panel ─────────────────────────────────────────────
            `@container/provider-pane`: the pane is pinned beside a fixed 320px
            rail, so its width and the viewport width are different numbers.
            Children that sized themselves with `md:`/`sm:` were reading the
            window and laying out 2- and 4-column grids into a ~430px pane at
            the md breakpoint. Same fix the subscription pane already uses. */}
        <div className="@container/provider-pane flex min-h-0 flex-col overflow-hidden rounded-lg border">
          {/* Selecting a provider swapped this whole subtree instantly, which is
              exactly what `PanelTransition` exists for — Appearance and
              Subscription already crossfade their master/detail bodies with it.
              Keyed on the selection (plus the empty state) so the outgoing pane
              fades out before the incoming one settles. It collapses to a plain
              wrapper under reduced motion. */}
          <PanelTransition
            activeKey={selectedId ?? "__empty__"}
            className="flex min-h-0 flex-1 flex-col"
          >
            {selectedId === null ? (
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
              <ProviderDetailPanel
                provider={
                  selectedBuiltIn
                    ? {
                        id: selectedId,
                        name: selectedBuiltIn.name,
                        modelCount: selectedBuiltIn.models.length,
                      }
                    : selectedCustom
                      ? {
                          id: selectedId,
                          name: selectedCustom.customName,
                          modelCount: selectedCustom.customModels?.length ?? 0,
                        }
                      : null
                }
                isEnabled={isEnabled}
                canEnable={canEnable}
                isCustom={isCustom}
                isDefault={selectedId === defaultProvider}
                onSetDefault={
                  canSetDefault ? () => void s.setDefaultProvider(selectedId) : undefined
                }
                connectionStatus={
                  isCustom
                    ? (() => {
                        const testOutcome = s.customTestResults[selectedId]
                        const effectiveTest = preferLiveHealth(
                          liveProviderHealth[selectedId],
                          testOutcome === "success"
                            ? true
                            : testOutcome === "error"
                              ? false
                              : undefined,
                          testOutcome
                        )
                        return deriveStatus(
                          selectedCustom?.apiKey,
                          selectedCustom?.baseURL,
                          effectiveTest.ok,
                          effectiveTest.outcome
                        )
                      })()
                    : (() => {
                        const test = s.testResults[selectedId]
                        const effectiveTest = preferLiveHealth(
                          liveProviderHealth[selectedId],
                          test?.success,
                          test?.outcome
                        )
                        return deriveStatus(
                          selectedSettings?.apiKey,
                          selectedSettings?.baseURL,
                          effectiveTest.ok,
                          effectiveTest.outcome,
                          selectedId === "bedrock" && !!selectedSettings?.bedrock
                            ? validateBedrockConnectionSettings(selectedSettings.bedrock).valid
                            : false,
                          selectedSettings?.verificationStatus ?? null
                        )
                      })()
                }
                onToggleEnabled={(next) => {
                  if (next && !canEnable) return
                  if (isCustom && selectedCustom) {
                    void s.updateCustomProvider(selectedId, { enabled: next })
                  } else {
                    void setProviderConfig(selectedId, { enabled: next })
                  }
                }}
                onDelete={isCustom ? () => setPendingDeleteId(selectedId) : undefined}
                configTab={
                  // A local engine (Ollama, LM Studio, llama.cpp, …) is keyless
                  // and gets its own dashboard, but it stays INSIDE the shared
                  // detail shell so it keeps the header, enable switch, default
                  // badge and status the rest of the list has.
                  isLocalProvider ? (
                    <LocalProviderSettings />
                  ) : isCustom && selectedCustom ? (
                    <CustomProviderInlineConfig
                      cp={selectedCustom}
                      onApiKeyChange={(key) =>
                        void s.updateCustomProvider(selectedId, { apiKey: key })
                      }
                      onBaseURLChange={(url) =>
                        void s.updateCustomProvider(selectedId, { baseURL: url })
                      }
                      onDefaultModelChange={(model) =>
                        void s.updateCustomProvider(selectedId, { defaultModel: model })
                      }
                      onEditClick={handleEditCustom}
                      onTestConnection={() => void s.testCustomProvider(selectedId)}
                      testResult={s.customTestResults[selectedId] ?? null}
                      isTesting={!!s.testingCustomProviders[selectedId]}
                    />
                  ) : selectedBuiltIn ? (
                    <div className="space-y-6">
                      <ProviderConfigTab
                        providerId={selectedId}
                        settings={
                          selectedSettings ?? {
                            providerId: selectedId,
                            enabled: false,
                            defaultModel: selectedBuiltIn.defaultModel,
                          }
                        }
                        providerModels={configModelOptions}
                        providerDashboardUrl={selectedBuiltIn.dashboardUrl}
                        providerDocsUrl={selectedBuiltIn.docsUrl}
                        onApiKeyChange={(key) =>
                          void setProviderConfig(selectedId, { apiKey: key })
                        }
                        onBaseURLChange={(url) =>
                          void setProviderConfig(selectedId, { baseURL: url })
                        }
                        onBedrockSettingsChange={(bedrock) =>
                          void setProviderConfig(selectedId, {
                            bedrock,
                            apiKey: bedrock.authMode === "api-key" ? bedrock.apiKey : undefined,
                            baseURL: bedrock.baseURL,
                          })
                        }
                        onApiProtocolChange={(protocol) =>
                          void setProviderConfig(selectedId, { apiProtocol: protocol })
                        }
                        onDefaultModelChange={(model) =>
                          void setProviderConfig(selectedId, { defaultModel: model })
                        }
                        onTestConnection={async () => {
                          const result = await s.testProvider(selectedId)
                          return {
                            success: !!result?.success,
                            latency: result?.latency_ms,
                            error: result?.success ? undefined : result?.message,
                            outcome: result?.outcome,
                          }
                        }}
                        testResult={
                          s.testResults[selectedId]
                            ? {
                                success: !!s.testResults[selectedId]?.success,
                                latency: s.testResults[selectedId]?.latency_ms,
                                error: s.testResults[selectedId]?.success
                                  ? undefined
                                  : s.testResults[selectedId]?.message,
                              }
                            : null
                        }
                        isTesting={!!s.testingProviders[selectedId]}
                        onAddApiKey={(key) => {
                          const pool = selectedSettings?.apiKeys ?? []
                          void setProviderConfig(selectedId, { apiKeys: [...pool, key] })
                        }}
                        onRemoveApiKey={(index) => {
                          const pool = selectedSettings?.apiKeys ?? []
                          void setProviderConfig(selectedId, {
                            apiKeys: pool.filter((_, i) => i !== index),
                          })
                        }}
                        onReorderApiKeys={(from, to) => {
                          const pool = [...(selectedSettings?.apiKeys ?? [])]
                          const [moved] = pool.splice(from, 1)
                          if (moved === undefined) return
                          pool.splice(to, 0, moved)
                          void setProviderConfig(selectedId, { apiKeys: pool })
                        }}
                        onToggleRotation={(enabled) =>
                          void setProviderConfig(selectedId, { apiKeyRotationEnabled: enabled })
                        }
                        onRotationStrategyChange={(strategy) =>
                          void setProviderConfig(selectedId, { apiKeyRotationStrategy: strategy })
                        }
                      />
                      {/* Self-gates on the catalog's `supportsOAuth` and renders
                        null otherwise, so mounting it for every built-in is
                        safe and picks up any future OAuth provider for free.
                        Until now nothing rendered it, which left
                        `oauthConnected` / `oauthExpiresAt` unreachable from the
                        UI even though both are persisted on the settings row. */}
                      <OAuthLoginButton providerId={selectedId} />
                      {/* Provider-specific panels. Both shipped with a catalog
                        entry and a full settings schema but were never mounted,
                        so every field they expose was unreachable. */}
                      {selectedId === "openrouter" && (
                        <>
                          <OpenRouterSettings />
                          <OpenRouterKeyManagement />
                        </>
                      )}
                      {selectedId === "cliproxyapi" && <CLIProxyAPISettings />}
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      {t("unknownProviderType") || "Unknown provider type."}
                    </div>
                  )
                }
                // Local engines manage their own models/setup inside the config
                // dashboard, and have no per-token cost or cloud routing — so
                // these slots stay empty and the tabs simply don't render.
                modelsTab={
                  isLocalProvider ? undefined : isCustom ? (
                    <div className="text-sm text-muted-foreground">
                      {t("customProviderModelsManaged") ||
                        "Custom-provider models are managed inside the provider editor."}
                    </div>
                  ) : selectedBuiltIn ? (
                    <ProviderModelsTab
                      providerId={selectedId}
                      models={enrichedBuiltInModels}
                      enabledModels={selectedSettings?.enabledModels ?? []}
                      onEnabledModelsChange={(ids) =>
                        void setProviderConfig(selectedId, { enabledModels: ids })
                      }
                      onRefreshModels={handleRefreshModels}
                      isRefreshing={!!testingConnection[selectedId]}
                      onTestConnection={handleTestConnection}
                      isTesting={!!s.testingProviders[selectedId]}
                      metadataLoading={modelsDevLoading}
                    />
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      {t("noModelsAvailable") || "No models available."}
                    </div>
                  )
                }
                costTab={isLocalProvider ? undefined : <ProviderCostTab providerId={selectedId} />}
                advancedTab={
                  isLocalProvider ? undefined : (
                    <Tabs
                      value={activeTab}
                      onValueChange={(v) => setActiveTab(v as typeof activeTab)}
                    >
                      <TabsList>
                        <TabsTrigger value="parameters">
                          {t("tabs.parameters" as never) as string}
                        </TabsTrigger>
                        <TabsTrigger value="routing">
                          {t("tabs.routing" as never) as string}
                        </TabsTrigger>
                        <TabsTrigger value="health">
                          {t("tabs.health" as never) as string}
                        </TabsTrigger>
                      </TabsList>
                      <TabsContent value="parameters">
                        {selectedSettings ? (
                          <ProviderParametersTab
                            providerId={selectedId}
                            settings={selectedSettings}
                          />
                        ) : (
                          <div className="py-4 text-center text-xs text-muted-foreground">
                            {t("configureProviderForParameters") ||
                              "Configure this provider in the Config tab to enable parameters."}
                          </div>
                        )}
                      </TabsContent>
                      <TabsContent value="routing">
                        <RoutingTab />
                      </TabsContent>
                      <TabsContent value="health">
                        <HealthTab
                          providerId={selectedId}
                          onTestConnection={async () => {
                            const result = await s.testProvider(selectedId)
                            return {
                              success: !!result?.success,
                              latency: result?.latency_ms,
                              error: result?.success ? undefined : result?.message,
                              outcome: result?.outcome,
                            }
                          }}
                          isTesting={!!s.testingProviders[selectedId]}
                        />
                      </TabsContent>
                    </Tabs>
                  )
                }
              />
            )}
          </PanelTransition>
        </div>
      </div>

      {/* ── Dialogs ────────────────────────────────────────────────────── */}
      {showQuickAdd && (
        <QuickAddProviderDialog
          open={showQuickAdd}
          onOpenChange={setShowQuickAdd}
          onAddCustom={() => {
            setEditingCustomId(null)
            setCustomDialogOpen(true)
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
      {compareOpen && (
        <ProviderCompareDialog
          open={compareOpen}
          onOpenChange={setCompareOpen}
          availableProviders={sidebarProviders
            .filter((provider) => PROVIDERS[provider.id] !== undefined)
            .map((provider) => ({ id: provider.id, name: provider.name }))}
          initialSelectedProviderIds={(s.uiPreferences.comparisonProviderIds ?? []).filter(
            (providerId) => PROVIDERS[providerId] !== undefined
          )}
          onSelectedProviderIdsChange={(comparisonProviderIds) => {
            void setProviderUIPreferences({ comparisonProviderIds })
          }}
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
