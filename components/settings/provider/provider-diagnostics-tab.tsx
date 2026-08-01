"use client"

import { useEffect, useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  Activity,
  ArrowDownUp,
  Ban,
  CheckCircle2,
  Clock3,
  Coins,
  Download,
  Gauge,
  History,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Server,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
  XCircle,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useCcswitchProviders } from "@/lib/ccswitch/hooks"
import { isTauri } from "@/lib/tauri"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { getDb } from "@/lib/db/schema"
import {
  refreshProviderBalanceSources,
  projectLegacyProviderBalanceRows,
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
  fetchRemoteProviderDiagnosticsHistory,
  fetchRemoteProviderDiagnosticsStatus,
  getCachedRemoteProviderDiagnosticsHistory,
  getCachedRemoteProviderDiagnosticsStatus,
  startRemoteProviderDiagnosticJob,
  type RemoteProviderDiagnosticsHistory,
  type RemoteProviderDiagnosticsStatus,
} from "@/lib/provider-diagnostics/remote-client"
import { summarizeProviderDiagnosticSamples } from "@/lib/provider-diagnostics/statistics"
import {
  clearProviderDiagnosticHistory,
  exportProviderDiagnosticHistory,
  queryProviderDiagnosticHistory,
} from "@/lib/provider-diagnostics/store"
import { resolveProviderDiagnosticTargets } from "@/lib/provider-diagnostics/targets"
import {
  clearProviderBalanceToken,
  migrateProviderBalanceToken,
} from "@/lib/provider-diagnostics/sandbox"
import { useSettingsStore } from "@/stores/settings"
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
import {
  DEFAULT_PROVIDER_DIAGNOSTICS_PREFERENCES,
  type ProviderDiagnosticCapability,
  type ProviderDiagnosticMode,
  type ProviderDiagnosticSample,
} from "@cognia/provider-types"
import { getProviderConfig } from "@cognia/provider-types/provider"

interface ProviderDiagnosticsTabProps {
  providerId: string
  providerName: string
  modelIds: string[]
  defaultModel?: string
}

function formatMs(value?: number): string {
  return value === undefined ? "—" : `${Math.round(value)} ms`
}

function formatNumber(value?: number, digits = 2): string {
  return value === undefined ? "—" : value.toFixed(digits)
}

