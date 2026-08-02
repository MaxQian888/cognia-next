"use client"

import { useMemo, useState } from "react"
import { Clock3, TriangleAlert } from "lucide-react"
import { useTranslations } from "next-intl"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { downloadFile } from "@/lib/files/download"
import { useProviderDiagnosticsData } from "@/hooks/provider/use-provider-diagnostics-data"
import {
  buildDiagnosticMatrix,
  collectFilterOptions,
  filterDiagnosticSamples,
  selectDiagnosticTrend,
  type ProviderDiagnosticFilters,
  type ProviderDiagnosticScenario,
} from "@/lib/provider-diagnostics/analysis"
import {
  refreshProviderBalanceSources,
  resolveProviderBalanceSource,
  resolveSandboxBalanceSource,
  selectPrimaryBalanceSource,
  type ResolvedProviderBalanceSource,
} from "@/lib/provider-diagnostics/balance"
import {
  applyProviderEndpoint,
  compareProviderEndpointsFree,
  collectProviderEndpointCandidates,
  extractCcswitchProviderEndpoints,
  rollbackProviderEndpoint,
} from "@/lib/provider-diagnostics/endpoints"
import {
  cancelProviderDiagnosticJob,
  cancelProviderDiagnosticTarget,
  startProviderDiagnosticJob,
  type ResolvedProviderDiagnosticTarget,
} from "@/lib/provider-diagnostics/service"
import {
  cancelRemoteProviderDiagnosticJob,
  startRemoteProviderDiagnosticJob,
} from "@/lib/provider-diagnostics/remote-client"
import {
  clearProviderDiagnosticHistory,
  exportProviderDiagnosticHistory,
} from "@/lib/provider-diagnostics/store"
import { resolveProviderDiagnosticTargets } from "@/lib/provider-diagnostics/targets"
import {
  clearProviderBalanceToken,
  migrateProviderBalanceToken,
} from "@/lib/provider-diagnostics/sandbox"
import { useCcswitchProviders } from "@/lib/ccswitch/hooks"
import { isTauri } from "@/lib/tauri"
import { useSettingsStore } from "@/stores/settings"
import {
  DEFAULT_PROVIDER_DIAGNOSTICS_PREFERENCES,
  type ProviderDiagnosticCapability,
  type ProviderDiagnosticMode,
} from "@cognia/provider-types"
import { getProviderConfig } from "@cognia/provider-types/provider"

import { ProviderSectionStack } from "./provider-section"
import { BalanceSection, type BalanceScriptDraft } from "./diagnostics/balance-section"
import { EndpointDiffDialog } from "./diagnostics/endpoint-diff-dialog"
import { EndpointsSection } from "./diagnostics/endpoints-section"
import { HistorySection } from "./diagnostics/history-section"
import { MatrixSection } from "./diagnostics/matrix-section"
import { ProgressSection } from "./diagnostics/progress-section"
import { RunComposer } from "./diagnostics/run-composer"
import { RunConfirmDialog } from "./diagnostics/run-confirm-dialog"
import { SummarySection } from "./diagnostics/summary-section"

interface ProviderDiagnosticsTabProps {
  providerId: string
  providerName: string
  modelIds: string[]
  defaultModel?: string
}

/** Precise mode repeats each target four times to get a usable median. */
const PRECISE_REPEATS = 4

const DEFAULT_FILTERS: ProviderDiagnosticFilters = {
  status: "all",
  modelId: "all",
  capability: "all",
  credentialFingerprint: "all",
  endpoint: "all",
  range: "7d",
}

/**
 * Provider Diagnostics — orchestrator.
 *
 * Owns run configuration, the spend gate and every mutation; the seven visible
 * blocks are presentational components under `./diagnostics/`, the data reads
 * live in `useProviderDiagnosticsData`, and the ranking maths lives in
 * `lib/provider-diagnostics/analysis`. This file used to be all four at once,
 * at 1.6k lines.
 */
