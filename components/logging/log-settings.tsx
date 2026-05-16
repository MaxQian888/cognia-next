"use client"

/**
 * LogSettings - Configuration UI for the unified logging system
 *
 * Allows users to configure log levels, transports, and retention policies.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Save,
  RotateCcw,
  Database,
  Cloud,
  Monitor,
  AlertTriangle,
  Info,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  Radio,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Separator } from "@/components/ui/separator"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { useTransportHealth } from "@/hooks/logging"
import {
  applyLoggingSettings,
  getLoggingBootstrapState,
  LOGGING_SAMPLING_STORAGE_KEY,
  configureSampling,
  type LogLevel,
  type LoggingTransportSettings,
  type UnifiedLoggerConfig,
} from "@/lib/logger"

export interface LogSettingsProps {
  className?: string
}

const LOG_LEVELS: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"]
const DEFAULT_SAMPLING_RULES = [
  { modulePrefix: "mouse", percentage: 1 },
  { modulePrefix: "keyboard", percentage: 10 },
  { modulePrefix: "scroll", percentage: 5 },
  { modulePrefix: "animation", percentage: 1 },
  { modulePrefix: "error", percentage: 100 },
]

interface SamplingRule {
  modulePrefix: string
  percentage: number
}

function loadSamplingRules(): SamplingRule[] {
  if (typeof window === "undefined") {
    return DEFAULT_SAMPLING_RULES
  }

  const raw = window.localStorage.getItem(LOGGING_SAMPLING_STORAGE_KEY)
  if (!raw) {
    return DEFAULT_SAMPLING_RULES
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, number>
    const rules = Object.entries(parsed)
      .filter(([modulePrefix, rate]) => modulePrefix.trim().length > 0 && typeof rate === "number")
      .map(([modulePrefix, rate]) => ({
        modulePrefix,
        percentage: Math.max(0, Math.min(100, Math.round(rate * 100))),
      }))
    return rules.length > 0 ? rules : DEFAULT_SAMPLING_RULES
  } catch {
    return DEFAULT_SAMPLING_RULES
  }
}

function persistSamplingRules(rules: SamplingRule[]): void {
  if (typeof window === "undefined") {
    return
  }

  const config = Object.fromEntries(
    rules
      .filter((rule) => rule.modulePrefix.trim().length > 0)
      .map((rule) => [rule.modulePrefix.trim(), { rate: rule.percentage / 100 }])
  ) as Parameters<typeof configureSampling>[0]
  window.localStorage.setItem(
    LOGGING_SAMPLING_STORAGE_KEY,
    JSON.stringify(
      Object.fromEntries(
        rules
          .filter((rule) => rule.modulePrefix.trim().length > 0)
          .map((rule) => [rule.modulePrefix.trim(), rule.percentage / 100])
      )
    )
  )
  configureSampling(config)
}

export function LogSettings({ className }: LogSettingsProps) {
  const t = useTranslations("logging")
  const bootstrapState = getLoggingBootstrapState()
  // Cognia mirrors langfuse / OTel keys into a global observability settings
  // store; cognia-next has no such store yet, so the panel relies entirely on
  // the localStorage-backed bootstrap state. When an observability store
  // lands, plug it in here.
  const { nativeLogging } = useTransportHealth({
    autoRefresh: true,
    refreshInterval: 3000,
  })

  // Initialize config from current logger settings
  const [config, setConfig] = useState<Partial<UnifiedLoggerConfig>>(() => {
    const currentConfig = bootstrapState.config
    return {
      minLevel: currentConfig.minLevel,
      includeStackTrace: currentConfig.includeStackTrace,
      includeSource: currentConfig.includeSource,
      bufferSize: currentConfig.bufferSize,
      flushInterval: currentConfig.flushInterval,
      remoteEndpoint: currentConfig.remoteEndpoint,
      remoteQueueMaxEntries: currentConfig.remoteQueueMaxEntries,
      remoteQueueMaxBytes: currentConfig.remoteQueueMaxBytes,
      diagnosticRateLimitMs: currentConfig.diagnosticRateLimitMs,
      redaction: {
        ...currentConfig.redaction,
      },
    }
  })

  const [hasChanges, setHasChanges] = useState(false)
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle")

  // Transport settings (stored separately)
  const [transports, setTransports] = useState<LoggingTransportSettings>(() => ({
    ...bootstrapState.transports,
    remoteConfig: {
      ...bootstrapState.transports.remoteConfig,
      endpoint:
        bootstrapState.transports.remoteConfig.endpoint ||
        bootstrapState.config.remoteEndpoint ||
        "",
    },
    langfuseConfig: {
      ...bootstrapState.transports.langfuseConfig,
      publicKey: bootstrapState.transports.langfuseConfig.publicKey || "",
      secretKey: bootstrapState.transports.langfuseConfig.secretKey || "",
      host: bootstrapState.transports.langfuseConfig.host || "https://cloud.langfuse.com",
    },
    opentelemetryConfig: {
      ...bootstrapState.transports.opentelemetryConfig,
      endpoint:
        bootstrapState.transports.opentelemetryConfig.endpoint || "http://localhost:4318/v1/traces",
      serviceName: bootstrapState.transports.opentelemetryConfig.serviceName || "cognia-ai",
    },
  }))
  const [transportExpanded, setTransportExpanded] = useState<
    Record<"console" | "indexedDB" | "native" | "remote" | "langfuse" | "opentelemetry", boolean>
  >({
    console: bootstrapState.transports.console,
    indexedDB: bootstrapState.transports.indexedDB,
    native: bootstrapState.transports.native,
    remote: bootstrapState.transports.remote,
    langfuse: bootstrapState.transports.langfuse,
    opentelemetry: bootstrapState.transports.opentelemetry,
  })

  // Retention settings
  const [retention, setRetention] = useState(() => bootstrapState.retention)
  const [samplingRules, setSamplingRules] = useState<SamplingRule[]>(() => loadSamplingRules())
  const [newSamplingRule, setNewSamplingRule] = useState<SamplingRule>({
    modulePrefix: "",
    percentage: 100,
  })

  const handleConfigChange = <K extends keyof UnifiedLoggerConfig>(
    key: K,
    value: UnifiedLoggerConfig[K]
  ) => {
    setConfig((prev) => ({ ...prev, [key]: value }))
    setHasChanges(true)
  }

  const handleTransportChange = (transport: keyof typeof transports, enabled: boolean) => {
    setTransports((prev: typeof transports) => ({ ...prev, [transport]: enabled }))
    if (transport in transportExpanded) {
      setTransportExpanded((prev) => ({
        ...prev,
        [transport as keyof typeof transportExpanded]:
          enabled || prev[transport as keyof typeof transportExpanded],
      }))
    }
    setHasChanges(true)
  }

  const handleTransportDetailChange = <
    TTransport extends "nativeConfig" | "remoteConfig" | "langfuseConfig" | "opentelemetryConfig",
    TKey extends keyof LoggingTransportSettings[TTransport],
  >(
    transport: TTransport,
    key: TKey,
    value: LoggingTransportSettings[TTransport][TKey]
  ) => {
    setTransports((prev) => ({
      ...prev,
      [transport]: {
        ...prev[transport],
        [key]: value,
      },
    }))
    setHasChanges(true)
  }

  const handleRetentionChange = (key: keyof typeof retention, value: number) => {
    setRetention((prev: typeof retention) => ({ ...prev, [key]: value }))
    setHasChanges(true)
  }

  const handleRedactionChange = <K extends keyof NonNullable<UnifiedLoggerConfig["redaction"]>>(
    key: K,
    value: NonNullable<UnifiedLoggerConfig["redaction"]>[K]
  ) => {
    setConfig((prev) => ({
      ...prev,
      redaction: {
        ...bootstrapState.config.redaction,
        ...(prev.redaction || {}),
        [key]: value,
      },
    }))
    setHasChanges(true)
  }

  const handleSave = () => {
    setSaveStatus("saving")

    try {
      const nextConfig = {
        ...config,
        remoteEndpoint: transports.remoteConfig.endpoint,
      }
      const next = applyLoggingSettings({
        config: nextConfig,
        transports,
        retention,
        persist: true,
      })
      persistSamplingRules(samplingRules)
      // Langfuse / OTel credentials are persisted alongside the rest of the
      // logging config via `applyLoggingSettings` (transports payload). Once a
      // global observability store exists, mirror them there as well.
      setConfig({
        minLevel: next.config.minLevel,
        includeStackTrace: next.config.includeStackTrace,
        includeSource: next.config.includeSource,
        bufferSize: next.config.bufferSize,
        flushInterval: next.config.flushInterval,
        remoteEndpoint: next.config.remoteEndpoint,
        remoteQueueMaxEntries: next.config.remoteQueueMaxEntries,
        remoteQueueMaxBytes: next.config.remoteQueueMaxBytes,
        diagnosticRateLimitMs: next.config.diagnosticRateLimitMs,
        redaction: {
          ...next.config.redaction,
        },
      })
      setTransports(next.transports)

      setHasChanges(false)
      setSaveStatus("saved")

      setTimeout(() => setSaveStatus("idle"), 2000)
    } catch {
      setSaveStatus("error")
      setTimeout(() => setSaveStatus("idle"), 3000)
    }
  }

  const handleReset = () => {
    setConfig({
      minLevel: "info",
      includeStackTrace: true,
      includeSource: false,
      bufferSize: 50,
      flushInterval: 5000,
      remoteEndpoint: "",
      remoteQueueMaxEntries: 5000,
      remoteQueueMaxBytes: 10 * 1024 * 1024,
      diagnosticRateLimitMs: 2000,
      redaction: {
        ...bootstrapState.config.redaction,
        enabled: true,
        maxDepth: 8,
      },
    })
    setTransports({
      console: true,
      indexedDB: true,
      native: true,
      remote: false,
      langfuse: false,
      opentelemetry: false,
      nativeConfig: {
        minLevel: "warn",
        batchSize: 10,
        flushInterval: 2000,
      },
      remoteConfig: {
        endpoint: "",
        batchSize: 50,
        flushInterval: 5000,
        maxRetries: 3,
        retryDelay: 1000,
      },
      langfuseConfig: {
        publicKey: "",
        secretKey: "",
        host: "https://cloud.langfuse.com",
        minLevel: "warn",
      },
      opentelemetryConfig: {
        endpoint: "http://localhost:4318/v1/traces",
        serviceName: "cognia-ai",
        addAsSpanEvents: true,
      },
    })
    setTransportExpanded({
      console: true,
      indexedDB: true,
      native: true,
      remote: false,
      langfuse: false,
      opentelemetry: false,
    })
    setSamplingRules(DEFAULT_SAMPLING_RULES)
    setNewSamplingRule({ modulePrefix: "", percentage: 100 })
    setRetention({
      maxEntries: 10000,
      maxAgeDays: 7,
    })
    setHasChanges(true)
  }

  const getSaveButtonText = () => {
    switch (saveStatus) {
      case "saving":
        return t("settings.saving")
      case "saved":
        return t("settings.saved")
      default:
        return t("settings.save")
    }
  }

  const redactionSettings = {
    ...bootstrapState.config.redaction,
    ...(config.redaction || {}),
  }
  const sortedSamplingRules = useMemo(
    () =>
      [...samplingRules].sort((left, right) => left.modulePrefix.localeCompare(right.modulePrefix)),
    [samplingRules]
  )
  const remoteQueueMb = Math.max(
    1,
    Math.round(
      ((config.remoteQueueMaxBytes ?? bootstrapState.config.remoteQueueMaxBytes) || 1024 * 1024) /
        (1024 * 1024)
    )
  )
  const nativeLoggingStatusLabel = t("settings.native.status")
  const nativeLoggingTitle = t("settings.native.title")
  const nativeModeLabel = t("settings.native.mode")
  const nativeBridgeLabel = t("settings.native.bridge")
  const nativeTargetsLabel = t("settings.native.targets")
  const nativeFallbackReasonLabel = t("settings.native.fallbackReason")
  const nativeBridgeErrorLabel = t("settings.native.bridgeError")
  const nativePlatformBackendLabel = t("settings.native.platformBackend")
  const nativePlatformHealthLabel = t("settings.native.platformHealth")
  const nativePlatformLevelLabel = t("settings.native.platformLevel")
  const nativePlatformErrorLabel = t("settings.native.platformError")
  const updateSamplingRule = (modulePrefix: string, percentage: number) => {
    setSamplingRules((prev) =>
      prev.map((rule) => (rule.modulePrefix === modulePrefix ? { ...rule, percentage } : rule))
    )
    setHasChanges(true)
  }
  const removeSamplingRule = (modulePrefix: string) => {
    setSamplingRules((prev) => prev.filter((rule) => rule.modulePrefix !== modulePrefix))
    setHasChanges(true)
  }
  const addSamplingRule = () => {
    const prefix = newSamplingRule.modulePrefix.trim()
    if (!prefix) {
      return
    }
    setSamplingRules((prev) => {
      const existing = prev.find((rule) => rule.modulePrefix === prefix)
      if (existing) {
        return prev.map((rule) =>
          rule.modulePrefix === prefix ? { ...rule, percentage: newSamplingRule.percentage } : rule
        )
      }
      return [...prev, { modulePrefix: prefix, percentage: newSamplingRule.percentage }]
    })
    setNewSamplingRule({ modulePrefix: "", percentage: 100 })
    setHasChanges(true)
  }

  type NativeStatusTone = "success" | "warning" | "danger" | "muted"
  const nativeStatusTone: NativeStatusTone = (() => {
    switch (nativeLogging.status) {
      case "healthy":
        return "success"
      case "degraded":
        return "warning"
      case "inactive":
        return "muted"
      default:
        return "muted"
    }
  })()
  const nativeStatusToneClasses: Record<NativeStatusTone, string> = {
    success: "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300",
    warning: "border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-300",
    danger: "border-destructive/50 bg-destructive/5 text-destructive",
    muted: "border-border bg-muted/30 text-muted-foreground",
  }
  const tabLabels = {
    levels: t("settings.tabs.levels"),
    transports: t("settings.tabs.transports"),
    advanced: t("settings.tabs.advanced"),
    retention: t("settings.tabs.retention"),
  }
  const unsavedLabel = t("settings.unsavedChanges")

  return (
    <div className={cn("relative space-y-4 sm:space-y-6 pb-20", className)}>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h2 className="text-base sm:text-lg font-semibold">{t("settingsTitle")}</h2>
          <p className="text-xs sm:text-sm text-muted-foreground">{t("settingsDescription")}</p>
        </div>
        {hasChanges && (
          <Badge variant="outline" className="self-start text-xs">
            {unsavedLabel}
          </Badge>
        )}
      </div>

      <Tabs defaultValue="levels" className="gap-4">
        <TabsList className="flex flex-wrap h-auto gap-1 p-1 bg-muted rounded-lg">
          <TabsTrigger value="levels" className="text-xs sm:text-sm">
            {tabLabels.levels}
          </TabsTrigger>
          <TabsTrigger value="transports" className="text-xs sm:text-sm">
            {tabLabels.transports}
          </TabsTrigger>
          <TabsTrigger value="advanced" className="text-xs sm:text-sm">
            {tabLabels.advanced}
          </TabsTrigger>
          <TabsTrigger value="retention" className="text-xs sm:text-sm">
            {tabLabels.retention}
          </TabsTrigger>
        </TabsList>

        {/* Levels & Sampling */}
        <TabsContent
          value="levels"
          forceMount
          className="mt-0 space-y-4 data-[state=inactive]:hidden"
        >
          {/* Log Level Settings */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                {t("settings.logLevel.title")}
              </CardTitle>
              <CardDescription>{t("settings.logLevel.description")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                <Label className="sm:w-32 text-sm">{t("settings.logLevel.minLevel")}</Label>
                <Select
                  value={config.minLevel}
                  onValueChange={(value) => handleConfigChange("minLevel", value as LogLevel)}
                >
                  <SelectTrigger className="w-full sm:w-[180px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOG_LEVELS.map((level) => (
                      <SelectItem key={level} value={level}>
                        <div className="flex flex-col">
                          <span className="capitalize">{t(`settings.logLevel.${level}`)}</span>
                          <span className="text-xs text-muted-foreground">
                            {t(`settings.logLevel.${level}Desc`)}
                          </span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Separator />

              <div className="space-y-3">
                <div className="flex items-start sm:items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <Label className="text-sm">{t("settings.options.includeStackTrace")}</Label>
                    <p className="text-xs text-muted-foreground">
                      {t("settings.options.includeStackTraceDesc")}
                    </p>
                  </div>
                  <Switch
                    checked={config.includeStackTrace}
                    onCheckedChange={(checked) => handleConfigChange("includeStackTrace", checked)}
                    className="shrink-0"
                  />
                </div>

                <div className="flex items-start sm:items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <Label className="text-sm">{t("settings.options.includeSource")}</Label>
                    <p className="text-xs text-muted-foreground">
                      {t("settings.options.includeSourceDesc")}
                    </p>
                  </div>
                  <Switch
                    checked={config.includeSource}
                    onCheckedChange={(checked) => handleConfigChange("includeSource", checked)}
                    className="shrink-0"
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Transports */}
        <TabsContent
          value="transports"
          forceMount
          className="mt-0 space-y-4 data-[state=inactive]:hidden"
        >
          {/* Native logging readiness — compact status banner */}
          <div
            className={cn(
              "rounded-lg border px-3 py-2 text-sm",
              nativeStatusToneClasses[nativeStatusTone]
            )}
            role="status"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <Monitor className="h-4 w-4 shrink-0" />
              <span className="font-medium truncate">{nativeLoggingTitle}</span>
              <Badge
                variant="outline"
                className="text-[10px] uppercase tracking-wide bg-background/60"
              >
                {nativeLogging.status}
              </Badge>
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <span>{nativeModeLabel}:</span>
                <span>{nativeLogging.startupMode}</span>
                <span aria-hidden>·</span>
                <span>{nativeBridgeLabel}:</span>
                <span>{nativeLogging.bridgeState}</span>
              </span>
            </div>
            <div className="mt-1 grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <span>
                <span className="font-medium">{nativeTargetsLabel}: </span>
                {nativeLogging.activeTargets.length > 0
                  ? nativeLogging.activeTargets.join(", ")
                  : t("panel.nativeLoggingNoTargets")}
              </span>
              <span>
                <span className="font-medium">{nativePlatformBackendLabel}: </span>
                {nativeLogging.platformLogging.backend}
              </span>
              <span>
                <span className="font-medium">{nativePlatformHealthLabel}: </span>
                {nativeLogging.platformLogging.health}
              </span>
              <span>
                <span className="font-medium">{nativePlatformLevelLabel}: </span>
                {nativeLogging.platformLogging.minLevel}
              </span>
              <span>
                <span className="font-medium">{nativeLoggingStatusLabel}: </span>
                {nativeLogging.status}
              </span>
            </div>
            {(nativeLogging.fallbackReason?.message ||
              nativeLogging.platformLogging.error ||
              nativeLogging.bridgeLastError) && (
              <div className="mt-2 space-y-1 text-xs">
                {nativeLogging.fallbackReason?.message && (
                  <p className="flex items-start gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>
                      <span className="font-medium">{nativeFallbackReasonLabel}: </span>
                      {nativeLogging.fallbackReason.message}
                    </span>
                  </p>
                )}
                {nativeLogging.platformLogging.error && (
                  <p className="flex items-start gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>
                      <span className="font-medium">{nativePlatformErrorLabel}: </span>
                      {nativeLogging.platformLogging.error}
                    </span>
                  </p>
                )}
                {nativeLogging.bridgeLastError && (
                  <p className="flex items-start gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>
                      <span className="font-medium">{nativeBridgeErrorLabel}: </span>
                      {nativeLogging.bridgeLastError}
                    </span>
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Transport Settings */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Database className="h-4 w-4" />
                {t("settings.transports.title")}
              </CardTitle>
              <CardDescription>{t("settings.transports.description")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {(
                [
                  {
                    key: "console",
                    icon: Monitor,
                    title: t("settings.transports.console"),
                    description: t("settings.transports.consoleDesc"),
                  },
                  {
                    key: "indexedDB",
                    icon: Database,
                    title: t("settings.transports.indexedDB"),
                    description: t("settings.transports.indexedDBDesc"),
                  },
                  {
                    key: "native",
                    icon: Monitor,
                    title: t("settings.transports.native"),
                    description: t("settings.transports.nativeDesc"),
                  },
                  {
                    key: "remote",
                    icon: Cloud,
                    title: t("settings.transports.remote"),
                    description: t("settings.transports.remoteDesc"),
                  },
                  {
                    key: "langfuse",
                    icon: Cloud,
                    title: t("settings.transports.langfuse"),
                    description: t("settings.transports.langfuseDesc"),
                  },
                  {
                    key: "opentelemetry",
                    icon: Cloud,
                    title: t("settings.transports.opentelemetry"),
                    description: t("settings.transports.opentelemetryDesc"),
                  },
                ] as const
              ).map((transportDef) => {
                const Icon = transportDef.icon
                const expanded = transportExpanded[transportDef.key]
                return (
                  <Collapsible
                    key={transportDef.key}
                    open={expanded}
                    onOpenChange={(open) =>
                      setTransportExpanded((prev) => ({ ...prev, [transportDef.key]: open }))
                    }
                  >
                    <div className="rounded-lg border p-3 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-2 flex-1 min-w-0">
                          <Icon className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                          <div className="min-w-0">
                            <Label className="text-sm">{transportDef.title}</Label>
                            <p className="text-xs text-muted-foreground">
                              {transportDef.description}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Switch
                            checked={Boolean(transports[transportDef.key])}
                            onCheckedChange={(checked) =>
                              handleTransportChange(transportDef.key, checked)
                            }
                          />
                          <CollapsibleTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-7 w-7">
                              {expanded ? (
                                <ChevronDown className="h-4 w-4" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )}
                            </Button>
                          </CollapsibleTrigger>
                        </div>
                      </div>
                      <CollapsibleContent className="space-y-4">
                        {transportDef.key === "console" && (
                          <p className="text-xs text-muted-foreground">
                            {t("settings.transports.consoleDetail")}
                          </p>
                        )}
                        {transportDef.key === "indexedDB" && (
                          <p className="text-xs text-muted-foreground">
                            {t("settings.transports.indexedDBDetail")}
                          </p>
                        )}
                        {transportDef.key === "native" && (
                          <div className="grid gap-4 sm:grid-cols-2">
                            <div className="space-y-2">
                              <Label className="text-sm">
                                {t("settings.transports.nativeMinLevel")}
                              </Label>
                              <Select
                                value={transports.nativeConfig.minLevel}
                                onValueChange={(value) =>
                                  handleTransportDetailChange(
                                    "nativeConfig",
                                    "minLevel",
                                    value as LogLevel
                                  )
                                }
                              >
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {LOG_LEVELS.map((level) => (
                                    <SelectItem key={level} value={level}>
                                      {t(`settings.logLevel.${level}`)}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="space-y-2">
                              <div className="flex items-center justify-between gap-2">
                                <Label className="text-sm">
                                  {t("settings.transports.nativeBatchSize")}
                                </Label>
                                <span className="text-xs font-mono">
                                  {transports.nativeConfig.batchSize}
                                </span>
                              </div>
                              <Slider
                                value={[transports.nativeConfig.batchSize]}
                                onValueChange={([value]) =>
                                  handleTransportDetailChange("nativeConfig", "batchSize", value)
                                }
                                min={1}
                                max={100}
                                step={1}
                              />
                            </div>
                            <div className="space-y-2 sm:col-span-2">
                              <div className="flex items-center justify-between gap-2">
                                <Label className="text-sm">
                                  {t("settings.transports.nativeFlushInterval")}
                                </Label>
                                <span className="text-xs font-mono">
                                  {transports.nativeConfig.flushInterval} ms
                                </span>
                              </div>
                              <Slider
                                value={[transports.nativeConfig.flushInterval]}
                                onValueChange={([value]) =>
                                  handleTransportDetailChange(
                                    "nativeConfig",
                                    "flushInterval",
                                    value
                                  )
                                }
                                min={250}
                                max={30000}
                                step={250}
                              />
                            </div>
                          </div>
                        )}
                        {transportDef.key === "remote" && (
                          <div className="grid gap-4 sm:grid-cols-2">
                            <div className="space-y-2 sm:col-span-2">
                              <Label className="text-sm">
                                {t("settings.transports.remoteEndpoint")}
                              </Label>
                              <Input
                                value={transports.remoteConfig.endpoint}
                                onChange={(event) =>
                                  handleTransportDetailChange(
                                    "remoteConfig",
                                    "endpoint",
                                    event.target.value
                                  )
                                }
                                placeholder={t("settings.transports.remoteEndpointPlaceholder")}
                              />
                            </div>
                            <div className="space-y-2">
                              <div className="flex items-center justify-between gap-2">
                                <Label className="text-sm">
                                  {t("settings.transports.remoteBatchSize")}
                                </Label>
                                <span className="text-xs font-mono">
                                  {transports.remoteConfig.batchSize}
                                </span>
                              </div>
                              <Slider
                                value={[transports.remoteConfig.batchSize]}
                                onValueChange={([value]) =>
                                  handleTransportDetailChange("remoteConfig", "batchSize", value)
                                }
                                min={10}
                                max={200}
                                step={10}
                              />
                            </div>
                            <div className="space-y-2">
                              <div className="flex items-center justify-between gap-2">
                                <Label className="text-sm">
                                  {t("settings.transports.remoteFlushInterval")}
                                </Label>
                                <span className="text-xs font-mono">
                                  {transports.remoteConfig.flushInterval} ms
                                </span>
                              </div>
                              <Slider
                                value={[transports.remoteConfig.flushInterval]}
                                onValueChange={([value]) =>
                                  handleTransportDetailChange(
                                    "remoteConfig",
                                    "flushInterval",
                                    value
                                  )
                                }
                                min={1000}
                                max={30000}
                                step={1000}
                              />
                            </div>
                            <div className="space-y-2">
                              <div className="flex items-center justify-between gap-2">
                                <Label className="text-sm">
                                  {t("settings.transports.remoteMaxRetries")}
                                </Label>
                                <span className="text-xs font-mono">
                                  {transports.remoteConfig.maxRetries}
                                </span>
                              </div>
                              <Slider
                                value={[transports.remoteConfig.maxRetries]}
                                onValueChange={([value]) =>
                                  handleTransportDetailChange("remoteConfig", "maxRetries", value)
                                }
                                min={0}
                                max={10}
                                step={1}
                              />
                            </div>
                            <div className="space-y-2">
                              <div className="flex items-center justify-between gap-2">
                                <Label className="text-sm">
                                  {t("settings.transports.remoteRetryDelay")}
                                </Label>
                                <span className="text-xs font-mono">
                                  {transports.remoteConfig.retryDelay} ms
                                </span>
                              </div>
                              <Slider
                                value={[transports.remoteConfig.retryDelay]}
                                onValueChange={([value]) =>
                                  handleTransportDetailChange("remoteConfig", "retryDelay", value)
                                }
                                min={500}
                                max={10000}
                                step={500}
                              />
                            </div>
                          </div>
                        )}
                        {transportDef.key === "langfuse" && (
                          <div className="grid gap-4 sm:grid-cols-2">
                            <div className="space-y-2">
                              <Label className="text-sm">
                                {t("settings.transports.langfusePublicKey")}
                              </Label>
                              <Input
                                value={transports.langfuseConfig.publicKey}
                                onChange={(event) =>
                                  handleTransportDetailChange(
                                    "langfuseConfig",
                                    "publicKey",
                                    event.target.value
                                  )
                                }
                                placeholder={t("settings.transports.langfusePublicKeyPlaceholder")}
                              />
                            </div>
                            <div className="space-y-2">
                              <Label className="text-sm">
                                {t("settings.transports.langfuseSecretKey")}
                              </Label>
                              <Input
                                type="password"
                                value={transports.langfuseConfig.secretKey}
                                onChange={(event) =>
                                  handleTransportDetailChange(
                                    "langfuseConfig",
                                    "secretKey",
                                    event.target.value
                                  )
                                }
                                placeholder={t("settings.transports.langfuseSecretKeyPlaceholder")}
                              />
                            </div>
                            <div className="space-y-2 sm:col-span-2">
                              <Label className="text-sm">
                                {t("settings.transports.langfuseHost")}
                              </Label>
                              <Input
                                value={transports.langfuseConfig.host}
                                onChange={(event) =>
                                  handleTransportDetailChange(
                                    "langfuseConfig",
                                    "host",
                                    event.target.value
                                  )
                                }
                                placeholder={t("settings.transports.langfuseHostPlaceholder")}
                              />
                            </div>
                            <div className="space-y-2">
                              <Label className="text-sm">
                                {t("settings.transports.langfuseMinLevel")}
                              </Label>
                              <Select
                                value={transports.langfuseConfig.minLevel}
                                onValueChange={(value) =>
                                  handleTransportDetailChange(
                                    "langfuseConfig",
                                    "minLevel",
                                    value as LogLevel
                                  )
                                }
                              >
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {LOG_LEVELS.map((level) => (
                                    <SelectItem key={level} value={level}>
                                      {t(`settings.logLevel.${level}`)}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          </div>
                        )}
                        {transportDef.key === "opentelemetry" && (
                          <div className="grid gap-4 sm:grid-cols-2">
                            <div className="space-y-2 sm:col-span-2">
                              <Label className="text-sm">
                                {t("settings.transports.otelEndpoint")}
                              </Label>
                              <Input
                                value={transports.opentelemetryConfig.endpoint}
                                onChange={(event) =>
                                  handleTransportDetailChange(
                                    "opentelemetryConfig",
                                    "endpoint",
                                    event.target.value
                                  )
                                }
                                placeholder={t("settings.transports.otelEndpointPlaceholder")}
                              />
                            </div>
                            <div className="space-y-2">
                              <Label className="text-sm">
                                {t("settings.transports.otelServiceName")}
                              </Label>
                              <Input
                                value={transports.opentelemetryConfig.serviceName}
                                onChange={(event) =>
                                  handleTransportDetailChange(
                                    "opentelemetryConfig",
                                    "serviceName",
                                    event.target.value
                                  )
                                }
                                placeholder={t("settings.transports.otelServiceNamePlaceholder")}
                              />
                            </div>
                            <div className="space-y-2">
                              <div className="flex items-start justify-between gap-3 rounded-md border p-3">
                                <div>
                                  <Label className="text-sm">
                                    {t("settings.transports.otelAddAsSpanEvents")}
                                  </Label>
                                  <p className="text-xs text-muted-foreground">
                                    {t("settings.transports.otelAddAsSpanEventsDesc")}
                                  </p>
                                </div>
                                <Switch
                                  checked={transports.opentelemetryConfig.addAsSpanEvents}
                                  onCheckedChange={(checked) =>
                                    handleTransportDetailChange(
                                      "opentelemetryConfig",
                                      "addAsSpanEvents",
                                      checked
                                    )
                                  }
                                />
                              </div>
                            </div>
                          </div>
                        )}
                      </CollapsibleContent>
                    </div>
                  </Collapsible>
                )
              })}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Advanced */}
        <TabsContent
          value="advanced"
          forceMount
          className="mt-0 space-y-4 data-[state=inactive]:hidden"
        >
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                {t("settings.advanced.title")}
              </CardTitle>
              <CardDescription>{t("settings.advanced.description")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 sm:space-y-6">
              <div className="space-y-3">
                <div className="flex items-start sm:items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <Label className="text-sm">{t("settings.advanced.redactionEnabled")}</Label>
                    <p className="text-xs text-muted-foreground">
                      {t("settings.advanced.redactionEnabledDesc")}
                    </p>
                  </div>
                  <Switch
                    checked={redactionSettings.enabled}
                    onCheckedChange={(checked) => handleRedactionChange("enabled", checked)}
                    className="shrink-0"
                  />
                </div>
              </div>

              <Separator />

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-sm">{t("settings.advanced.redactionDepth")}</Label>
                  <span className="text-xs sm:text-sm font-mono shrink-0">
                    {redactionSettings.maxDepth}
                  </span>
                </div>
                <Slider
                  value={[redactionSettings.maxDepth]}
                  onValueChange={([value]) => handleRedactionChange("maxDepth", value)}
                  min={1}
                  max={16}
                  step={1}
                  className="touch-none"
                />
                <p className="text-xs text-muted-foreground">
                  {t("settings.advanced.redactionDepthDesc")}
                </p>
              </div>

              <Separator />

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-sm">{t("settings.advanced.remoteQueueEntries")}</Label>
                  <span className="text-xs sm:text-sm font-mono shrink-0">
                    {(
                      config.remoteQueueMaxEntries ?? bootstrapState.config.remoteQueueMaxEntries
                    )?.toLocaleString()}
                  </span>
                </div>
                <Slider
                  value={[
                    config.remoteQueueMaxEntries ?? bootstrapState.config.remoteQueueMaxEntries,
                  ]}
                  onValueChange={([value]) => handleConfigChange("remoteQueueMaxEntries", value)}
                  min={100}
                  max={20000}
                  step={100}
                  className="touch-none"
                />
                <p className="text-xs text-muted-foreground">
                  {t("settings.advanced.remoteQueueEntriesDesc")}
                </p>
              </div>

              <Separator />

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-sm">{t("settings.advanced.remoteQueueBytes")}</Label>
                  <span className="text-xs sm:text-sm font-mono shrink-0">{remoteQueueMb} MB</span>
                </div>
                <Slider
                  value={[remoteQueueMb]}
                  onValueChange={([value]) =>
                    handleConfigChange("remoteQueueMaxBytes", value * 1024 * 1024)
                  }
                  min={1}
                  max={50}
                  step={1}
                  className="touch-none"
                />
                <p className="text-xs text-muted-foreground">
                  {t("settings.advanced.remoteQueueBytesDesc")}
                </p>
              </div>

              <Separator />

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-sm">{t("settings.advanced.diagnosticRateLimit")}</Label>
                  <span className="text-xs sm:text-sm font-mono shrink-0">
                    {config.diagnosticRateLimitMs ?? bootstrapState.config.diagnosticRateLimitMs} ms
                  </span>
                </div>
                <Slider
                  value={[
                    config.diagnosticRateLimitMs ?? bootstrapState.config.diagnosticRateLimitMs,
                  ]}
                  onValueChange={([value]) => handleConfigChange("diagnosticRateLimitMs", value)}
                  min={250}
                  max={10000}
                  step={250}
                  className="touch-none"
                />
                <p className="text-xs text-muted-foreground">
                  {t("settings.advanced.diagnosticRateLimitDesc")}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Radio className="h-4 w-4" />
                {t("settings.sampling.title")}
              </CardTitle>
              <CardDescription>{t("settings.sampling.description")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3">
                {sortedSamplingRules.map((rule) => (
                  <div key={rule.modulePrefix} className="rounded-lg border p-3 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium font-mono">{rule.modulePrefix}</p>
                        <p className="text-xs text-muted-foreground">
                          {t("settings.sampling.ruleDescription")}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeSamplingRule(rule.modulePrefix)}
                        aria-label={`${t("settings.sampling.removeRule")} ${rule.modulePrefix}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <Label className="text-sm">{t("settings.sampling.percentage")}</Label>
                        <span className="text-xs font-mono">{rule.percentage}%</span>
                      </div>
                      <Slider
                        value={[rule.percentage]}
                        onValueChange={([value]) => updateSamplingRule(rule.modulePrefix, value)}
                        min={0}
                        max={100}
                        step={1}
                      />
                    </div>
                  </div>
                ))}
              </div>

              <Separator />

              <div className="rounded-lg border border-dashed p-3 space-y-3">
                <div className="grid gap-3 sm:grid-cols-[1fr,220px,auto] sm:items-end">
                  <div className="space-y-2">
                    <Label className="text-sm">{t("settings.sampling.modulePrefix")}</Label>
                    <Input
                      value={newSamplingRule.modulePrefix}
                      onChange={(event) =>
                        setNewSamplingRule((prev) => ({
                          ...prev,
                          modulePrefix: event.target.value,
                        }))
                      }
                      placeholder={t("settings.sampling.modulePrefixPlaceholder")}
                    />
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <Label className="text-sm">{t("settings.sampling.percentage")}</Label>
                      <span className="text-xs font-mono">{newSamplingRule.percentage}%</span>
                    </div>
                    <Slider
                      value={[newSamplingRule.percentage]}
                      onValueChange={([value]) =>
                        setNewSamplingRule((prev) => ({ ...prev, percentage: value }))
                      }
                      min={0}
                      max={100}
                      step={1}
                    />
                  </div>
                  <Button onClick={addSamplingRule} className="sm:self-end">
                    <Plus className="h-4 w-4 mr-1" />
                    {t("settings.sampling.addRule")}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Retention & Export */}
        <TabsContent
          value="retention"
          forceMount
          className="mt-0 space-y-4 data-[state=inactive]:hidden"
        >
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Database className="h-4 w-4" />
                {t("settings.retention.title")}
              </CardTitle>
              <CardDescription>{t("settings.retention.description")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 sm:space-y-6">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-sm">{t("settings.retention.maxEntries")}</Label>
                  <span className="text-xs sm:text-sm font-mono shrink-0">
                    {retention.maxEntries.toLocaleString()}
                  </span>
                </div>
                <Slider
                  value={[retention.maxEntries]}
                  onValueChange={([value]) => handleRetentionChange("maxEntries", value)}
                  min={1000}
                  max={100000}
                  step={1000}
                  className="touch-none"
                />
                <p className="text-xs text-muted-foreground">
                  {t("settings.retention.maxEntriesDesc")}
                </p>
              </div>

              <Separator />

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-sm">{t("settings.retention.maxAgeDays")}</Label>
                  <span className="text-xs sm:text-sm font-mono shrink-0">
                    {retention.maxAgeDays} {t("settings.retention.days")}
                  </span>
                </div>
                <Slider
                  value={[retention.maxAgeDays]}
                  onValueChange={([value]) => handleRetentionChange("maxAgeDays", value)}
                  min={1}
                  max={30}
                  step={1}
                  className="touch-none"
                />
                <p className="text-xs text-muted-foreground">
                  {t("settings.retention.maxAgeDaysDesc")}
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Performance Note */}
          <Alert>
            <Info className="h-4 w-4" />
            <AlertTitle>{t("settings.performanceNote.title")}</AlertTitle>
            <AlertDescription>{t("settings.performanceNote.description")}</AlertDescription>
          </Alert>
        </TabsContent>
      </Tabs>

      {/* Sticky save/reset bar — always visible, dirty-state indicator only when there are changes */}
      <div
        className={cn(
          "sticky bottom-0 left-0 right-0 z-10 -mx-2 sm:-mx-0 px-3 py-2 bg-background/95 backdrop-blur border-t border-border rounded-b-lg flex items-center justify-between gap-2",
          hasChanges ? "shadow-sm" : "opacity-90"
        )}
        data-testid="log-settings-save-bar"
        data-dirty={hasChanges ? "true" : "false"}
        role="region"
        aria-label={unsavedLabel}
      >
        <div className="flex items-center gap-2 text-xs sm:text-sm min-h-6">
          {hasChanges && (
            <>
              <span className="h-2 w-2 rounded-full bg-amber-500" aria-hidden />
              <span className="text-muted-foreground">{unsavedLabel}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleReset}
            disabled={saveStatus === "saving"}
          >
            <RotateCcw className="h-4 w-4 mr-1" />
            {t("settings.reset")}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!hasChanges || saveStatus === "saving"}>
            <Save className="h-4 w-4 mr-1" />
            {getSaveButtonText()}
          </Button>
        </div>
      </div>
    </div>
  )
}

export default LogSettings
