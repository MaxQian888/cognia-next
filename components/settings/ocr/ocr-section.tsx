"use client"

/**
 * OCR settings — top-level shell rendered from `settings-shell.tsx` when the
 * `ocr` section is active.
 *
 * Mirrors the model-provider settings layout: a left sidebar with a pinned
 * Auto-Router pseudo-entry plus one row per registered OCR provider, and a
 * right detail panel with Config / Models / Advanced tabs (or the Auto-Router
 * defaults form when the pinned entry is selected). `SettingsMasterDetail` owns
 * the split: the sidebar tiers off the pane's own width (full → compact → icon
 * → drawer) rather than the viewport, which this pane never gets.
 *
 * This file is the orchestrator — it holds all in-session state and threads
 * callbacks down into `OcrSidebar`, `OcrDetailPanel`, and the three tab
 * components under `./tabs`.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { detectNativePlatform, type NativePlatform } from "@/lib/capacitor/_shared"
import type { ProbeOutcome } from "@/lib/ocr/probe"
import type { ExtractDeps } from "@/lib/ocr/index"
import type { OcrRuntimeStatus } from "@cognia/ocr/runtime-status"
import {
  DEFAULT_OCR_SETTINGS,
  type OcrProviderCategory,
  type OcrProviderShellSupport,
  type UserOcrSettings,
} from "@/types/ocr"
import { OcrDetailPanel } from "./ocr-detail-panel"
import {
  OCR_AUTO_ROUTER_ID,
  OCR_COMPARE_ID,
  OcrSidebar,
  type OcrCategoryFilter,
  type OcrSidebarProvider,
} from "./ocr-sidebar"
import type { OcrProviderStatus } from "./ocr-sidebar-item"
import { OcrAutoRouterPanel } from "./tabs/ocr-auto-router-panel"
import { OcrAdvancedTab } from "./tabs/ocr-advanced-tab"
import { OcrConfigTab } from "./tabs/ocr-config-tab"
import { BACKENDS_WITH_MANAGED_MODELS, OcrModelsTab } from "./tabs/ocr-models-tab"
import { OcrCapabilitiesTab } from "./tabs/ocr-capabilities-tab"
import { OcrTryItTab } from "./tabs/ocr-try-it-tab"
import { OcrCompareView } from "./ocr-compare-view"
import { OcrSetupWizard, hasNoCloudCredentials } from "./ocr-setup-wizard"
import { SettingsMasterDetail } from "@/components/settings/common/settings-master-detail"

// Re-export the model-manager API so external consumers (and the existing
// test suite at the time of the redesign) keep their import paths working.
export {
  LocalModelManager,
  BACKENDS_WITH_MANAGED_MODELS,
  buildTauriModelBridge,
} from "./tabs/ocr-models-tab"
export type {
  ModelStatus,
  ModelFileStatus,
  DownloadProgressEvent,
  OcrModelBridge,
} from "./tabs/ocr-models-tab"

/** Static descriptor of every shipped OCR provider, used by the settings UI. */
export interface OcrProviderDescriptor {
  id: string
  category: OcrProviderCategory
  credentialKeys: readonly string[]
  reusesMainProviderKey?: boolean
  shells: OcrProviderShellSupport
}

const SHELLS_ALL: OcrProviderShellSupport = { browser: true, tauri: true, capacitor: true }
const SHELLS_TAURI_ONLY: OcrProviderShellSupport = {
  browser: false,
  tauri: true,
  capacitor: false,
}
const SHELLS_TAURI_MOBILE: OcrProviderShellSupport = {
  browser: false,
  tauri: true,
  capacitor: true,
}
const SHELLS_ANDROID_ONLY: OcrProviderShellSupport = {
  browser: false,
  tauri: false,
  capacitor: true,
}

/**
 * Mirrors the registry shipped by `lib/ocr/runtime.ts`. The settings page
 * intentionally re-declares the metadata here (rather than calling into the
 * runtime) so it can render before `installOcrRuntime()` has populated the
 * shared registry and so unit tests can render without a runtime boot.
 */