export function ProviderDiagnosticsTab({
  providerId,
  providerName,
  modelIds,
  defaultModel,
}: ProviderDiagnosticsTabProps) {
  const t = useTranslations("providers.diagnostics")
  const settings = useSettingsStore((state) => state.settings)
  const saveSettings = useSettingsStore((state) => state.save)
  const preferences = {
    ...DEFAULT_PROVIDER_DIAGNOSTICS_PREFERENCES,
    ...settings?.providerDiagnostics,
  }
  const providerSettings = settings?.providerSettings?.[providerId]
  const customProvider = settings?.customProviders?.find((provider) => provider.id === providerId)
  const catalog = getProviderConfig(providerId)
  const baseUrl =
    customProvider?.baseURL ?? providerSettings?.baseURL ?? catalog?.defaultBaseURL ?? ""
  const apiKey = customProvider?.apiKey ?? providerSettings?.apiKey
  const { data: ccswitchProviders = [] } = useCcswitchProviders(
    isTauri(),
    false,
    settings?.ccswitchSync?.manualDataDir
  )

  const {
    pairedClient,
    measuredSamples,
    latestSample,
    jobs,
    balances,
    legacyBalanceProjection,
    endpointChanges,
    remoteStatus,
    remoteHistory,
    stale,
    currentTime,
    refreshRemoteStatus,
  } = useProviderDiagnosticsData(providerId)

  /* ── Run configuration ─────────────────────────────────────────────────── */
  const [mode, setMode] = useState<ProviderDiagnosticMode>("quick")
  const [capability, setCapability] = useState<ProviderDiagnosticCapability>("probe")
  const [modelId, setModelId] = useState(defaultModel ?? modelIds[0] ?? "")
  const [credentialId, setCredentialId] = useState("primary")
  const [selectedEndpoint, setSelectedEndpoint] = useState(baseUrl)
  const [concurrency, setConcurrency] = useState(preferences.concurrency)
  const [timeoutMs, setTimeoutMs] = useState(preferences.textTimeoutMs)
  const [pendingTargets, setPendingTargets] = useState<ResolvedProviderDiagnosticTarget[]>([])
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [runError, setRunError] = useState<string | null>(null)

  /* ── Endpoint workspace ────────────────────────────────────────────────── */
  const [customEndpoint, setCustomEndpoint] = useState("")
  const [endpointError, setEndpointError] = useState<string | null>(null)
  const [pendingEndpoint, setPendingEndpoint] = useState<string | null>(null)
  const [endpointComparing, setEndpointComparing] = useState(false)
  const [endpointComparisons, setEndpointComparisons] = useState<
    Awaited<ReturnType<typeof compareProviderEndpointsFree>>
  >([])

  /* ── Result filters ────────────────────────────────────────────────────── */
  const [filters, setFilters] = useState<ProviderDiagnosticFilters>(DEFAULT_FILTERS)
  const [scenario, setScenario] = useState<ProviderDiagnosticScenario>("interactive")

  /* ── Derived views ─────────────────────────────────────────────────────── */
  const activeJob = activeJobId ? jobs.find((job) => job.id === activeJobId) : undefined
  // A job id with no row yet is a job that has just been started, not an absent
  // one — treating it as idle made the run button clickable a second time.
  const jobRunning = activeJob?.status === "running" || (activeJobId !== null && !activeJob)

  const visibleSamples = useMemo(
    () => filterDiagnosticSamples(measuredSamples, filters, currentTime),
    [measuredSamples, filters, currentTime]
  )
  const matrixRows = useMemo(
    () => buildDiagnosticMatrix(visibleSamples, scenario),
    [visibleSamples, scenario]
  )
  const filterOptions = useMemo(() => collectFilterOptions(measuredSamples), [measuredSamples])
  const trend = useMemo(() => selectDiagnosticTrend(visibleSamples), [visibleSamples])

  const repeats = mode === "precise" ? PRECISE_REPEATS : 1
  const requestCount = pendingTargets.length * repeats
  const estimatedCost = pendingTargets.reduce(
    (total, target) => total + (target.estimatedMaxCostUsd ?? 0) * repeats,
    0
  )
  const unknownCost = pendingTargets.some(
    (target) => target.billable && target.estimatedMaxCostUsd === undefined
  )
  const progress = activeJob
    ? Math.min(
        100,
        (activeJob.completedCount /
          Math.max(
            1,
            activeJob.targetCount * (activeJob.mode === "precise" ? PRECISE_REPEATS : 1)
          )) *
          100
      )
    : 0

  const directBalanceSource = resolveProviderBalanceSource({
    providerId,
    providerKey: providerId,
    baseUrl,
    token: apiKey,
    credentialId: "primary",
    label: t("balance.apiKeySource"),
    primary: true,
  })
  const localBalanceSources = selectPrimaryBalanceSource(
    [
      directBalanceSource,
      ...legacyBalanceProjection.sources,
      ...preferences.balanceScriptSources
        .filter((source) => source.providerId === providerId)
        .map(resolveSandboxBalanceSource),
    ],
    preferences.primaryBalanceSourceByProvider[providerId]
  )
  const balanceSources: ResolvedProviderBalanceSource[] = pairedClient
    ? ((remoteStatus?.balanceSources ?? []).map((source) => ({
        ...source,
        credentialFingerprint: `credential:${source.providerId}:remote-projection`,
      })) as ResolvedProviderBalanceSource[])
    : localBalanceSources
  const allBalanceSnapshots = (
    pairedClient ? [...balances] : [...balances, ...legacyBalanceProjection.snapshots]
  ).sort((a, b) => b.fetchedAt - a.fetchedAt)

  const endpointCandidates = collectProviderEndpointCandidates({
    providerId,
    current: baseUrl,
    catalog: catalog?.defaultBaseURL ? [catalog.defaultBaseURL] : [],
    user: customEndpoint ? [customEndpoint] : [],
    ccswitch: extractCcswitchProviderEndpoints(providerId, ccswitchProviders),
  })

  /* ── Mutations ─────────────────────────────────────────────────────────── */

  async function prepareRun(
    endpoints?: string[],
    capabilityOverride: ProviderDiagnosticCapability = capability
  ): Promise<void> {
    if (!settings) return
    setRunError(null)
    if (pairedClient) {
      // The desktop resolves its own credentials and endpoint; a paired client
      // only names the shape of the run it wants performed.
      setPendingTargets([
        {
          id: `${providerId}:${capabilityOverride}:${modelId || "probe"}:paired-desktop`,
          providerId,
          ...(capabilityOverride === "probe" ? {} : { modelId }),
          credentialId: "desktop-selected",
          credentialFingerprint: `credential:${providerId}:desktop-selected`,
          endpoint: "",
          capability: capabilityOverride,
          credentials: {},
          billable: capabilityOverride !== "probe",
        },
      ])
      setConfirmOpen(true)
      return
    }
    try {
      const targets = await resolveProviderDiagnosticTargets({
        providerId,
        modelIds: capabilityOverride === "probe" ? [] : [modelId],
        capability: capabilityOverride,
        credentialIds: [credentialId],
        endpoints: endpoints ?? [selectedEndpoint || baseUrl],
        appSettings: settings,
      })
      setPendingTargets(targets)
      setConfirmOpen(true)
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error))
    }
  }

  async function compareEndpointsFree(): Promise<void> {
    if (!settings || pairedClient) return
    setEndpointComparing(true)
    setEndpointError(null)
    try {
      const targets = await resolveProviderDiagnosticTargets({
        providerId,
        modelIds: [],
        capability: "probe",
        endpoints: endpointCandidates.map((candidate) => candidate.url),
        appSettings: settings,
      })
      setEndpointComparisons(
        await compareProviderEndpointsFree(
          targets.map((target) => ({ ...target, capability: "probe" as const }))
        )
      )
    } catch (error) {
      setEndpointError(error instanceof Error ? error.message : String(error))
    } finally {
      setEndpointComparing(false)
    }
  }

  async function preparePaidEndpointComparison(): Promise<void> {
    if (pairedClient) return
    setCapability("text-generation")
    await prepareRun(
      endpointCandidates.map((candidate) => candidate.url),
      "text-generation"
    )
  }

  async function runConfirmed(): Promise<void> {
    setConfirmOpen(false)
    setRunError(null)
    if (pairedClient) {
      try {
        const result = await startRemoteProviderDiagnosticJob({
          targets: [{ providerId, ...(capability === "probe" ? {} : { modelId }), capability }],
          mode,
          costConfirmed: true,
          confirmedRequestLimit: requestCount,
          confirmedMaxEstimatedCostUsd: unknownCost
            ? preferences.maxEstimatedCostUsd
            : estimatedCost,
        })
        setActiveJobId(result.jobId)
        await refreshRemoteStatus()
      } catch (error) {
        setRunError(error instanceof Error ? error.message : String(error))
      }
      return
    }
    const jobId = crypto.randomUUID()
    setActiveJobId(jobId)
    // Persist the tuning the user just confirmed before running, so a crash
    // mid-job doesn't lose it and the next run starts from the same settings.
    await saveSettings({
      providerDiagnostics: {
        ...preferences,
        concurrency,
        textTimeoutMs: capability === "text-generation" ? timeoutMs : preferences.textTimeoutMs,
        embeddingTimeoutMs: capability === "embedding" ? timeoutMs : preferences.embeddingTimeoutMs,
        probeTimeoutMs: capability === "probe" ? timeoutMs : preferences.probeTimeoutMs,
      },
    })
    try {
      await startProviderDiagnosticJob({
        jobId,
        providerId,
        mode,
        capability,
        targets: pendingTargets,
        unknownCostConfirmed: unknownCost,
        preferences: {
          ...preferences,
          concurrency,
          textTimeoutMs: timeoutMs,
          embeddingTimeoutMs: timeoutMs,
          probeTimeoutMs: timeoutMs,
        },
      })
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error))
    }
  }

  async function refreshBalance(source: ResolvedProviderBalanceSource): Promise<void> {
    if (pairedClient) {
      await refreshRemoteStatus()
      return
    }
    await refreshProviderBalanceSources([source])
  }

  async function setPrimaryBalance(sourceId: string): Promise<void> {
    if (pairedClient) return
    await saveSettings({
      providerDiagnostics: {
        ...preferences,
        primaryBalanceSourceByProvider: {
          ...preferences.primaryBalanceSourceByProvider,
          [providerId]: sourceId,
        },
      },
    })
  }

  async function setLowBalanceThreshold(
    sourceId: string,
    unit: string,
    value: number
  ): Promise<void> {
    if (pairedClient) return
    await saveSettings({
      providerDiagnostics: {
        ...preferences,
        lowBalanceThresholdsBySource: {
          ...preferences.lowBalanceThresholdsBySource,
          [sourceId]: { unit, value: Math.max(0, value) },
        },
      },
    })
  }

  async function saveSandboxBalanceSource(draft: BalanceScriptDraft): Promise<void> {
    if (pairedClient) return
    if (!draft.label.trim() || !draft.origin.trim() || !draft.code.trim() || !draft.token) {
      throw new Error(t("balance.scriptRequired"))
    }
    const id = `sandbox:${providerId}:${crypto.randomUUID()}`
    // The token goes to the keyring; settings only ever holds the reference.
    const credentialRef = await migrateProviderBalanceToken(id, draft.token)
    const grants = draft.grantDomain.trim()
      ? [
          {
            domain: draft.grantDomain.trim(),
            allowHttp: draft.allowHttp,
            allowPrivate: draft.allowPrivate,
          },
        ]
      : []
    await saveSettings({
      providerDiagnostics: {
        ...preferences,
        balanceScriptSources: [
          ...preferences.balanceScriptSources,
          {
            id,
            providerId,
            label: draft.label.trim(),
            script: draft.code,
            sameOrigin: draft.origin.trim(),
            credentialRef,
            grants,
            enabled: true,
          },
        ],
      },
    })
  }

  async function removeSandboxBalanceSource(sourceId: string): Promise<void> {
    if (pairedClient) return
    await clearProviderBalanceToken(sourceId)
    await saveSettings({
      providerDiagnostics: {
        ...preferences,
        balanceScriptSources: preferences.balanceScriptSources.filter(
          (source) => source.id !== sourceId
        ),
      },
    })
  }

  async function applyEndpoint(endpoint: string): Promise<void> {
    if (pairedClient) return
    setEndpointError(null)
    try {
      await applyProviderEndpoint({ providerId, endpoint, expectedCurrentEndpoint: baseUrl })
    } catch (error) {
      setEndpointError(error instanceof Error ? error.message : String(error))
    }
  }

  async function cancelActiveJob(): Promise<void> {
    if (!activeJobId) return
    if (pairedClient) {
      await cancelRemoteProviderDiagnosticJob(activeJobId)
      await refreshRemoteStatus()
      return
    }
    cancelProviderDiagnosticJob(activeJobId)
  }

  async function exportHistory(): Promise<void> {
    const content = pairedClient
      ? JSON.stringify(
          {
            capturedAt: remoteHistory?.capturedAt,
            desktopRevision: remoteHistory?.desktopRevision,
            stale: remoteHistory?.stale ?? true,
            samples: remoteHistory?.samples ?? [],
          },
          null,
          2
        )
      : await exportProviderDiagnosticHistory({ providerId, format: "json" })
    downloadFile(`provider-diagnostics-${providerId}.json`, content, "application/json")
  }

  return (
    <div className="@container/diagnostics">
      {(stale || runError) && (
        <div className="mb-5 space-y-3">
          {stale && (
            <Alert>
              <Clock3 className="h-4 w-4" />
              <AlertTitle>{t("stale.title")}</AlertTitle>
              <AlertDescription>{t("stale.description")}</AlertDescription>
            </Alert>
          )}
          {runError && (
            <Alert variant="destructive">
              <TriangleAlert className="h-4 w-4" />
              <AlertTitle>{t("error.title")}</AlertTitle>
              <AlertDescription>{runError}</AlertDescription>
            </Alert>
          )}
        </div>
      )}

      <ProviderSectionStack>
        <SummarySection providerName={providerName} latestSample={latestSample} />

        <RunComposer
          mode={mode}
          onModeChange={setMode}
          capability={capability}
          onCapabilityChange={setCapability}
          modelId={modelId}
          onModelIdChange={setModelId}
          modelIds={modelIds}
          credentialId={credentialId}
          onCredentialIdChange={setCredentialId}
          credentialPoolSize={providerSettings?.apiKeys?.length ?? 0}
          endpoint={selectedEndpoint || baseUrl}
          onEndpointChange={setSelectedEndpoint}
          endpointCandidates={endpointCandidates}
          concurrency={concurrency}
          onConcurrencyChange={setConcurrency}
          timeoutMs={timeoutMs}
          onTimeoutMsChange={setTimeoutMs}
          remotePaidEnabled={preferences.remotePaidDiagnosticsEnabled}
          onRemotePaidEnabledChange={(checked) =>
            void saveSettings({
              providerDiagnostics: { ...preferences, remotePaidDiagnosticsEnabled: checked },
            })
          }
          onReviewRun={() => void prepareRun()}
          running={jobRunning}
          runDisabled={!baseUrl || (capability !== "probe" && !modelId)}
        />

        {jobRunning && (
          <ProgressSection
            percent={progress}
            completedCount={activeJob?.completedCount ?? 0}
            targetCount={activeJob?.targetCount ?? pendingTargets.length}
            pendingTargets={pendingTargets}
            cancelDisabled={pairedClient}
            onCancelAll={() => void cancelActiveJob()}
            onCancelTarget={(targetId) =>
              activeJobId && cancelProviderDiagnosticTarget(activeJobId, targetId)
            }
          />
        )}

        <MatrixSection
          rows={matrixRows}
          scenario={scenario}
          onScenarioChange={setScenario}
          filters={filters}
          onFiltersChange={setFilters}
          options={filterOptions}
        />

        <BalanceSection
          sources={balanceSources}
          snapshots={allBalanceSnapshots}
          thresholds={preferences.lowBalanceThresholdsBySource}
          defaultOrigin={baseUrl}
          readOnly={pairedClient}
          onRefresh={(source) => void refreshBalance(source)}
          onMakePrimary={(sourceId) => void setPrimaryBalance(sourceId)}
          onThresholdChange={(sourceId, unit, value) =>
            void setLowBalanceThreshold(sourceId, unit, value)
          }
          onRemoveSource={(sourceId) => void removeSandboxBalanceSource(sourceId)}
          onSaveScript={saveSandboxBalanceSource}
        />

        <EndpointsSection
          candidates={endpointCandidates}
          comparisons={endpointComparisons}
          currentEndpoint={baseUrl}
          customEndpoint={customEndpoint}
          onCustomEndpointChange={setCustomEndpoint}
          onAddCustomEndpoint={() => setCustomEndpoint(customEndpoint.trim())}
          onCompareFree={() => void compareEndpointsFree()}
          onComparePaid={() => void preparePaidEndpointComparison()}
          comparing={endpointComparing}
          comparePaidDisabled={!modelId}
          error={endpointError}
          onRequestApply={setPendingEndpoint}
          rollbacks={endpointChanges.filter((change) => !change.rolledBackAt)}
          onRollback={(changeId) => void rollbackProviderEndpoint(changeId)}
          readOnly={pairedClient}
        />

        <HistorySection
          samples={visibleSamples}
          trend={trend}
          onExport={() => void exportHistory()}
          onClear={() => void clearProviderDiagnosticHistory({ providerId })}
          clearDisabled={pairedClient}
        />
      </ProviderSectionStack>

      <RunConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        requestCount={requestCount}
        estimatedCostUsd={estimatedCost}
        unknownCost={unknownCost}
        free={capability === "probe"}
        limits={{
          maxOutputTokens: preferences.maxOutputTokens,
          maxRequestsPerJob: preferences.maxRequestsPerJob,
          maxEstimatedCostUsd: preferences.maxEstimatedCostUsd,
        }}
        onConfirm={() => void runConfirmed()}
      />
      <EndpointDiffDialog
        pendingEndpoint={pendingEndpoint}
        currentEndpoint={baseUrl}
        onCancel={() => setPendingEndpoint(null)}
        onConfirm={(endpoint) => {
          void applyEndpoint(endpoint)
          setPendingEndpoint(null)
        }}
      />
    </div>
  )
}

export default ProviderDiagnosticsTab
