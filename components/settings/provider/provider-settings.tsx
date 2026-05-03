"use client"

/**
 * ProviderSettings — root of the providers settings tab.
 *
 * Slimmer cognia-next replacement for Cognia's 643-line root. Uses the
 * same detail-panel slot interface (Config / Models / Cost / Advanced)
 * but composes the tabs without depending on the deferred reliability
 * infrastructure (provider manager, routing engine, batch verification).
 *
 * Layout:
 *   [sidebar list]   |   [detail panel — tabbed]
 *     - built-in     |     • Config (api key, base URL, default model, test)
 *     - custom       |     • Models (enable/disable list)
 *     - "+ Add"      |     • Cost   (usage stats from AppSettings.providerUsageStats)
 *                    |     • Advanced (Parameters tab; Routing/Health/Presets are placeholders)
 *
 * Custom providers open the AddProviderWizard / CustomProviderDialog
 * verbatim from Cognia.
 */

import dynamic from "next/dynamic"
import { useEffect, useMemo, useState } from "react"
import { Plus } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useProviderSettings } from "@/hooks/settings/use-provider-settings"
import { PROVIDERS } from "@/types/provider/provider"
import type { CustomProviderSettings } from "@/types/provider/provider"
import { ProviderDetailPanel } from "./provider-detail-panel"
import { ProviderConfigTab } from "./provider-config-tab"
import { ProviderModelsTab } from "./provider-models-tab"
import { ProviderCostTab } from "./provider-cost-tab"
import { ProviderParametersTab } from "./provider-parameters-tab"
import { RoutingTab } from "./routing-tab"
import { HealthTab } from "./health-tab"
import { PresetsTab } from "./presets-tab"
import { ProviderSidebar } from "./provider-sidebar"
import type { ProviderConnectionStatus } from "./provider-sidebar-item"

type SidebarProvider = {
  id: string
  name: string
  subtitle: string
  status: ProviderConnectionStatus
  isCustom: boolean
}
import { ProviderEmptyState } from "./provider-empty-state"
import { ProviderOnboardingBanner } from "./provider-onboarding-banner"
import { useSettingsStore } from "@/stores/settings"

const CustomProviderDialog = dynamic(
  () => import("./custom-provider-dialog").then((m) => m.CustomProviderDialog),
  { ssr: false }
)
const QuickAddProviderDialog = dynamic(
  () => import("./quick-add-provider-dialog").then((m) => m.QuickAddProviderDialog),
  { ssr: false }
)

function deriveStatus(
  apiKey: string | undefined,
  baseURL: string | undefined,
  testOk: boolean | undefined
): SidebarProvider["status"] {
  if (!apiKey && !baseURL) return "not-configured"
  if (testOk === false) return "error"
  if (testOk === true) return "connected"
  return "warning"
}