export const OCR_PROVIDER_REGISTRY: ReadonlyArray<OcrProviderDescriptor> = [
  { id: "mistral-ocr", category: "document-cloud", credentialKeys: ["apiKey"], shells: SHELLS_ALL },
  {
    id: "google-vision",
    category: "document-cloud",
    credentialKeys: ["apiKey"],
    shells: SHELLS_ALL,
  },
  {
    id: "aws-textract",
    category: "document-cloud",
    credentialKeys: ["accessKeyId", "secretAccessKey", "sessionToken"],
    shells: SHELLS_ALL,
  },
  {
    id: "azure-document-intelligence",
    category: "document-cloud",
    credentialKeys: ["apiKey", "endpoint"],
    shells: SHELLS_ALL,
  },
  {
    id: "anthropic-vision",
    category: "llm-vision",
    credentialKeys: [],
    reusesMainProviderKey: true,
    shells: SHELLS_ALL,
  },
  {
    id: "openai-vision",
    category: "llm-vision",
    credentialKeys: [],
    reusesMainProviderKey: true,
    shells: SHELLS_ALL,
  },
  {
    id: "gemini-vision",
    category: "llm-vision",
    credentialKeys: [],
    reusesMainProviderKey: true,
    shells: SHELLS_ALL,
  },
  {
    id: "mathpix",
    category: "specialist",
    credentialKeys: ["appId", "appKey"],
    shells: SHELLS_ALL,
  },
  { id: "ocr-space", category: "specialist", credentialKeys: ["apiKey"], shells: SHELLS_ALL },
  {
    id: "abbyy-cloud",
    category: "specialist",
    credentialKeys: ["applicationId", "password"],
    shells: SHELLS_ALL,
  },
  { id: "nanonets", category: "specialist", credentialKeys: ["apiKey"], shells: SHELLS_ALL },
  {
    id: "lark-basic",
    category: "lark",
    credentialKeys: ["appId", "appSecret"],
    shells: SHELLS_ALL,
  },
  { id: "tesseract-wasm", category: "local", credentialKeys: [], shells: SHELLS_ALL },
  { id: "tesseract-native", category: "local", credentialKeys: [], shells: SHELLS_TAURI_ONLY },
  { id: "windows-media-ocr", category: "local", credentialKeys: [], shells: SHELLS_TAURI_ONLY },
  { id: "apple-vision", category: "local", credentialKeys: [], shells: SHELLS_TAURI_MOBILE },
  { id: "mlkit-android", category: "local", credentialKeys: [], shells: SHELLS_ANDROID_ONLY },
  { id: "ocrs", category: "local", credentialKeys: [], shells: SHELLS_TAURI_ONLY },
  { id: "paddle-ocr", category: "local", credentialKeys: [], shells: SHELLS_TAURI_ONLY },
  { id: "local-http", category: "local", credentialKeys: ["apiKey"], shells: SHELLS_ALL },
]

/**
 * Provider ids whose presence in the credential map signals the user has
 * already configured a cloud OCR backend. Used by the wizard's first-visit
 * auto-open guard so we don't pop the wizard when the user clearly already
 * knows what they're doing.
 */
const CLOUD_PROVIDER_IDS: ReadonlyArray<string> = OCR_PROVIDER_REGISTRY.filter(
  (p) => p.category === "document-cloud" || p.category === "specialist" || p.category === "lark"
).map((p) => p.id)

export interface OcrSectionProps {
  settings?: UserOcrSettings
  onChange?: (next: UserOcrSettings) => void
  onClearCache?: () => Promise<void> | void
  onClearProviderCache?: (providerId: string) => Promise<void> | void
  /**
   * Bridge to the Rust-side model manager. When omitted, `OcrModelsTab`
   * tries to build one from Tauri's `invoke` / `listen`; tests pass a stub
   * directly. Pass `null` to suppress local-model UI entirely (e.g. browser
   * shell where the Rust commands aren't reachable).
   */
  modelBridge?: import("./tabs/ocr-models-tab").OcrModelBridge | null
  /**
   * Wire a probe runner. When provided, every cloud / LLM-vision provider's
   * Config tab gains a "Probe connection" button. Results are kept in
   * session memory only.
   */
  onProbeProvider?: (providerId: string) => Promise<ProbeOutcome>
  /**
   * Initial credentials by provider id. The shell keeps these in local state
   * and never persists them — wiring a real keyring resolver is parent work.
   */
  credentials?: Record<string, Record<string, string>>
  onCredentialChange?: (providerId: string, key: string, value: string) => void
  /** Override platform detection (tests). Defaults to runtime detection. */
  platform?: NativePlatform
  /**
   * Factory yielding OCR ExtractDeps for the Try It / Compare flows. When
   * omitted, those tabs render but the Run button surfaces a "runtime not
   * ready" alert. Tests pass a stub.
   */
  ocrDepsFactory?: () => ExtractDeps | null
  /** Runtime truth loaded by the persisted shell; prevents placeholder providers showing Ready. */
  runtimeStatuses?: Record<string, OcrRuntimeStatus>
}

