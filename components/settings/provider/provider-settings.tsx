"use client"

import dynamic from "next/dynamic"
import { useEffect, useMemo, useState, useCallback } from "react"
import { Plus, Menu, Settings, Key, Globe } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { useProviderSettings } from "@/hooks/settings/use-provider-settings"
import { useModelsDevCatalog } from "@/hooks/settings/use-models-dev-catalog"
import { useOpenRouterCatalog } from "@/hooks/settings/use-openrouter-catalog"
import { buildBuiltInProviderModelDiscoverySnapshot } from "@cognia/provider-core/providers/model-discovery"
import { PROVIDERS } from "@cognia/provider-types/provider"
import type { CustomProviderSettings } from "@cognia/provider-types/provider"
import { ProviderDetailPanel } from "./provider-detail-panel"
import { ProviderConfigTab } from "./provider-config-tab"
import { ProviderModelsTab } from "./provider-models-tab"
import { ProviderCostTab } from "./provider-cost-tab"
import { ProviderParametersTab } from "./provider-parameters-tab"
import { RoutingTab } from "./routing-tab"
import { HealthTab } from "./health-tab"
import { PresetsTab } from "./presets-tab"
import { ProviderSidebar } from "./provider-sidebar"
import { ProviderEmptyState } from "./provider-empty-state"
import { ProviderOnboardingBanner } from "./provider-onboarding-banner"
import { ProviderCompareDialog } from "./provider-compare-dialog"
import { useSettingsStore } from "@/stores/settings"
import type { ProviderConnectionStatus } from "./provider-sidebar-item"

type SidebarProvider = {
  id: string
  name: string
  subtitle: string
  status: ProviderConnectionStatus
  isCustom: boolean
  modelCount?: number
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

export function deriveStatus(
  apiKey: string | undefined,
  baseURL: string | undefined,
  testOk: boolean | undefined,
  // "limited" means the connection was verified but with caveats (e.g.
  // couldn't be authoritatively confirmed in this runtime) — distinct from
  // a plain pass so the sidebar badge doesn't overclaim "Connected".
  outcome?: "verified" | "failed" | "limited" | "success" | "error" | null
): SidebarProvider["status"] {
  if (!apiKey && !baseURL) return "not-configured"
  if (outcome === "limited") return "limited"
  if (testOk === false) return "error"
  if (testOk === true) return "connected"
  return "warning"
}

const CATEGORY_MAP: Record<string, string[]> = {
  ai: ["flagship"],
  local: ["local"],
  voice: ["specialized"],
  vision: ["flagship", "specialized"],
}

function providerMatchesCategory(category: string, providerId: string): boolean {
  if (category === "all") return true
  if (category === "custom") return false
  const categories = CATEGORY_MAP[category]
  if (!categories) return true
  const cfg = PROVIDERS[providerId]
  if (!cfg) return false
  if (category === "vision") {
    return (
      cfg.category !== undefined &&
      categories.includes(cfg.category) &&
      cfg.models.some((m) => m.supportsVision)
    )
  }
  return cfg.category !== undefined && categories.includes(cfg.category)
}

/* ── Sidebar skeleton ───────────────────────────────────────────────────────── */

function _SidebarSkeleton() {
  return (
    <div className="space-y-1 p-1">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-lg px-3 py-2.5 animate-pulse">
          <Skeleton className="h-7 w-7 rounded-md" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-2.5 w-32" />
          </div>
          <Skeleton className="h-4 w-12 rounded-full" />
        </div>
      ))}
    </div>
  )
}

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
}: {
  cp: CustomProviderSettings
  onApiKeyChange: (key: string) => void
  onBaseURLChange: (url: string) => void
  onDefaultModelChange: (model: string) => void
  onEditClick: () => void
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

      {/* Protocol badge + edit button */}
      <div className="flex items-center justify-between">
        <Badge variant="secondary" className="text-[10px]">
          {cp.apiProtocol}
        </Badge>
        <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={onEditClick}>
          <Settings className="h-3 w-3" />
          {t("editCustomProvider") || "Edit"}
        </Button>
      </div>
    </div>
  )
}

/* ── Main ───────────────────────────────────────────────────────────────────── */