export function ProviderSettings() {
  const t = useTranslations("providers")
  const s = useProviderSettings()
  const setProviderConfig = useSettingsStore((store) => store.setProviderConfig)
  const setDefaultProvider = useSettingsStore((store) => store.setDefaultProvider)

  const [search, setSearch] = useState("")
  const [showQuickAdd, setShowQuickAdd] = useState(false)
  const [customDialogOpen, setCustomDialogOpen] = useState(false)
  const [editingCustomId, setEditingCustomId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<"providers" | "custom">("providers")

  // ---------------------------------------------------------------------------
  // Sidebar entries (built-in + custom)
  // ---------------------------------------------------------------------------
  const sidebarProviders = useMemo<SidebarProvider[]>(() => {
    const builtIn = s.filteredProviders
      .filter(([id, cfg]) => {
        const q = search.trim().toLowerCase()
        if (!q) return true
        return id.toLowerCase().includes(q) || cfg.name.toLowerCase().includes(q)
      })
      .map(([id, cfg]) => {
        const settings = s.providerSettings[id]
        const test = s.testResults[id]
        return {
          id,
          name: cfg.name,
          subtitle: settings?.defaultModel ?? cfg.defaultModel,
          status: deriveStatus(settings?.apiKey, settings?.baseURL, test?.success),
          isCustom: false,
        }
      })

    const custom: SidebarProvider[] = []
    for (const id of s.visibleCustomProviderIds) {
      const cp = s.customProviders[id]
      if (!cp) continue
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
        status: deriveStatus(cp.apiKey, cp.baseURL, testOk),
        isCustom: true,
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

  const selectedSettings = selectedId ? s.providerSettings[selectedId] : undefined
  const isEnabled = isCustom
    ? (selectedCustom?.enabled ?? false)
    : (selectedSettings?.enabled ?? false)

  return (
    <div className="space-y-4">
      <ProviderOnboardingBanner />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[320px_1fr]">
        {/* ── Sidebar ───────────────────────────────────────────────── */}
        <div className="flex min-h-[600px] flex-col overflow-hidden rounded-lg border">
          {sidebarProviders.length === 0 && search.trim() === "" ? (
            <div className="flex-1 p-4">
              <ProviderEmptyState
                onAddProvider={() => setShowQuickAdd(true)}
                onImportSettings={() => undefined}
              />
            </div>
          ) : (
            <ProviderSidebar
              providers={sidebarProviders}
              selectedId={selectedId}
              onSelect={s.setSelectedProviderId}
              onCompareClick={() => undefined}
              categoryFilter={"all"}
              onCategoryChange={() => undefined}
              searchQuery={search}
              onSearchChange={setSearch}
              addButton={
                <Button size="sm" variant="outline" onClick={() => setShowQuickAdd(true)}>
                  <Plus className="mr-1 h-4 w-4" />
                  {t("addProvider" as never) as string}
                </Button>
              }
            />
          )}
        </div>

        {/* ── Detail panel ──────────────────────────────────────────── */}
        <div className="min-h-[600px] rounded-lg border">
          {selectedId === null ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t("emptyStateDescription" as never) as string}
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
                selectedBuiltIn ? (
                  <ProviderConfigTab
                    providerId={selectedId}
                    settings={
                      selectedSettings ?? {
                        providerId: selectedId,
                        enabled: false,
                        defaultModel: selectedBuiltIn.defaultModel,
                      }
                    }
                    providerModels={selectedBuiltIn.models.map((m) => ({
                      id: m.id,
                      name: m.name,
                    }))}
                    providerDashboardUrl={selectedBuiltIn.dashboardUrl}
                    providerDocsUrl={selectedBuiltIn.docsUrl}
                    onApiKeyChange={(key) => void setProviderConfig(selectedId, { apiKey: key })}
                    onBaseURLChange={(url) => void setProviderConfig(selectedId, { baseURL: url })}
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
                  />
                ) : (
                  <div className="text-sm text-muted-foreground">
                    Edit this custom provider via the pencil icon in the sidebar.
                  </div>
                )
              }
              modelsTab={
                selectedBuiltIn ? (
                  <ProviderModelsTab
                    providerId={selectedId}
                    models={selectedBuiltIn.models.map((m) => ({
                      ...m,
                      capabilities: [
                        m.supportsTools ? "tools" : null,
                        m.supportsVision ? "vision" : null,
                        m.supportsStreaming ? "streaming" : null,
                        m.supportsReasoning ? "reasoning" : null,
                      ].filter((c): c is string => c !== null),
                    }))}
                    enabledModels={selectedSettings?.enabledModels ?? []}
                    onEnabledModelsChange={(ids) =>
                      void setProviderConfig(selectedId, { enabledModels: ids })
                    }
                    onRefreshModels={() => undefined}
                    isRefreshing={false}
                  />
                ) : (
                  <div className="text-sm text-muted-foreground">
                    Custom-provider models are managed inside the provider editor.
                  </div>
                )
              }
              costTab={<ProviderCostTab providerId={selectedId} />}
              advancedTab={
                <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as never)}>
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
                      <div className="text-xs text-muted-foreground">
                        Configure this provider in the Config tab to enable parameters.
                      </div>
                    )}
                  </TabsContent>
                  <TabsContent value="routing">
                    <RoutingTab />
                  </TabsContent>
                  <TabsContent value="health">
                    <HealthTab />
                  </TabsContent>
                  <TabsContent value="presets">
                    <PresetsTab />
                  </TabsContent>
                </Tabs>
              }
            />
          )}
        </div>
      </div>

      {/* ── Add provider dialogs ──────────────────────────────────── */}
      {showQuickAdd && (
        <QuickAddProviderDialog open={showQuickAdd} onOpenChange={setShowQuickAdd} />
      )}
      {customDialogOpen && (
        <CustomProviderDialog
          open={customDialogOpen}
          onOpenChange={setCustomDialogOpen}
          editingProviderId={editingCustomId}
        />
      )}
    </div>
  )
}

export default ProviderSettings