export function OcrSection(props: OcrSectionProps): React.ReactElement {
  const t = useTranslations()
  const [settings, setSettings] = useState<UserOcrSettings>(
    () => props.settings ?? DEFAULT_OCR_SETTINGS
  )
  const [selectedId, setSelectedId] = useState<string>(OCR_AUTO_ROUTER_ID)
  const [search, setSearch] = useState("")
  const [categoryFilter, setCategoryFilter] = useState<OcrCategoryFilter>("all")
  const [credentials, setCredentials] = useState<Record<string, Record<string, string>>>(
    () => props.credentials ?? {}
  )
  const [probeResults, setProbeResults] = useState<Record<string, ProbeOutcome>>({})
  const [probingId, setProbingId] = useState<string | null>(null)
  // First-visit auto-open: derive the initial value so we don't need a
  // useEffect+setState dance (react-hooks/set-state-in-effect). The wizard
  // surfaces once on mount when the user hasn't dismissed it AND no cloud
  // credential is present anywhere yet. Manual re-open stays available via
  // the Auto-Router panel header.
  const [wizardOpen, setWizardOpen] = useState(() => {
    const initialSettings = props.settings ?? DEFAULT_OCR_SETTINGS
    if (initialSettings.ocrWizardDismissed) return false
    const initialCredentials = props.credentials ?? {}
    return hasNoCloudCredentials(initialCredentials, CLOUD_PROVIDER_IDS)
  })

  const platform = props.platform ?? detectNativePlatform()

  const depsFactory = props.ocrDepsFactory ?? (() => null)

  const handleChange = useCallback(
    (next: UserOcrSettings) => {
      setSettings(next)
      props.onChange?.(next)
    },
    [props]
  )

  const handleCredentialChange = useCallback(
    (providerId: string, key: string, value: string) => {
      setCredentials((prev) => ({
        ...prev,
        [providerId]: { ...(prev[providerId] ?? {}), [key]: value },
      }))
      props.onCredentialChange?.(providerId, key, value)
    },
    [props]
  )

  // Filter providers by search + category. Shell-incompatible entries stay
  // visible (with an `unsupported` badge) so users can see the full menu.
  const sidebarProviders: OcrSidebarProvider[] = useMemo(() => {
    const q = search.trim().toLowerCase()
    return OCR_PROVIDER_REGISTRY.filter((p) => {
      if (categoryFilter !== "all" && p.category !== categoryFilter) return false
      if (!q) return true
      const label = (t(`ocr.providers.${p.id}.label`) ?? p.id).toLowerCase()
      return p.id.toLowerCase().includes(q) || label.includes(q)
    }).map((p) =>
      buildSidebarRow(p, settings, credentials, probeResults, platform, props.runtimeStatuses, t)
    )
  }, [
    search,
    categoryFilter,
    settings,
    credentials,
    probeResults,
    platform,
    props.runtimeStatuses,
    t,
  ])

  const stats = useMemo(() => computeSidebarStats(OCR_PROVIDER_REGISTRY, settings), [settings])

  const autoRouterSubtitle = useMemo(() => {
    if (settings.defaultProviderId === "auto") {
      const fallback = settings.cloudFallbackProviderId ?? "auto"
      return t("ocr.autoRouter.subtitleAuto", {
        fallback: tryProviderLabel(t, fallback),
      })
    }
    return t("ocr.autoRouter.subtitleFixed", {
      provider: tryProviderLabel(t, settings.defaultProviderId),
    })
  }, [settings.defaultProviderId, settings.cloudFallbackProviderId, t])

  const selectedProvider = useMemo(
    () => OCR_PROVIDER_REGISTRY.find((p) => p.id === selectedId) ?? null,
    [selectedId]
  )

  const handleProbe = useCallback(async () => {
    if (!props.onProbeProvider || !selectedProvider) return
    setProbingId(selectedProvider.id)
    try {
      const outcome = await props.onProbeProvider(selectedProvider.id)
      setProbeResults((prev) => ({ ...prev, [selectedProvider.id]: outcome }))
    } finally {
      setProbingId(null)
    }
  }, [props, selectedProvider])

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id)
  }, [])

  const sidebarNode = (
    <OcrSidebar
      providers={sidebarProviders}
      autoRouterSubtitle={autoRouterSubtitle}
      selectedId={selectedId}
      onSelect={handleSelect}
      searchQuery={search}
      onSearchChange={setSearch}
      categoryFilter={categoryFilter}
      onCategoryChange={setCategoryFilter}
      onClearCache={() => void props.onClearCache?.()}
      stats={stats}
    />
  )

  const autoRouterOptions = useMemo(
    () =>
      OCR_PROVIDER_REGISTRY.map((p) => ({
        id: p.id,
        label: t(`ocr.providers.${p.id}.label`),
        isCloudOrVision: p.category === "document-cloud" || p.category === "llm-vision",
      })),
    [t]
  )

  const detailNode = (() => {
    if (selectedId === OCR_COMPARE_ID) {
      return (
        <OcrCompareView
          providers={autoRouterOptions}
          onBack={() => setSelectedId(OCR_AUTO_ROUTER_ID)}
          depsFactory={depsFactory}
        />
      )
    }
    if (selectedId === OCR_AUTO_ROUTER_ID) {
      return (
        <OcrAutoRouterPanel
          settings={settings}
          onChange={handleChange}
          providers={autoRouterOptions}
          onClearCache={() => void props.onClearCache?.()}
          onOpenWizard={() => setWizardOpen(true)}
        />
      )
    }
    if (!selectedProvider) {
      return (
        <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
          {/* i18n-exempt: pre-existing unreachable fallback; selected ids come from the registry */}
          Unknown OCR provider.
        </div>
      )
    }
    const isEnabled = settings.providerEnabled[selectedProvider.id] !== false
    const status = deriveStatus(
      selectedProvider,
      credentials,
      probeResults[selectedProvider.id],
      platform,
      props.runtimeStatuses?.[selectedProvider.id]
    )
    return (
      <OcrDetailPanel
        provider={{
          id: selectedProvider.id,
          name: t(`ocr.providers.${selectedProvider.id}.label`),
          category: selectedProvider.category,
        }}
        status={status}
        isEnabled={isEnabled}
        onToggleEnabled={(next) =>
          handleChange({
            ...settings,
            providerEnabled: {
              ...settings.providerEnabled,
              [selectedProvider.id]: next,
            },
          })
        }
        configTab={
          <div className="space-y-3">
            {props.runtimeStatuses?.[selectedProvider.id]?.reason && (
              <p
                className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
                role="status"
              >
                {t(`ocr.runtime.reasons.${props.runtimeStatuses[selectedProvider.id]!.reason}`)}
              </p>
            )}
            <OcrConfigTab
              providerId={selectedProvider.id}
              credentialKeys={selectedProvider.credentialKeys}
              reusesMainProviderKey={selectedProvider.reusesMainProviderKey}
              shells={selectedProvider.shells}
              credentials={credentials[selectedProvider.id] ?? {}}
              onCredentialChange={(key, value) =>
                handleCredentialChange(selectedProvider.id, key, value)
              }
              description={t(`ocr.providers.${selectedProvider.id}.description`)}
              onProbe={props.onProbeProvider ? handleProbe : undefined}
              probeOutcome={probeResults[selectedProvider.id]}
              isProbing={probingId === selectedProvider.id}
            />
          </div>
        }
        modelsTab={
          BACKENDS_WITH_MANAGED_MODELS.has(selectedProvider.id) ? (
            <OcrModelsTab
              providerId={selectedProvider.id}
              bridge={props.modelBridge}
              modelVariant={
                settings.providerConfig[selectedProvider.id]?.model === "v6-tiny"
                  ? "v6-tiny"
                  : "v6-small"
              }
            />
          ) : (
            <OcrModelsTab providerId={selectedProvider.id} bridge={null} />
          )
        }
        advancedTab={
          <OcrAdvancedTab
            providerId={selectedProvider.id}
            config={settings.providerConfig[selectedProvider.id] ?? {}}
            onConfigChange={(next) =>
              handleChange({
                ...settings,
                providerConfig: { ...settings.providerConfig, [selectedProvider.id]: next },
              })
            }
            onClearProviderCache={() => void props.onClearProviderCache?.(selectedProvider.id)}
          />
        }
        capabilitiesTab={
          <OcrCapabilitiesTab
            providerId={selectedProvider.id}
            onCompareClick={() => setSelectedId(OCR_COMPARE_ID)}
          />
        }
        tryItTab={<OcrTryItTab providerId={selectedProvider.id} depsFactory={depsFactory} />}
      />
    )
  })()

  return (
    <div className="flex h-full min-h-0 flex-col gap-4" data-testid="ocr-section">
      <SettingsMasterDetail
        nav={() => sidebarNode}
        navTitle={t("ocr.providers.title")}
        mobileTriggerLabel={t("ocr.sidebar.mobileTrigger")}
        activeKey={selectedId}
        activeLabel={
          selectedId === OCR_AUTO_ROUTER_ID
            ? t("ocr.autoRouter.label")
            : selectedId === OCR_COMPARE_ID
              ? t("ocr.compare.sidebarLabel")
              : t(`ocr.providers.${selectedId}.label`)
        }
        navWidth={360}
        triggerTestId="ocr-mobile-sheet-trigger"
      >
        {/* Detail panel */}
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border">{detailNode}</div>
      </SettingsMasterDetail>

      <OcrSetupWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        settings={settings}
        onApply={handleChange}
        onDismiss={() => handleChange({ ...settings, ocrWizardDismissed: true })}
      />
    </div>
  )
}