export function ProviderSettings() {
  const t = useTranslations("providers")
  const s = useProviderSettings()
  const setProviderConfig = useSettingsStore((store) => store.setProviderConfig)
  const defaultProvider = useSettingsStore((store) => store.settings?.defaultProvider)

  const [search, setSearch] = useState("")
  const [categoryFilter, setCategoryFilter] = useState("all")
  const [showQuickAdd, setShowQuickAdd] = useState(false)
  const [customDialogOpen, setCustomDialogOpen] = useState(false)
  const [editingCustomId, setEditingCustomId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<"parameters" | "routing" | "health" | "presets">(
    "parameters"
  )
  const [compareOpen, setCompareOpen] = useState(false)
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false)
  const [testingConnection, setTestingConnection] = useState<Record<string, boolean>>({})

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
        return {
          id,
          name: cfg.name,
          subtitle: settings?.defaultModel ?? cfg.defaultModel,
          status: deriveStatus(settings?.apiKey, settings?.baseURL, test?.success, test?.outcome),
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
      custom.push({
        id,
        name: cp.customName,
        subtitle: cp.defaultModel ?? cp.baseURL,
        status: deriveStatus(cp.apiKey, cp.baseURL, testOk, testOutcome),
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
    search,
    categoryFilter,
  ])

  // Auto-select first provider
  useEffect(() => {
    if (!s.selectedProviderId && sidebarProviders.length > 0) {
      s.setSelectedProviderId(sidebarProviders[0].id)
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

  const selectedName = isCustom ? selectedCustom?.customName : selectedBuiltIn?.name

  // models.dev catalog (reactive) → enrich the built-in provider's model list
  // with models.dev-authoritative metadata (pricing/context/capabilities) plus
  // the extra display fields (variants/family/release date/adapter).
  const { row: modelsDevRow } = useModelsDevCatalog()
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
  const { row: openRouterCatalogRow } = useOpenRouterCatalog()
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

  // Model refresh handler
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
        s.setSelectedProviderId(id)
        setMobileSheetOpen(false)
      }}
      onCompareClick={() => setCompareOpen(true)}
      categoryFilter={categoryFilter}
      onCategoryChange={setCategoryFilter}
      searchQuery={search}
      onSearchChange={setSearch}
      addButton={
        <Button size="sm" variant="outline" onClick={() => setShowQuickAdd(true)}>
          <Plus className="mr-1 h-4 w-4" />
          <span className="hidden sm:inline">{t("addProvider" as never) as string}</span>
        </Button>
      }
    />
  )

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <ProviderOnboardingBanner
        onScrollToProvider={(id) => {
          // Clear any active search/category filter so the target row is
          // guaranteed to be mounted for the banner's own `getElementById`
          // scroll, and select it so the detail panel opens too.
          setSearch("")
          setCategoryFilter("all")
          s.setSelectedProviderId(id)
        }}
      />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-[320px_1fr]">
        {/* ── Desktop sidebar ──────────────────────────────────────────── */}
        <div className="hidden min-h-0 md:flex md:flex-col md:overflow-hidden md:rounded-lg md:border">
          {sidebarProviders.length === 0 && search.trim() === "" ? (
            <div className="flex-1 p-4">
              <ProviderEmptyState onAddProvider={() => setShowQuickAdd(true)} />
            </div>
          ) : (
            sidebar
          )}
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

        {/* ── Detail panel ─────────────────────────────────────────────── */}
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
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
          ) : isLocalProvider ? (
            <div className="flex-1 overflow-y-auto p-3">
              <LocalProviderSettings />
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
              isCustom={isCustom}
              isDefault={selectedId === defaultProvider}
              onSetDefault={() => void s.setDefaultProvider(selectedId)}
              connectionStatus={
                isCustom
                  ? deriveStatus(
                      selectedCustom?.apiKey,
                      selectedCustom?.baseURL,
                      s.customTestResults[selectedId] === "success"
                        ? true
                        : s.customTestResults[selectedId] === "error"
                          ? false
                          : undefined
                    )
                  : deriveStatus(
                      selectedSettings?.apiKey,
                      selectedSettings?.baseURL,
                      s.testResults[selectedId]?.success
                    )
              }
              onToggleEnabled={(next) => {
                if (isCustom && selectedCustom) {
                  void s.updateCustomProvider(selectedId, { enabled: next })
                } else {
                  void setProviderConfig(selectedId, { enabled: next })
                }
              }}
              onDelete={
                isCustom
                  ? () => {
                      void s.removeCustomProvider(selectedId)
                      s.setSelectedProviderId(null)
                    }
                  : undefined
              }
              configTab={
                isCustom && selectedCustom ? (
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
                  />
                ) : selectedBuiltIn ? (
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
                    onApiKeyChange={(key) => void setProviderConfig(selectedId, { apiKey: key })}
                    onBaseURLChange={(url) => void setProviderConfig(selectedId, { baseURL: url })}
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
                ) : (
                  <div className="text-sm text-muted-foreground">Unknown provider type.</div>
                )
              }
              modelsTab={
                isCustom ? (
                  <div className="text-sm text-muted-foreground">
                    Custom-provider models are managed inside the provider editor.
                  </div>
                ) : selectedBuiltIn ? (
                  <ProviderModelsTab
                    providerId={selectedId}
                    models={enrichedBuiltInModels}
                    enabledModels={selectedSettings?.enabledModels ?? []}
                    onEnabledModelsChange={(ids) =>
                      void setProviderConfig(selectedId, { enabledModels: ids })
                    }
                    onTestConnection={handleTestConnection}
                    isTesting={!!testingConnection[selectedId]}
                  />
                ) : (
                  <div className="text-sm text-muted-foreground">No models available.</div>
                )
              }
              costTab={<ProviderCostTab providerId={selectedId} />}
              advancedTab={
                <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
                  <TabsList>
                    <TabsTrigger value="parameters">
                      {t("tabs.parameters" as never) as string}
                    </TabsTrigger>
                    <TabsTrigger value="routing">
                      {t("tabs.routing" as never) as string}
                    </TabsTrigger>
                    <TabsTrigger value="health">{t("tabs.health" as never) as string}</TabsTrigger>
                    <TabsTrigger value="presets">
                      {t("tabs.presets" as never) as string}
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="parameters">
                    {selectedSettings ? (
                      <ProviderParametersTab providerId={selectedId} settings={selectedSettings} />
                    ) : (
                      <div className="py-4 text-center text-xs text-muted-foreground">
                        Configure this provider in the Config tab to enable parameters.
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
                  <TabsContent value="presets">
                    <PresetsTab providerId={selectedId} providerName={selectedName} />
                  </TabsContent>
                </Tabs>
              }
            />
          )}
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
      <ProviderCompareDialog
        open={compareOpen}
        onOpenChange={setCompareOpen}
        availableProviders={sidebarProviders.map((p) => ({ id: p.id, name: p.name }))}
      />
    </div>
  )
}

export default ProviderSettings
