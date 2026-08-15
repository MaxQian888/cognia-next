"use client"

import dynamic from "next/dynamic"
import { useEffect, useMemo, useState, useCallback, useRef } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { createPortal } from "react-dom"
import {
  Plus,
  Menu,
  Settings,
  Key,
  Globe,
  PlugZap,
  Loader2,
  Route,
  RotateCcw,
  SlidersHorizontal,
  Eye,
  EyeOff,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
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
import { ProviderSection, ProviderSectionStack } from "./provider-section"
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
import type { LocalProviderName, LocalModelInfo } from "@cognia/provider-types/local-provider"
import type { ProviderDiagnosticSample } from "@cognia/provider-types"
import { validateBedrockConnectionSettings } from "@cognia/provider-types"
import { PanelTransition } from "@/components/settings/common/panel-transition"
import { ProviderDetailPanel } from "./provider-detail-panel"
import { ProviderConfigTab, type TestResult } from "./provider-config-tab"
import { ProviderModelsTab } from "./provider-models-tab"
import { ProviderCostTab } from "./provider-cost-tab"
import { ProviderParametersTab } from "./provider-parameters-tab"
import { RoutingTab } from "./routing-tab"
import { ProviderDiagnosticsTab } from "./provider-diagnostics-tab"
import {
  queryLatestProviderDiagnosticSamples,
  queryLatestProviderModelDiagnosticSamples,
} from "@/lib/provider-diagnostics/store"
import { getLastUsedByProvider } from "@/lib/db/provider-cost-daily"
import { useIsMobile } from "@/hooks/ui/use-mobile"
import { useEdgeResize } from "@/hooks/ui/use-edge-resize"
import { useDebouncedCallback } from "@/hooks/workflow/use-debounced-callback"
import { useDraftField } from "@/hooks/settings/use-draft-field"
import { cn } from "@/lib/utils"
import { ProviderSidebar } from "./provider-sidebar"
import { ProviderSetupChecklist } from "./provider-setup-checklist"
import { ProviderEmptyState } from "./provider-empty-state"
import { ProviderSkeleton } from "./provider-skeleton"
import { ProviderOnboardingBanner } from "./provider-onboarding-banner"
import { BatchTestProgress, TestResultsSummary } from "./batch-test-progress"
import { OAuthLoginButton } from "./oauth-login-button"
import { useSettingsStore } from "@/stores/settings"
import type { ProviderConnectionStatus } from "./provider-sidebar-item"
import type { ProviderDiagnosticBadgeStatus } from "./provider-sidebar-item"
import {
  deriveStatus,
  isLocalEngineConfigured,
  normalizeCategoryFilter,
  pickInitialProviderId,
  providerMatchesCategory,
  sortProviderRows,
  type ProviderSortBy,
} from "./provider-status-utils"
import {
  getBuiltInProviderReadiness,
  getCustomProviderReadiness,
  getVisibleEligibleBuiltInProviderIds,
  getVisibleEligibleCustomProviderIds,
  getVisibleRetryFailedBuiltInProviderIds,
  getVisibleRetryFailedCustomProviderIds,
} from "./provider-readiness"
import { nextActionKey } from "./provider-setup-checklist"

/** Rail width bounds (px). The default matches the previous fixed column. */
const RAIL_MIN_WIDTH = 240
const RAIL_MAX_WIDTH = 480
const RAIL_DEFAULT_WIDTH = 320
/** A diagnostic sample older than this reads as "stale" in the rail. */
const DIAGNOSTIC_STALE_MS = 2 * 60 * 60_000

type SidebarProvider = {
  id: string
  name: string
  subtitle: string
  status: ProviderConnectionStatus
  isCustom: boolean
  modelCount?: number
  diagnosticStatus?: ProviderDiagnosticBadgeStatus
  lastUsedAt?: number
}

function diagnosticBadge(
  sample: { status: string; startedAt: number; completedAt?: number } | undefined,
  now: number
): ProviderDiagnosticBadgeStatus | undefined {
  if (!sample) return undefined
  if (now - (sample.completedAt ?? sample.startedAt) > DIAGNOSTIC_STALE_MS) return "stale"
  return sample.status === "completed" ? "passed" : "failed"
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
const LocalProviderModelManager = dynamic(
  () => import("./local-provider-model-manager").then((m) => m.LocalProviderModelManager),
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
  testMessage,
  isTesting = false,
}: {
  cp: CustomProviderSettings
  onApiKeyChange: (key: string) => void
  onBaseURLChange: (url: string) => void
  onDefaultModelChange: (model: string) => void
  onEditClick: () => void
  onTestConnection: () => void
  testResult?: "success" | "error" | "limited" | null
  /** Human-readable detail of the last test (error text / model count). */
  testMessage?: string | null
  isTesting?: boolean
}) {
  const t = useTranslations("providers")
  const [showKey, setShowKey] = useState(false)
  // Draft-buffered like the built-in tab: no `customProviders` row rewrite per
  // keystroke, and no character drops while the async write is in flight.
  const apiKeyField = useDraftField(cp.apiKey ?? "", onApiKeyChange, { identity: cp.id })
  const baseURLField = useDraftField(cp.baseURL ?? "", onBaseURLChange, { identity: cp.id })

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
            value={apiKeyField.value}
            onChange={(e) => apiKeyField.onChange(e.target.value)}
            onBlur={apiKeyField.onBlur}
            onKeyDown={apiKeyField.onKeyDown}
            placeholder={t("configTab.apiKeyPlaceholder") || "Enter your API key"}
            className="pr-10"
            autoComplete="new-password"
            data-lpignore="true"
            data-form-type="other"
            data-testid="custom-provider-api-key-input"
          />
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2"
            onClick={() => setShowKey((prev) => !prev)}
            type="button"
            aria-label={showKey ? t("configTab.hideKey") : t("configTab.showKey")}
            title={showKey ? t("configTab.hideKey") : t("configTab.showKey")}
            data-testid="custom-provider-toggle-key"
          >
            {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
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
          value={baseURLField.value}
          onChange={(e) => baseURLField.onChange(e.target.value)}
          onBlur={baseURLField.onBlur}
          onKeyDown={baseURLField.onKeyDown}
          placeholder={cp.baseURL}
          data-testid="custom-provider-base-url-input"
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
              title={testMessage ?? undefined}
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
              {/* The hook has carried the provider's actual error text since
                  the test path was written; it was never rendered, so a failed
                  custom test only ever said "failed". */}
              {testMessage && testResult !== "success" ? (
                <span
                  className="ml-1 font-normal opacity-80"
                  data-testid="custom-provider-test-message"
                >
                  · {testMessage}
                </span>
              ) : null}
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

interface ProviderSettingsProps {
  headerActionsTarget?: HTMLElement | null
}

export function ProviderSettings({ headerActionsTarget }: ProviderSettingsProps = {}) {
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
  const isMobile = useIsMobile()

  // Provider-level diagnostic badges: latest sample per provider, read through
  // the `[providerId+startedAt]` index (one `last()` per provider) instead of
  // scanning the whole samples table on every change.
  const latestDiagnosticByProvider = useLiveQuery(
    () =>
      queryLatestProviderDiagnosticSamples().catch(
        () => new Map<string, ProviderDiagnosticSample>()
      ),
    []
  )
  const selectedProviderIdForDiagnostics = s.selectedProviderId
  // Model-level badges are only shown for the selected provider's Models tab,
  // so only that provider's rows are read.
  const latestDiagnosticByModel = useLiveQuery(
    (): Promise<Map<string, ProviderDiagnosticSample>> =>
      selectedProviderIdForDiagnostics
        ? queryLatestProviderModelDiagnosticSamples(selectedProviderIdForDiagnostics).catch(
            () => new Map<string, ProviderDiagnosticSample>()
          )
        : Promise.resolve(new Map<string, ProviderDiagnosticSample>()),
    [selectedProviderIdForDiagnostics]
  )
  // "Stale" is a function of wall-clock time. Re-evaluate only when a fresh
  // badge could actually cross the 2h line — at that exact moment — rather
  // than ticking every minute for the life of the page.
  const [diagnosticNow, setDiagnosticNow] = useState(() => Date.now())
  useEffect(() => {
    if (!latestDiagnosticByProvider) return
    let nextFlip = Number.POSITIVE_INFINITY
    for (const sample of latestDiagnosticByProvider.values()) {
      const at = (sample.completedAt ?? sample.startedAt) + DIAGNOSTIC_STALE_MS
      if (at > diagnosticNow && at < nextFlip) nextFlip = at
    }
    if (!Number.isFinite(nextFlip)) return
    const timer = window.setTimeout(
      () => setDiagnosticNow(Date.now()),
      Math.max(1_000, nextFlip - diagnosticNow + 50)
    )
    return () => window.clearTimeout(timer)
  }, [latestDiagnosticByProvider, diagnosticNow])
  const providerDiagnosticBadges = useMemo(() => {
    const out = new Map<string, ProviderDiagnosticBadgeStatus>()
    for (const [providerId, sample] of latestDiagnosticByProvider ?? []) {
      const badge = diagnosticBadge(sample, diagnosticNow)
      if (badge) out.set(providerId, badge)
    }
    return out
  }, [diagnosticNow, latestDiagnosticByProvider])
  const modelDiagnosticBadges = useMemo(() => {
    const out: Record<string, ProviderDiagnosticBadgeStatus> = {}
    for (const [modelId, sample] of latestDiagnosticByModel ?? []) {
      const badge = diagnosticBadge(sample, diagnosticNow)
      if (badge && modelId) out[modelId] = badge
    }
    return out
  }, [diagnosticNow, latestDiagnosticByModel])

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
  // "Recently used" reads the durable cost rollup (one row per provider/model/
  // day) — only subscribed while that sort is active.
  const lastUsedByProvider = useLiveQuery(
    (): Promise<Record<string, number> | undefined> =>
      sortBy === "lastUsed"
        ? getLastUsedByProvider().catch((): Record<string, number> => ({}))
        : Promise.resolve(undefined),
    [sortBy]
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
  // Detail column mode: the provider detail panel, or the model comparison
  // pane. Comparison is a peer of the detail view (it spans providers), so it
  // takes the column over instead of stacking a dialog on top of it.
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
    const q = search.trim().toLowerCase()
    const builtIn = s.filteredProviders
      .filter(([id]) => {
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
        // Readiness re-derives the verification status from the persisted
        // fingerprint, so a key rotated after the last successful test reads
        // "stale" instead of the frozen persisted "verified".
        const verificationStatus = getBuiltInProviderReadiness(
          id,
          settings,
          null
        ).verificationStatus
        return {
          id,
          name: cfg.name,
          subtitle: settings?.defaultModel ?? cfg.defaultModel,
          status: deriveStatus(
            settings?.apiKey,
            settings?.baseURL,
            effectiveTest.ok,
            effectiveTest.outcome,
            (id === "bedrock" && !!settings?.bedrock
              ? validateBedrockConnectionSettings(settings.bedrock).valid
              : false) || isLocalEngineConfigured(id, settings),
            verificationStatus
          ),
          isCustom: false,
          modelCount: cfg.models.length,
          diagnosticStatus: providerDiagnosticBadges.get(id),
          lastUsedAt: lastUsedByProvider?.[id],
        }
      })

    const custom: SidebarProvider[] = []
    for (const id of s.visibleCustomProviderIds) {
      const cp = s.customProviders[id]
      if (!cp) continue
      if (categoryFilter !== "all" && categoryFilter !== "custom") continue
      if (q && !cp.customName.toLowerCase().includes(q) && !id.toLowerCase().includes(q)) {
        continue
      }
      const testOutcome = s.customTestResults[id]
      const testOk = testOutcome === "success" ? true : testOutcome === "error" ? false : undefined
      const effectiveTest = preferLiveHealth(liveProviderHealth[id], testOk, testOutcome)
      const verificationStatus = getCustomProviderReadiness(cp, undefined).verificationStatus
      custom.push({
        id,
        name: cp.customName,
        subtitle: cp.defaultModel ?? cp.baseURL,
        status: deriveStatus(
          cp.apiKey,
          cp.baseURL,
          effectiveTest.ok,
          effectiveTest.outcome,
          false,
          verificationStatus
        ),
        isCustom: true,
        modelCount: cp.customModels?.length ?? 0,
        diagnosticStatus: providerDiagnosticBadges.get(id),
        lastUsedAt: lastUsedByProvider?.[id],
      })
    }

    // Built-ins keep the catalog order for `name`; custom rows follow. Any
    // other sort interleaves both groups (a connected custom endpoint belongs
    // above an unconfigured built-in when sorting by status).
    return sortBy === "name"
      ? [...builtIn, ...custom]
      : sortProviderRows([...builtIn, ...custom], sortBy)
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
    providerDiagnosticBadges,
    lastUsedByProvider,
    sortBy,
  ])

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
  // "Retry failed" — the readiness helpers for this existed (and the summary
  // component knew the operation type) but nothing invoked them.
  const batchRetryBuiltInIds = useMemo(
    () =>
      getVisibleRetryFailedBuiltInProviderIds(
        s.filteredProviders.map(([providerId]) => providerId),
        s.providerSettings,
        s.testResults
      ),
    [s.filteredProviders, s.providerSettings, s.testResults]
  )
  const batchRetryCustomIds = useMemo(
    () =>
      getVisibleRetryFailedCustomProviderIds(
        s.visibleCustomProviderIds,
        s.customProviders,
        s.customTestResults
      ),
    [s.customProviders, s.customTestResults, s.visibleCustomProviderIds]
  )
  const batchRetryCount = batchRetryBuiltInIds.length + batchRetryCustomIds.length
  const [batchOperationType, setBatchOperationType] = useState<"verify-enabled" | "retry-failed">(
    "verify-enabled"
  )

  const { testProvider, testCustomProvider } = s
  const runBatch = useCallback(
    async (
      operationType: "verify-enabled" | "retry-failed",
      builtInIds: readonly string[],
      customIds: readonly string[]
    ) => {
      const total = builtInIds.length + customIds.length
      if (batchVerification.isRunning || total === 0) return
      batchCancelRequested.current = false
      setBatchOperationType(operationType)
      setBatchVerification({
        isRunning: true,
        cancelRequested: false,
        total,
        completed: 0,
        success: 0,
        failed: 0,
        canceled: false,
      })

      const jobs = [
        ...builtInIds.map((providerId) => ({
          providerId,
          run: () => testProvider(providerId),
        })),
        ...customIds.map((providerId) => ({
          providerId,
          run: () => testCustomProvider(providerId),
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
    },
    [batchVerification.isRunning, testCustomProvider, testProvider]
  )
  const runBatchVerification = useCallback(
    () => runBatch("verify-enabled", batchEligibleBuiltInIds, batchEligibleCustomIds),
    [batchEligibleBuiltInIds, batchEligibleCustomIds, runBatch]
  )
  const runBatchRetryFailed = useCallback(
    () => runBatch("retry-failed", batchRetryBuiltInIds, batchRetryCustomIds),
    [batchRetryBuiltInIds, batchRetryCustomIds, runBatch]
  )

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

  const persistLocalProviderModels = useCallback(
    async (models: LocalModelInfo[]) => {
      if (!selectedId || !isLocalProvider) return
      const discoveredModels = models.map((model) => ({
        id: model.id,
        name: model.id,
        provider: model.owned_by,
        contextLength: model.context_length,
      }))
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
        setCompareOpen(false)
        setMobileSheetOpen(false)
      }}
      onCompareClick={() => {
        setCompareOpen(true)
        setMobileSheetOpen(false)
      }}
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

  const verifyEnabledButton = (
    <div className="flex items-center gap-1.5">
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
      {/* Only offered once something has actually failed — an always-visible
          disabled button would just be noise next to Verify. */}
      {batchRetryCount > 0 && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          data-testid="retry-failed-providers"
          disabled={batchVerification.isRunning}
          onClick={() => void runBatchRetryFailed()}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t("batch.retryFailed")} ({batchRetryCount})
        </Button>
      )}
    </div>
  )
  // The progress strip and its summary only take layout space while a batch
  // is running or has produced a result — otherwise the empty wrapper left a
  // phantom gap under the header.
  const showBatchStrip = batchVerification.isRunning || batchVerification.total > 0

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
              operationType={batchOperationType}
              completed={batchVerification.completed}
              expectedTotal={batchVerification.total}
              canceled={batchVerification.canceled}
            />
          )}
        </div>
      )}

      {/* One rail instance. It used to be rendered twice — a CSS-hidden desktop
          column AND the mobile sheet — so both stayed mounted on every
          viewport (duplicate `provider-*` ids, two import/export toolbars).
          `useIsMobile` picks the host; the column width is user-resizable and
          persisted (`ProviderUIPreferences.sidebarWidth`). */}
      <div
        className="grid min-h-0 flex-1 grid-cols-1 gap-4"
        style={isMobile ? undefined : { gridTemplateColumns: `${railWidth}px minmax(0, 1fr)` }}
        data-testid="provider-layout"
      >
        {isMobile ? (
          /* ── Mobile top bar ─────────────────────────────────────────── */
          <div className="flex items-center gap-2">
            <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
              <SheetTrigger asChild>
                <Button variant="outline" size="sm" className="shrink-0 gap-1.5">
                  <Menu className="h-4 w-4" />
                  {t("mobile.openProviders")}
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-[300px] p-0">
                <SheetHeader className="px-3 pt-3">
                  <SheetTitle className="text-sm">{t("title")}</SheetTitle>
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
        ) : (
          /* ── Desktop rail + drag handle ─────────────────────────────── */
          <div className="relative flex min-h-0 flex-col overflow-hidden rounded-lg border">
            {sidebar}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t("sidebar.resizeHandle")}
              aria-valuemin={RAIL_MIN_WIDTH}
              aria-valuemax={RAIL_MAX_WIDTH}
              aria-valuenow={Math.round(railWidth)}
              tabIndex={0}
              data-testid="provider-rail-resize-handle"
              className={cn(
                "group absolute -right-1 bottom-0 top-0 z-10 flex w-2.5 cursor-col-resize items-center justify-center focus-visible:outline-none",
                railResize.dragging && "select-none"
              )}
              onPointerDown={railResize.onPointerDown}
              onPointerMove={railResize.onPointerMove}
              onPointerUp={railResize.onPointerUp}
              onKeyDown={railResize.onKeyDown}
              onDoubleClick={railResize.onDoubleClick}
            >
              <span
                aria-hidden
                className={cn(
                  "h-full w-0.5 bg-transparent transition-colors group-hover:bg-primary/50 group-focus-visible:bg-primary",
                  railResize.dragging && "bg-primary"
                )}
              />
            </div>
          </div>
        )}

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
            activeKey={compareOpen ? "__compare__" : (selectedId ?? "__empty__")}
            className="flex min-h-0 flex-1 flex-col"
          >
            {compareOpen ? (
              <ProviderComparisonView
                onBack={() => setCompareOpen(false)}
                initialSelectedModelKeys={s.uiPreferences.comparisonModelKeys}
                onSelectedModelKeysChange={(comparisonModelKeys) => {
                  void setProviderUIPreferences({ comparisonModelKeys })
                }}
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
              <ProviderDetailPanel
                // Explicit key: `PanelTransition` only remounts when motion is
                // enabled, so under reduced motion the active tab / revealed
                // key state leaked from one provider to the next.
                key={selectedId}
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
                enableBlockedReason={enableBlockedReason}
                isCustom={isCustom}
                isDefault={selectedId === defaultProvider}
                onSetDefault={
                  canSetDefault ? () => void s.setDefaultProvider(selectedId) : undefined
                }
                setDefaultBlockedReason={setDefaultBlockedReason}
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
                    <div className="space-y-6">
                      {selectedReadiness && (
                        <ProviderSetupChecklist
                          checklist={selectedReadiness.setupChecklist}
                          isLocalEngine
                        />
                      )}
                      <LocalProviderSettings providerId={selectedId as LocalProviderName} />
                    </div>
                  ) : isCustom && selectedCustom ? (
                    <div className="space-y-6">
                      {selectedReadiness && (
                        <ProviderSetupChecklist
                          checklist={selectedReadiness.setupChecklist}
                          onVerify={() => void s.testCustomProvider(selectedId)}
                          isVerifying={!!s.testingCustomProviders[selectedId]}
                        />
                      )}
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
                        testMessage={s.customTestMessages[selectedId] ?? null}
                        isTesting={!!s.testingCustomProviders[selectedId]}
                      />
                    </div>
                  ) : selectedBuiltIn ? (
                    <div className="space-y-6">
                      {selectedReadiness && (
                        <ProviderSetupChecklist
                          checklist={selectedReadiness.setupChecklist}
                          onVerify={handleTestConnection}
                          isVerifying={!!s.testingProviders[selectedId]}
                        />
                      )}
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
                        onApiFlavorChange={(apiFlavor) =>
                          void setProviderConfig(selectedId, { apiFlavor })
                        }
                        onCustomHeadersChange={(customHeaders) =>
                          void setProviderConfig(selectedId, { customHeaders })
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
                        testResult={configTestResult}
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
                modelsTab={
                  isLocalProvider ? (
                    <LocalProviderModelManager
                      providerId={selectedId as LocalProviderName}
                      baseUrl={selectedSettings?.baseURL || selectedBuiltIn?.defaultBaseURL}
                      apiKey={selectedSettings?.apiKey}
                      customHeaders={selectedSettings?.customHeaders}
                      selectedModel={selectedSettings?.defaultModel}
                      onModelSelect={(modelId) =>
                        void setProviderConfig(selectedId, { defaultModel: modelId })
                      }
                      onModelsChange={(models) => void persistLocalProviderModels(models)}
                    />
                  ) : isCustom ? (
                    // The Models slot is fill-height (it owns its own scroller),
                    // so these text fallbacks bring their own padding.
                    <div className="p-4 text-sm text-muted-foreground">
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
                      diagnosticStatusByModel={modelDiagnosticBadges}
                    />
                  ) : (
                    <div className="p-4 text-sm text-muted-foreground">
                      {t("noModelsAvailable") || "No models available."}
                    </div>
                  )
                }
                costTab={isLocalProvider ? undefined : <ProviderCostTab providerId={selectedId} />}
                diagnosticsTab={
                  <ProviderDiagnosticsTab
                    providerId={selectedId}
                    providerName={selectedName ?? selectedId}
                    modelIds={
                      isCustom
                        ? (selectedCustom?.customModels ?? [])
                        : enrichedBuiltInModels.map((model) => model.id)
                    }
                    defaultModel={selectedSettings?.defaultModel ?? selectedCustom?.defaultModel}
                  />
                }
                advancedTab={
                  isLocalProvider ? undefined : (
                    /* Flat sections, not a nested tab strip. Tabs inside a tab
                       made "Advanced" a second navigation level whose state was
                       invisible from the outside — a user who left the panel on
                       Routing came back to it with no indication why Parameters
                       had disappeared. Both are now on one page, each foldable. */
                    <ProviderSectionStack>
                      <ProviderSection
                        collapsible
                        icon={SlidersHorizontal}
                        title={t("tabs.parameters" as never) as string}
                      >
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
                      </ProviderSection>
                      <ProviderSection
                        collapsible
                        defaultOpen={false}
                        icon={Route}
                        title={t("tabs.routing" as never) as string}
                      >
                        <RoutingTab />
                      </ProviderSection>
                    </ProviderSectionStack>
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
          onAdded={(providerId, name) => {
            // Reveal what was just added: clear filters that could hide the
            // new custom row, select it, and say so — the dialog used to just
            // close, leaving the row at the bottom of a possibly filtered list.
            setSearch("")
            setCategoryFilter("all")
            setStatusFilter("all")
            setCompareOpen(false)
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