/* ─────────────────────────── helpers ─────────────────────────── */

function buildSidebarRow(
  provider: OcrProviderDescriptor,
  settings: UserOcrSettings,
  credentials: Record<string, Record<string, string>>,
  probeResults: Record<string, ProbeOutcome>,
  platform: NativePlatform,
  runtimeStatuses: Record<string, OcrRuntimeStatus> | undefined,
  t: ReturnType<typeof useTranslations>
): OcrSidebarProvider {
  const status = deriveStatus(
    provider,
    credentials,
    probeResults[provider.id],
    platform,
    runtimeStatuses?.[provider.id]
  )
  const disabled = settings.providerEnabled[provider.id] === false
  return {
    id: provider.id,
    name: t(`ocr.providers.${provider.id}.label`),
    subtitle: t(`ocr.categories.${provider.category}`),
    status,
    category: provider.category,
    disabled,
  }
}

function deriveStatus(
  provider: OcrProviderDescriptor,
  credentials: Record<string, Record<string, string>>,
  lastProbe: ProbeOutcome | undefined,
  platform: NativePlatform,
  runtimeStatus?: OcrRuntimeStatus
): OcrProviderStatus {
  if (!shellAllowsPlatform(provider.shells, platform)) return "unsupported"
  if (lastProbe) return lastProbe.ok ? "connected" : "error"
  if (runtimeStatus) {
    if (runtimeStatus.ready) return provider.category === "local" ? "ready" : "connected"
    if (runtimeStatus.reason === "model-corrupt") return "error"
    if (
      runtimeStatus.reason === "unsupported-shell" ||
      runtimeStatus.reason === "backend-not-bound"
    ) {
      return "unsupported"
    }
    return "not-configured"
  }
  if (provider.reusesMainProviderKey) {
    // We can't know without probing — surface "not configured" so the UI
    // nudges the user toward the AI Providers page.
    return "not-configured"
  }
  if (provider.credentialKeys.length === 0) return "ready"
  const filled = credentials[provider.id] ?? {}
  const allPresent = provider.credentialKeys.every((k) => {
    if (k === "sessionToken") return true // AWS optional token doesn't gate readiness
    return typeof filled[k] === "string" && filled[k]!.length > 0
  })
  return allPresent ? "connected" : "not-configured"
}

function shellAllowsPlatform(shells: OcrProviderShellSupport, platform: NativePlatform): boolean {
  switch (platform) {
    case "tauri":
      return shells.tauri
    case "mobile":
      return shells.capacitor
    case "web":
      return shells.browser
    case "headless":
      return false
  }
}

function computeSidebarStats(
  registry: ReadonlyArray<OcrProviderDescriptor>,
  settings: UserOcrSettings
) {
  let enabled = 0
  let local = 0
  let cloud = 0
  for (const p of registry) {
    if (settings.providerEnabled[p.id] !== false) enabled += 1
    if (p.category === "local") local += 1
    if (p.category === "document-cloud" || p.category === "llm-vision") cloud += 1
  }
  return { enabled, local, cloud }
}

function tryProviderLabel(t: ReturnType<typeof useTranslations>, id: string): string {
  if (id === "auto") return id
  return t(`ocr.providers.${id}.label`)
}