function downloadText(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

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

  const [mode, setMode] = useState<ProviderDiagnosticMode>("quick")
  const [capability, setCapability] = useState<ProviderDiagnosticCapability>("probe")
  const [modelId, setModelId] = useState(defaultModel ?? modelIds[0] ?? "")
  const [credentialId, setCredentialId] = useState("primary")
  const [selectedEndpoint, setSelectedEndpoint] = useState(baseUrl)
  const [concurrency, setConcurrency] = useState(preferences.concurrency)
  const [timeoutMs, setTimeoutMs] = useState(preferences.textTimeoutMs)
  const [pendingTargets, setPendingTargets] = useState<ResolvedProviderDiagnosticTarget[]>([])
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [composerOpen, setComposerOpen] = useState(false)
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [customEndpoint, setCustomEndpoint] = useState("")
  const [endpointError, setEndpointError] = useState<string | null>(null)
  const [pendingEndpoint, setPendingEndpoint] = useState<string | null>(null)
  const [endpointComparing, setEndpointComparing] = useState(false)
  const [endpointComparisons, setEndpointComparisons] = useState<
    Awaited<ReturnType<typeof compareProviderEndpointsFree>>
  >([])
  const [historyStatus, setHistoryStatus] = useState<"all" | "completed" | "failed">("all")
  const [historyModel, setHistoryModel] = useState("all")
  const [historyCapability, setHistoryCapability] = useState("all")
  const [historyCredential, setHistoryCredential] = useState("all")
  const [historyEndpoint, setHistoryEndpoint] = useState("all")
  const [historyRange, setHistoryRange] = useState<"24h" | "7d" | "all">("7d")
  const [scenario, setScenario] = useState<"interactive" | "batch" | "economy">("interactive")
  const [scriptLabel, setScriptLabel] = useState("")
  const [scriptOrigin, setScriptOrigin] = useState(baseUrl)
  const [scriptCode, setScriptCode] = useState("")
  const [scriptToken, setScriptToken] = useState("")
  const [grantDomain, setGrantDomain] = useState("")
  const [grantHttp, setGrantHttp] = useState(false)
  const [grantPrivate, setGrantPrivate] = useState(false)
  const [sourceConfigError, setSourceConfigError] = useState<string | null>(null)
  const [currentTime, setCurrentTime] = useState(() => Date.now())
  const pairedClient = !isTauri() && loadCompanionConfig() !== null
  const [remoteStatus, setRemoteStatus] = useState<RemoteProviderDiagnosticsStatus | null>(() =>
    pairedClient ? getCachedRemoteProviderDiagnosticsStatus(providerId) : null
  )
  const [remoteHistory, setRemoteHistory] = useState<RemoteProviderDiagnosticsHistory | null>(() =>
    pairedClient ? getCachedRemoteProviderDiagnosticsHistory(providerId) : null
  )

  const localSamples = useLiveQuery(
    () => queryProviderDiagnosticHistory({ providerId, limit: 500 }),
    [providerId],
    []
  )
  const localJobs = useLiveQuery(
    () =>
      getDb()
        .providerDiagnosticJobs.where("providerId")
        .equals(providerId)
        .reverse()
        .sortBy("startedAt"),
    [providerId],
    []
  )
  const localBalances = useLiveQuery(
    () =>
      getDb()
        .providerBalanceSnapshots.where("providerId")
        .equals(providerId)
        .reverse()
        .sortBy("fetchedAt"),
    [providerId],
    []
  )
  const legacyBalanceProjection = useLiveQuery(
    async () => {
      const [legacyBalances, legacyLimits] = await Promise.all([
        getDb()
          .subscriptionBalance.filter((row) => row.providerKey === providerId)
          .toArray(),
        getDb().providerLimits.where("provider").equals(providerId).toArray(),
      ])
      return projectLegacyProviderBalanceRows({
        providerId,
        balances: legacyBalances,
        limits: legacyLimits,
      })
    },
    [providerId],
    { sources: [], snapshots: [] }
  )
  const endpointChanges = useLiveQuery(
    () =>
      getDb()
        .providerEndpointChanges.where("providerId")
        .equals(providerId)
        .reverse()
        .sortBy("appliedAt"),
    [providerId],
    []
  )

  useEffect(() => {
    if (!pairedClient) return
    let active = true
    const refresh = async () => {
      const [nextStatus, nextHistory] = await Promise.all([
        fetchRemoteProviderDiagnosticsStatus(providerId),
        fetchRemoteProviderDiagnosticsHistory({ providerId, limit: 200 }),
      ])
      if (!active) return
      setRemoteStatus(nextStatus)
      setRemoteHistory(nextHistory)
    }
    void refresh().catch(() => undefined)
    const interval = window.setInterval(() => void refresh().catch(() => undefined), 10_000)
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh().catch(() => undefined)
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      active = false
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [pairedClient, providerId])

  useEffect(() => {
    const interval = window.setInterval(() => setCurrentTime(Date.now()), 60_000)
    return () => window.clearInterval(interval)
  }, [])

  const samples: ProviderDiagnosticSample[] = pairedClient
    ? (remoteHistory?.samples.map((sample) => ({ ...sample, endpoint: "" })) ?? [])
    : localSamples
  const jobs = pairedClient ? (remoteStatus?.jobs ?? []) : localJobs
  const balances = useMemo(
    () => (pairedClient ? (remoteStatus?.balanceSnapshots ?? []) : localBalances),
    [localBalances, pairedClient, remoteStatus?.balanceSnapshots]
  )

  const activeJob = activeJobId ? jobs.find((job) => job.id === activeJobId) : undefined
  const jobRunning = activeJob?.status === "running" || (activeJobId !== null && !activeJob)
  const measuredSamples = samples.filter((sample) => sample.sampleRole === "measured")
  const latestSample = measuredSamples[0]
  const stale = pairedClient
    ? (remoteStatus?.stale ?? remoteHistory?.stale ?? false)
    : latestSample
      ? currentTime - latestSample.startedAt > 15 * 60_000
      : false
  const rangeStart =
    historyRange === "all"
      ? 0
      : currentTime - (historyRange === "24h" ? 24 * 60 * 60_000 : 7 * 24 * 60 * 60_000)
  const visibleSamples = measuredSamples.filter(
    (sample) =>
      (historyStatus === "all" || sample.status === historyStatus) &&
      (historyModel === "all" || sample.modelId === historyModel) &&
      (historyCapability === "all" || sample.capability === historyCapability) &&
      (historyCredential === "all" || sample.credentialFingerprint === historyCredential) &&
      (historyEndpoint === "all" || sample.endpoint === historyEndpoint) &&
      sample.startedAt >= rangeStart
  )
  const summaries = (() => {
    const ids = [...new Set(visibleSamples.map((sample) => sample.targetId))]
    const rows = ids.map((targetId) => ({
      targetId,
      sample: visibleSamples.find((sample) => sample.targetId === targetId),
      summary: summarizeProviderDiagnosticSamples(
        visibleSamples.filter((sample) => sample.targetId === targetId)
      ),
    }))
    rows.sort((left, right) => {
      if (scenario === "batch") {
        return (
          (right.summary.outputTokensPerSecond?.median ?? -1) -
          (left.summary.outputTokensPerSecond?.median ?? -1)
        )
      }
      if (scenario === "economy") {
        return (
          (left.summary.estimatedCostUsd?.median ?? Number.POSITIVE_INFINITY) -
          (right.summary.estimatedCostUsd?.median ?? Number.POSITIVE_INFINITY)
        )
      }
      return (
        (left.summary.ttftMs?.median ?? Number.POSITIVE_INFINITY) -
        (right.summary.ttftMs?.median ?? Number.POSITIVE_INFINITY)
      )
    })
    return rows
  })()
  const filterModels = [
    ...new Set(measuredSamples.flatMap((sample) => (sample.modelId ? [sample.modelId] : []))),
  ]
  const filterCredentials = [
    ...new Set(measuredSamples.map((sample) => sample.credentialFingerprint)),
  ]
  const filterEndpoints = [...new Set(measuredSamples.map((sample) => sample.endpoint))]
  const trendSamples = visibleSamples
    .filter(
      (sample) =>
        sample.metrics?.totalDurationMs !== undefined || sample.probe?.durationMs !== undefined
    )
    .slice(0, 20)
    .reverse()
  const maxTrendDuration = Math.max(
    1,
    ...trendSamples.map(
      (sample) => sample.metrics?.totalDurationMs ?? sample.probe?.durationMs ?? 0
    )
  )

  const requestCount = pendingTargets.length * (mode === "precise" ? 4 : 1)
  const estimatedCost = pendingTargets.reduce(
    (total, target) => total + (target.estimatedMaxCostUsd ?? 0) * (mode === "precise" ? 4 : 1),
    0
  )
  const unknownCost = pendingTargets.some(
    (target) => target.billable && target.estimatedMaxCostUsd === undefined
  )
  const progress = activeJob
    ? Math.min(
        100,
        (activeJob.completedCount /
          Math.max(1, activeJob.targetCount * (activeJob.mode === "precise" ? 4 : 1))) *
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

  async function prepareRun(
    endpoints?: string[],
    capabilityOverride: ProviderDiagnosticCapability = capability
  ): Promise<void> {
    if (!settings) return
    setRunError(null)
    if (pairedClient) {
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
    setComposerOpen(false)
    setRunError(null)
    if (pairedClient) {
      try {
        const result = await startRemoteProviderDiagnosticJob({
          targets: [
            {
              providerId,
              ...(capability === "probe" ? {} : { modelId }),
              capability,
            },
          ],
          mode,
          costConfirmed: true,
          confirmedRequestLimit: requestCount,
          confirmedMaxEstimatedCostUsd: unknownCost
            ? preferences.maxEstimatedCostUsd
            : estimatedCost,
        })
        setActiveJobId(result.jobId)
        const nextStatus = await fetchRemoteProviderDiagnosticsStatus(providerId)
        setRemoteStatus(nextStatus)
      } catch (error) {
        setRunError(error instanceof Error ? error.message : String(error))
      }
      return
    }
    const jobId = crypto.randomUUID()
    setActiveJobId(jobId)
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
      setRemoteStatus(await fetchRemoteProviderDiagnosticsStatus(providerId))
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

  async function saveSandboxBalanceSource(): Promise<void> {
    if (pairedClient) return
    setSourceConfigError(null)
    try {
      if (!scriptLabel.trim() || !scriptOrigin.trim() || !scriptCode.trim() || !scriptToken) {
        throw new Error(t("balance.scriptRequired"))
      }
      const id = `sandbox:${providerId}:${crypto.randomUUID()}`
      const credentialRef = await migrateProviderBalanceToken(id, scriptToken)
      const grants = grantDomain.trim()
        ? [{ domain: grantDomain.trim(), allowHttp: grantHttp, allowPrivate: grantPrivate }]
        : []
      await saveSettings({
        providerDiagnostics: {
          ...preferences,
          balanceScriptSources: [
            ...preferences.balanceScriptSources,
            {
              id,
              providerId,
              label: scriptLabel.trim(),
              script: scriptCode,
              sameOrigin: scriptOrigin.trim(),
              credentialRef,
              grants,
              enabled: true,
            },
          ],
        },
      })
      setScriptLabel("")
      setScriptCode("")
      setScriptToken("")
      setGrantDomain("")
      setGrantHttp(false)
      setGrantPrivate(false)
    } catch (error) {
      setSourceConfigError(error instanceof Error ? error.message : String(error))
    }
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
      setRemoteStatus(await fetchRemoteProviderDiagnosticsStatus(providerId))
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
    downloadText(`provider-diagnostics-${providerId}.json`, content, "application/json")
  }

  const composer = (
    <div className="space-y-4" data-testid="diagnostics-run-composer">
      <div className="grid gap-3 @md:grid-cols-2">
        <div className="space-y-1.5">
          <Label>{t("composer.mode")}</Label>
          <Select value={mode} onValueChange={(value) => setMode(value as ProviderDiagnosticMode)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="quick">{t("composer.quick")}</SelectItem>
              <SelectItem value="precise">{t("composer.precise")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>{t("composer.capability")}</Label>
          <Select
            value={capability}
            onValueChange={(value) => setCapability(value as ProviderDiagnosticCapability)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="probe">{t("composer.probe")}</SelectItem>
              <SelectItem value="text-generation">{t("composer.text")}</SelectItem>
              <SelectItem value="embedding">{t("composer.embedding")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {capability !== "probe" && (
        <div className="space-y-1.5">
          <Label>{t("composer.model")}</Label>
          <Select value={modelId} onValueChange={setModelId}>
            <SelectTrigger>
              <SelectValue placeholder={t("composer.selectModel")} />
            </SelectTrigger>
            <SelectContent>
              {modelIds.map((id) => (
                <SelectItem key={id} value={id}>
                  {id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="grid gap-3 @md:grid-cols-2">
        <div className="space-y-1.5">
          <Label>{t("composer.credential")}</Label>
          <Select value={credentialId} onValueChange={setCredentialId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="primary">{t("composer.primaryCredential")}</SelectItem>
              {(providerSettings?.apiKeys ?? []).map((_, index) => (
                <SelectItem key={index} value={`pool:${index}`}>
                  {t("composer.poolCredential", { index: index + 1 })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>{t("composer.endpoint")}</Label>
          <Select value={selectedEndpoint || baseUrl} onValueChange={setSelectedEndpoint}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {endpointCandidates.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.url}>
                  {candidate.label ?? candidate.url}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid gap-3 @md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="diagnostics-concurrency">{t("composer.concurrency")}</Label>
          <Input
            id="diagnostics-concurrency"
            type="number"
            min={1}
            max={5}
            value={concurrency}
            onChange={(event) =>
              setConcurrency(Math.min(5, Math.max(1, Number(event.target.value))))
            }
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="diagnostics-timeout">{t("composer.timeout")}</Label>
          <Input
            id="diagnostics-timeout"
            type="number"
            min={1_000}
            max={120_000}
            step={1_000}
            value={timeoutMs}
            onChange={(event) => setTimeoutMs(Math.max(1_000, Number(event.target.value)))}
          />
        </div>
      </div>
      <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
        {t("composer.preview", {
          requests: mode === "precise" ? 4 : 1,
          concurrency,
          timeout: Math.round(timeoutMs / 1_000),
        })}
      </div>
      <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
        <div>
          <Label htmlFor="remote-paid-diagnostics">{t("composer.remotePaid")}</Label>
          <p className="text-xs text-muted-foreground">{t("composer.remotePaidDescription")}</p>
        </div>
        <Switch
          id="remote-paid-diagnostics"
          checked={preferences.remotePaidDiagnosticsEnabled}
          onCheckedChange={(checked) =>
            void saveSettings({
              providerDiagnostics: { ...preferences, remotePaidDiagnosticsEnabled: checked },
            })
          }
        />
      </div>
      <Button
        className="w-full gap-2"
        onClick={() => void prepareRun()}
        disabled={!baseUrl || (capability !== "probe" && !modelId) || jobRunning}
      >
        {jobRunning ? (
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        ) : (
          <Play className="h-4 w-4" />
        )}
        {t("composer.reviewRun")}
      </Button>
    </div>
  )

  return (
    <div className="@container/diagnostics space-y-4 pb-8">
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

      <div className="grid gap-4 @4xl:grid-cols-[minmax(17rem,0.7fr)_minmax(0,1.7fr)]">
        <aside className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Activity className="h-4 w-4" />
                {t("summary.title")}
              </CardTitle>
              <CardDescription>
                {t("summary.description", { provider: providerName })}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-3 gap-2">
              <div className="rounded-lg border p-2 text-center">
                <Server className="mx-auto mb-1 h-4 w-4" />
                <p className="text-[10px] text-muted-foreground">{t("summary.transport")}</p>
                <Badge variant={latestSample?.probe?.reachable ? "default" : "secondary"}>
                  {latestSample?.probe?.reachable ? t("status.reachable") : t("status.unknown")}
                </Badge>
              </div>
              <div className="rounded-lg border p-2 text-center">
                <CheckCircle2 className="mx-auto mb-1 h-4 w-4" />
                <p className="text-[10px] text-muted-foreground">{t("summary.auth")}</p>
                <Badge variant={latestSample?.probe?.authenticated ? "default" : "secondary"}>
                  {latestSample?.probe?.authenticated === true
                    ? t("status.verified")
                    : latestSample?.probe?.authenticated === false
                      ? t("status.invalid")
                      : t("status.unverified")}
                </Badge>
              </div>
              <div className="rounded-lg border p-2 text-center">
                <Gauge className="mx-auto mb-1 h-4 w-4" />
                <p className="text-[10px] text-muted-foreground">{t("summary.execution")}</p>
                <Badge variant={latestSample?.status === "completed" ? "default" : "secondary"}>
                  {latestSample?.status === "completed"
                    ? t("status.completed")
                    : t("status.unverified")}
                </Badge>
              </div>
            </CardContent>
          </Card>

          <Card className="hidden @md:block">
            <CardHeader>
              <CardTitle className="text-base">{t("composer.title")}</CardTitle>
              <CardDescription>{t("composer.description")}</CardDescription>
            </CardHeader>
            <CardContent>{composer}</CardContent>
          </Card>
          <Sheet open={composerOpen} onOpenChange={setComposerOpen}>
            <SheetTrigger asChild>
              <Button className="w-full gap-2 @md:hidden">
                <SlidersHorizontal className="h-4 w-4" />
                {t("composer.open")}
              </Button>
            </SheetTrigger>
            <SheetContent side="bottom" className="max-h-[92dvh] overflow-y-auto rounded-t-2xl">
              <SheetHeader>
                <SheetTitle>{t("composer.title")}</SheetTitle>
              </SheetHeader>
              <div className="mt-4">{composer}</div>
            </SheetContent>
          </Sheet>
        </aside>

        <main className="min-w-0 space-y-4">
          {jobRunning && (
            <Card aria-live="polite">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center justify-between text-base">
                  <span className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                    {t("progress.title")}
                  </span>
                  <Button variant="destructive" size="sm" onClick={() => void cancelActiveJob()}>
                    <Ban className="mr-1 h-3.5 w-3.5" />
                    {t("progress.cancelAll")}
                  </Button>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Progress
                  value={progress}
                  aria-label={t("progress.aria", { percent: Math.round(progress) })}
                />
                <p className="text-xs text-muted-foreground">
                  {t("progress.count", {
                    completed: activeJob?.completedCount ?? 0,
                    total: activeJob?.targetCount ?? pendingTargets.length,
                  })}
                </p>
                <div className="space-y-1">
                  {pendingTargets.map((target) => (
                    <div
                      key={target.id}
                      className="flex items-center justify-between rounded border px-2 py-1.5 text-xs"
                    >
                      <span className="truncate">
                        {target.modelId ?? t("composer.probe")} · {target.endpoint}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pairedClient}
                        onClick={() =>
                          activeJobId && cancelProviderDiagnosticTarget(activeJobId, target.id)
                        }
                      >
                        {t("progress.cancelTarget")}
                      </Button>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="flex-row items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ArrowDownUp className="h-4 w-4" />
                  {t("matrix.title")}
                </CardTitle>
                <CardDescription>{t("matrix.description")}</CardDescription>
              </div>
              <Select
                value={historyStatus}
                onValueChange={(value) => setHistoryStatus(value as typeof historyStatus)}
              >
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("filters.all")}</SelectItem>
                  <SelectItem value="completed">{t("status.completed")}</SelectItem>
                  <SelectItem value="failed">{t("status.failed")}</SelectItem>
                </SelectContent>
              </Select>
            </CardHeader>
            <CardContent>
              <div className="mb-4 grid gap-2 @md:grid-cols-2 @4xl:grid-cols-3">
                <Select
                  value={scenario}
                  onValueChange={(value) => setScenario(value as typeof scenario)}
                >
                  <SelectTrigger aria-label={t("filters.scenario")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="interactive">{t("filters.interactive")}</SelectItem>
                    <SelectItem value="batch">{t("filters.batch")}</SelectItem>
                    <SelectItem value="economy">{t("filters.economy")}</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={historyModel} onValueChange={setHistoryModel}>
                  <SelectTrigger aria-label={t("filters.model")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("filters.allModels")}</SelectItem>
                    {filterModels.map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={historyCapability} onValueChange={setHistoryCapability}>
                  <SelectTrigger aria-label={t("filters.capability")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("filters.allCapabilities")}</SelectItem>
                    <SelectItem value="probe">{t("composer.probe")}</SelectItem>
                    <SelectItem value="text-generation">{t("composer.text")}</SelectItem>
                    <SelectItem value="embedding">{t("composer.embedding")}</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={historyCredential} onValueChange={setHistoryCredential}>
                  <SelectTrigger aria-label={t("filters.credential")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("filters.allCredentials")}</SelectItem>
                    {filterCredentials.map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={historyEndpoint} onValueChange={setHistoryEndpoint}>
                  <SelectTrigger aria-label={t("filters.endpoint")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("filters.allEndpoints")}</SelectItem>
                    {filterEndpoints.map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={historyRange}
                  onValueChange={(value) => setHistoryRange(value as typeof historyRange)}
                >
                  <SelectTrigger aria-label={t("filters.date")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="24h">{t("filters.last24h")}</SelectItem>
                    <SelectItem value="7d">{t("filters.last7d")}</SelectItem>
                    <SelectItem value="all">{t("filters.allDates")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {summaries.length > 0 && (
                <Alert className="mb-4">
                  <Gauge className="h-4 w-4" />
                  <AlertTitle>{t("matrix.recommendation")}</AlertTitle>
                  <AlertDescription>
                    {t(`matrix.reason.${scenario}`, {
                      model: summaries[0].sample?.modelId ?? t("composer.probe"),
                    })}
                  </AlertDescription>
                </Alert>
              )}
              {summaries.length === 0 ? (
                <div className="py-10 text-center text-sm text-muted-foreground">
                  <Gauge className="mx-auto mb-2 h-8 w-8 opacity-30" />
                  {t("matrix.empty")}
                </div>
              ) : (
                <>
                  <div className="hidden overflow-x-auto @3xl:block">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("matrix.model")}</TableHead>
                          <TableHead>{t("matrix.endpoint")}</TableHead>
                          <TableHead>{t("matrix.status")}</TableHead>
                          <TableHead>{t("matrix.ttft")}</TableHead>
                          <TableHead>{t("matrix.total")}</TableHead>
                          <TableHead>{t("matrix.throughput")}</TableHead>
                          <TableHead>{t("matrix.cost")}</TableHead>
                          <TableHead>{t("matrix.samples")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {summaries.map(({ targetId, sample, summary }) => (
                          <TableRow key={targetId}>
                            <TableCell className="font-medium">
                              {sample?.modelId ?? t("composer.probe")}
                            </TableCell>
                            <TableCell className="max-w-48 truncate" title={sample?.endpoint}>
                              {sample?.endpoint}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant={sample?.status === "completed" ? "default" : "destructive"}
                              >
                                {sample?.status === "completed"
                                  ? t("status.completed")
                                  : t("status.failed")}
                              </Badge>
                            </TableCell>
                            <TableCell>{formatMs(summary.ttftMs?.median)}</TableCell>
                            <TableCell>{formatMs(summary.totalDurationMs?.median)}</TableCell>
                            <TableCell>
                              {formatNumber(summary.outputTokensPerSecond?.median)}
                            </TableCell>
                            <TableCell>
                              {summary.estimatedCostUsd?.median === undefined
                                ? "—"
                                : `$${summary.estimatedCostUsd.median.toFixed(6)}`}
                            </TableCell>
                            <TableCell>
                              {summary.measuredSamples}
                              {summary.totalDurationMs?.p95 === undefined
                                ? ""
                                : ` · P95 ${formatMs(summary.totalDurationMs.p95)}`}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <div className="grid gap-3 @3xl:hidden">
                    {summaries.map(({ targetId, sample, summary }) => (
                      <article key={targetId} className="rounded-lg border p-3">
                        <div className="mb-2 flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <h4 className="truncate text-sm font-medium">
                              {sample?.modelId ?? t("composer.probe")}
                            </h4>
                            <p className="truncate text-xs text-muted-foreground">
                              {sample?.endpoint}
                            </p>
                          </div>
                          {sample?.status === "completed" ? (
                            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                          ) : (
                            <XCircle className="h-4 w-4 text-destructive" />
                          )}
                        </div>
                        <dl className="grid grid-cols-2 gap-2 text-xs">
                          <div>
                            <dt className="text-muted-foreground">{t("matrix.ttft")}</dt>
                            <dd>{formatMs(summary.ttftMs?.median)}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">{t("matrix.throughput")}</dt>
                            <dd>{formatNumber(summary.outputTokensPerSecond?.median)}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">{t("matrix.total")}</dt>
                            <dd>{formatMs(summary.totalDurationMs?.median)}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">{t("matrix.samples")}</dt>
                            <dd>{summary.measuredSamples}</dd>
                          </div>
                        </dl>
                        {sample?.failure && (
                          <p className="mt-2 rounded bg-destructive/10 p-2 text-xs text-destructive">
                            {sample.failure.message}
                          </p>
                        )}
                      </article>
                    ))}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 @3xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Coins className="h-4 w-4" />
                  {t("balance.title")}
                </CardTitle>
                <CardDescription>{t("balance.description")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {balanceSources.map((source) => {
                  const snapshot = allBalanceSnapshots.find((item) => item.sourceId === source.id)
                  const threshold = preferences.lowBalanceThresholdsBySource[source.id]
                  const thresholdUnit =
                    threshold?.unit ?? snapshot?.amounts[0]?.unit ?? source.unit ?? "credits"
                  return (
                    <div key={source.id} className="rounded-lg border p-3">
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="text-sm font-medium">{source.label}</p>
                          <p className="text-xs text-muted-foreground">
                            {t(`balance.kind.${source.kind}` as never)}
                          </p>
                        </div>
                        <div className="flex items-center gap-1">
                          {source.primary && <Badge>{t("balance.primary")}</Badge>}
                          {source.kind === "sandbox-script" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={pairedClient}
                              aria-label={t("balance.removeSource")}
                              onClick={() => void removeSandboxBalanceSource(source.id)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {snapshot?.amounts.map((amount) => (
                          <Badge key={amount.unit} variant="outline">
                            {amount.remaining ?? "—"} {amount.unit}
                          </Badge>
                        )) ?? (
                          <span className="text-xs text-muted-foreground">
                            {t("balance.noSnapshot")}
                          </span>
                        )}
                      </div>
                      {snapshot?.failure && (
                        <p className="mt-2 text-xs text-destructive">{snapshot.failure.message}</p>
                      )}
                      <div className="mt-3 grid grid-cols-[1fr_auto] items-end gap-2">
                        <div className="space-y-1">
                          <Label htmlFor={`balance-threshold-${source.id}`} className="text-xs">
                            {t("balance.threshold", { unit: thresholdUnit })}
                          </Label>
                          <Input
                            id={`balance-threshold-${source.id}`}
                            type="number"
                            min={0}
                            value={threshold?.value ?? ""}
                            placeholder={t("balance.thresholdPlaceholder")}
                            disabled={pairedClient}
                            onChange={(event) =>
                              void setLowBalanceThreshold(
                                source.id,
                                thresholdUnit,
                                Number(event.target.value)
                              )
                            }
                          />
                        </div>
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void refreshBalance(source)}
                            disabled={
                              pairedClient ||
                              source.kind === "unsupported" ||
                              (!source.query && !source.scriptConfig)
                            }
                          >
                            <RefreshCw className="mr-1 h-3.5 w-3.5" />
                            {t("balance.refresh")}
                          </Button>
                          {!source.primary && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={pairedClient}
                              onClick={() => void setPrimaryBalance(source.id)}
                            >
                              {t("balance.makePrimary")}
                            </Button>
                          )}
                        </div>
                      </div>
                      <details className="mt-3 text-xs">
                        <summary className="cursor-pointer text-muted-foreground">
                          {t("balance.audit")}
                        </summary>
                        <dl className="mt-2 grid gap-1 rounded bg-muted/30 p-2">
                          <div>
                            <dt className="inline text-muted-foreground">
                              {t("balance.sourceId")}:{" "}
                            </dt>
                            <dd className="inline break-all">{source.id}</dd>
                          </div>
                          <div>
                            <dt className="inline text-muted-foreground">
                              {t("balance.credential")}:{" "}
                            </dt>
                            <dd className="inline break-all">{source.credentialFingerprint}</dd>
                          </div>
                          <div>
                            <dt className="inline text-muted-foreground">
                              {t("balance.fetchedAt")}:{" "}
                            </dt>
                            <dd className="inline">
                              {snapshot ? new Date(snapshot.fetchedAt).toLocaleString() : "—"}
                            </dd>
                          </div>
                          {source.scriptConfig?.grants.map((grant) => (
                            <div key={grant.domain}>
                              <dt className="inline text-muted-foreground">
                                {t("balance.grant")}:{" "}
                              </dt>
                              <dd className="inline">
                                {grant.domain} ·{" "}
                                {t("balance.grantPolicy", {
                                  https: t("balance.policyHttps"),
                                  http: grant.allowHttp ? t("balance.policyHttp") : "",
                                  private: grant.allowPrivate ? t("balance.policyPrivate") : "",
                                })}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </details>
                    </div>
                  )
                })}
                <details className="rounded-lg border p-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    {t("balance.addScript")}
                  </summary>
                  <div className="mt-3 grid gap-3">
                    <div className="grid gap-3 @md:grid-cols-2">
                      <div>
                        <Label htmlFor="balance-script-label">{t("balance.scriptLabel")}</Label>
                        <Input
                          id="balance-script-label"
                          value={scriptLabel}
                          disabled={pairedClient}
                          onChange={(event) => setScriptLabel(event.target.value)}
                        />
                      </div>
                      <div>
                        <Label htmlFor="balance-script-origin">{t("balance.scriptOrigin")}</Label>
                        <Input
                          id="balance-script-origin"
                          value={scriptOrigin}
                          disabled={pairedClient}
                          onChange={(event) => setScriptOrigin(event.target.value)}
                        />
                      </div>
                    </div>
                    <div>
                      <Label htmlFor="balance-script-token">{t("balance.scriptToken")}</Label>
                      <Input
                        id="balance-script-token"
                        type="password"
                        value={scriptToken}
                        disabled={pairedClient}
                        onChange={(event) => setScriptToken(event.target.value)}
                        autoComplete="off"
                      />
                      <p className="text-xs text-muted-foreground">
                        {t("balance.scriptTokenHint")}
                      </p>
                    </div>
                    <div>
                      <Label htmlFor="balance-script-code">{t("balance.scriptCode")}</Label>
                      <Textarea
                        id="balance-script-code"
                        className="min-h-40 font-mono text-xs"
                        value={scriptCode}
                        disabled={pairedClient}
                        onChange={(event) => setScriptCode(event.target.value)}
                      />
                    </div>
                    <div>
                      <Label htmlFor="balance-script-domain">{t("balance.grantDomain")}</Label>
                      <Input
                        id="balance-script-domain"
                        value={grantDomain}
                        disabled={pairedClient}
                        onChange={(event) => setGrantDomain(event.target.value)}
                        placeholder={t("balance.grantOptional")}
                      />
                    </div>
                    <div className="flex flex-wrap gap-4">
                      <label className="flex items-center gap-2 text-xs">
                        <Switch
                          checked={grantHttp}
                          disabled={pairedClient}
                          onCheckedChange={setGrantHttp}
                        />
                        {t("balance.allowHttp")}
                      </label>
                      <label className="flex items-center gap-2 text-xs">
                        <Switch
                          checked={grantPrivate}
                          disabled={pairedClient}
                          onCheckedChange={setGrantPrivate}
                        />
                        {t("balance.allowPrivate")}
                      </label>
                    </div>
                    {sourceConfigError && (
                      <p className="text-xs text-destructive">{sourceConfigError}</p>
                    )}
                    <Button disabled={pairedClient} onClick={() => void saveSandboxBalanceSource()}>
                      {t("balance.saveScript")}
                    </Button>
                  </div>
                </details>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Server className="h-4 w-4" />
                  {t("endpoints.title")}
                </CardTitle>
                <CardDescription>{t("endpoints.description")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex gap-2">
                  <Input
                    value={customEndpoint}
                    disabled={pairedClient}
                    onChange={(event) => setCustomEndpoint(event.target.value)}
                    placeholder={t("endpoints.placeholder")}
                  />
                  <Button
                    variant="outline"
                    disabled={pairedClient}
                    onClick={() => setCustomEndpoint(customEndpoint.trim())}
                  >
                    {t("endpoints.add")}
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="outline"
                    onClick={() => void compareEndpointsFree()}
                    disabled={pairedClient || endpointComparing || endpointCandidates.length === 0}
                  >
                    {endpointComparing && (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                    )}
                    {t("endpoints.compareFree")}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void preparePaidEndpointComparison()}
                    disabled={pairedClient || !modelId || endpointCandidates.length === 0}
                  >
                    {t("endpoints.comparePaid")}
                  </Button>
                </div>
                {endpointError && <p className="text-xs text-destructive">{endpointError}</p>}
                <div className="space-y-2">
                  {endpointCandidates.map((candidate) => {
                    const comparison = endpointComparisons.find(
                      (row) => row.endpoint === candidate.url
                    )
                    return (
                      <div
                        key={candidate.id}
                        className="flex items-center justify-between gap-2 rounded-lg border p-2"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-xs font-medium">{candidate.url}</p>
                          <p className="text-[10px] text-muted-foreground">
                            {t(`endpoints.source.${candidate.source}` as never)}
                            {comparison ? ` · ${formatMs(comparison.probe.durationMs)}` : ""}
                          </p>
                        </div>
                        <div className="flex items-center gap-1">
                          {comparison?.recommended && <Badge>{t("endpoints.recommended")}</Badge>}
                          {candidate.url === baseUrl ? (
                            <Badge variant="secondary">{t("endpoints.current")}</Badge>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={
                                pairedClient ||
                                (comparison
                                  ? !comparison.probe.capabilityVerified ||
                                    comparison.probe.authenticated === false
                                  : false)
                              }
                              onClick={() => setPendingEndpoint(candidate.url)}
                            >
                              {t("endpoints.apply")}
                            </Button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
                {endpointChanges
                  .filter((change) => !change.rolledBackAt)
                  .slice(0, 3)
                  .map((change) => (
                    <Button
                      key={change.id}
                      variant="ghost"
                      size="sm"
                      disabled={pairedClient}
                      className="w-full justify-start"
                      onClick={() => void rollbackProviderEndpoint(change.id)}
                    >
                      <RotateCcw className="mr-2 h-3.5 w-3.5" />
                      {t("endpoints.rollback", { endpoint: change.previousEndpoint })}
                    </Button>
                  ))}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="flex-row items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <History className="h-4 w-4" />
                  {t("history.title")}
                </CardTitle>
                <CardDescription>{t("history.description")}</CardDescription>
              </div>
              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={t("history.exportJson")}
                  onClick={() => void exportHistory()}
                >
                  <Download className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={t("history.clear")}
                  disabled={pairedClient}
                  onClick={() => void clearProviderDiagnosticHistory({ providerId })}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {visibleSamples.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {t("history.empty")}
                </p>
              ) : (
                <>
                  <div
                    className="mb-4 flex h-28 items-end gap-1 rounded-lg border bg-muted/20 p-3"
                    role="img"
                    aria-label={t("history.chartAria")}
                  >
                    {trendSamples.map((sample) => {
                      const duration =
                        sample.metrics?.totalDurationMs ?? sample.probe?.durationMs ?? 0
                      return (
                        <div
                          key={sample.id}
                          className="min-w-1 flex-1 rounded-t bg-primary/70"
                          style={{ height: `${Math.max(4, (duration / maxTrendDuration) * 100)}%` }}
                          title={`${sample.modelId ?? t("composer.probe")}: ${formatMs(duration)}`}
                        />
                      )
                    })}
                  </div>
                  <div className="space-y-2">
                    {visibleSamples.slice(0, 20).map((sample) => (
                      <div
                        key={sample.id}
                        className="grid grid-cols-[1fr_auto] gap-2 rounded border p-2 text-xs"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium">
                            {sample.modelId ?? t("composer.probe")} · {sample.endpoint}
                          </p>
                          <p className="text-muted-foreground">
                            {new Date(sample.startedAt).toLocaleString()} · {sample.capability} ·{" "}
                            {sample.credentialFingerprint}
                          </p>
                        </div>
                        <span>
                          {formatMs(sample.metrics?.totalDurationMs ?? sample.probe?.durationMs)}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </main>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirm.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("confirm.description", {
                requests: requestCount,
                cost: unknownCost ? t("confirm.unknownCost") : `$${estimatedCost.toFixed(6)}`,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-lg border p-3 text-sm">
            <p>
              {t("confirm.limits", {
                tokens: preferences.maxOutputTokens,
                requests: preferences.maxRequestsPerJob,
                budget: preferences.maxEstimatedCostUsd,
              })}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{t("confirm.noFallback")}</p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("confirm.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void runConfirmed()}>
              {capability === "probe" ? t("confirm.runFree") : t("confirm.runPaid")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={pendingEndpoint !== null}
        onOpenChange={(open) => !open && setPendingEndpoint(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("endpoints.diffTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("endpoints.diffDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-2 rounded-lg border p-3 text-sm">
            <div>
              <span className="text-muted-foreground">{t("endpoints.before")}: </span>
              <code className="break-all">{baseUrl}</code>
            </div>
            <div>
              <span className="text-muted-foreground">{t("endpoints.after")}: </span>
              <code className="break-all">{pendingEndpoint}</code>
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("confirm.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingEndpoint) void applyEndpoint(pendingEndpoint)
                setPendingEndpoint(null)
              }}
            >
              {t("endpoints.confirmApply")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default ProviderDiagnosticsTab
