"use client"

/**
 * Draft state for Settings → Observability → Logs.
 *
 * The logging panel edits five unrelated stores at once — the unified logger
 * config, the transport settings, the retention policy, the module sampling
 * map, and the behaviour-telemetry consent record — and commits them together.
 * That state used to live inline in a 2 300-line component, which is why it
 * could only ever be one screen. Hoisting it here lets the section render a
 * master/detail pane whose panels are plain presentational components.
 *
 * Two behaviours are deliberately different from the inline version:
 *
 * - **Sampling starts empty.** `loadSamplingRules()` returns `[]` when nothing
 *   is stored, matching `applySamplingSettings()`, which configures nothing in
 *   that case. The old code seeded five rules into the UI that the runtime had
 *   never applied, so the panel showed sampling that was not happening.
 *   `RECOMMENDED_SAMPLING_RATES` is now offered as an explicit action instead.
 *
 * - **Reset restores the real defaults.** It reuses the exported
 *   `DEFAULT_*` records rather than a hand-copied second opinion that had
 *   drifted (remote/Langfuse reset to off when they ship on; minLevel,
 *   bufferSize, flushInterval and includeSource all differed).
 */

import { useCallback, useMemo, useState } from "react"

import {
  applyLoggingSettings,
  configureSampling,
  getLoggingBootstrapState,
  DEFAULT_RETENTION_SETTINGS,
  DEFAULT_TRANSPORT_SETTINGS,
  LOGGING_SAMPLING_STORAGE_KEY,
  RECOMMENDED_SAMPLING_RATES,
  type LogLevel,
  type LoggingRetentionSettings,
  type LoggingTransportSettings,
  type UnifiedLoggerConfig,
} from "@/lib/logging"
import { clearTelemetrySecret, persistTelemetrySecret } from "@/lib/logging/telemetry-secrets"
import { DEFAULT_UNIFIED_CONFIG } from "@/types/logging"
import {
  DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS,
  getBehaviorTelemetrySettings,
  saveBehaviorTelemetrySettings,
  type BehaviorTelemetrySettings,
} from "@/lib/telemetry/events/settings"
import { trackEvent } from "@/lib/telemetry/events/track-event"
import { useSettingsStore } from "@/stores/settings"

/* ── Types ──────────────────────────────────────────────────────────────── */

export interface SamplingRule {
  modulePrefix: string
  /** Percentage in the inclusive range 0..100 (the stored form is a 0..1 rate). */
  percentage: number
}

/** The slice of the unified config this panel is allowed to edit. */
export type LogConfigDraft = Pick<
  UnifiedLoggerConfig,
  | "minLevel"
  | "includeStackTrace"
  | "includeSource"
  | "perModuleLevels"
  | "bufferSize"
  | "flushInterval"
  | "remoteEndpoint"
  | "remoteQueueMaxEntries"
  | "remoteQueueMaxBytes"
  | "diagnosticRateLimitMs"
  | "redaction"
>

export type SecretKind = "langfuseSecretKey" | "grafanaCloudApiToken"

/** Matches `UnsavedBarStatus`; a failed save surfaces through `saveError`. */
export type LogSettingsSaveStatus = "clean" | "dirty" | "saving" | "saved"

export const TRANSPORT_KEYS = [
  "console",
  "indexedDB",
  "native",
  "remote",
  "langfuse",
  "agentTrace",
  "agentTraceOtlp",
] as const

export type TransportKey = (typeof TRANSPORT_KEYS)[number]

export const DEFAULT_POSTHOG_CONFIG: LoggingTransportSettings["posthogConfig"] = {
  managed: { productAnalytics: false, aiObservability: false },
  byo: { productAnalytics: false, aiObservability: false, host: "", projectToken: "" },
}

/* ── Sampling storage ───────────────────────────────────────────────────── */

/** The recommended preset in the panel's percentage form, sorted for display. */
export const RECOMMENDED_SAMPLING_RULES: readonly SamplingRule[] = Object.entries(
  RECOMMENDED_SAMPLING_RATES
)
  .map(([modulePrefix, rate]) => ({ modulePrefix, percentage: Math.round(rate * 100) }))
  .sort((left, right) => left.modulePrefix.localeCompare(right.modulePrefix))

/**
 * Read the persisted sampling map. Returns `[]` for "nothing configured" —
 * which is what the runtime does with an empty map, so the panel and the
 * logger agree.
 */
export function loadSamplingRules(): SamplingRule[] {
  if (typeof window === "undefined") return []

  const raw = window.localStorage.getItem(LOGGING_SAMPLING_STORAGE_KEY)
  if (!raw) return []

  try {
    const parsed = JSON.parse(raw) as Record<string, number>
    return Object.entries(parsed)
      .filter(([modulePrefix, rate]) => modulePrefix.trim().length > 0 && typeof rate === "number")
      .map(([modulePrefix, rate]) => ({
        modulePrefix,
        percentage: Math.max(0, Math.min(100, Math.round(rate * 100))),
      }))
  } catch {
    return []
  }
}

export function persistSamplingRules(rules: readonly SamplingRule[]): void {
  if (typeof window === "undefined") return

  const entries = rules
    .filter((rule) => rule.modulePrefix.trim().length > 0)
    .map((rule) => [rule.modulePrefix.trim(), rule.percentage / 100] as const)

  window.localStorage.setItem(
    LOGGING_SAMPLING_STORAGE_KEY,
    JSON.stringify(Object.fromEntries(entries))
  )
  configureSampling(
    Object.fromEntries(entries.map(([prefix, rate]) => [prefix, { rate }])) as Parameters<
      typeof configureSampling
    >[0]
  )
}

/* ── Dirty accounting ───────────────────────────────────────────────────── */

interface DraftSnapshot {
  config: LogConfigDraft
  transports: LoggingTransportSettings
  retention: LoggingRetentionSettings
  samplingRules: readonly SamplingRule[]
  behaviorTelemetry: BehaviorTelemetrySettings
}

/**
 * Flatten the draft into one comparable value per user-visible field, so the
 * save bar can say *how many* settings changed instead of a bare "unsaved".
 */
function flattenDraft(draft: DraftSnapshot): Record<string, string> {
  const out: Record<string, string> = {}
  const put = (key: string, value: unknown) => {
    out[key] = JSON.stringify(value ?? null)
  }

  const { config, transports, retention, behaviorTelemetry } = draft

  put("config.minLevel", config.minLevel)
  put("config.includeStackTrace", config.includeStackTrace)
  put("config.includeSource", config.includeSource)
  put(
    "config.perModuleLevels",
    Object.entries(config.perModuleLevels ?? {}).sort(([a], [b]) => a.localeCompare(b))
  )
  put("config.bufferSize", config.bufferSize)
  put("config.flushInterval", config.flushInterval)
  put("config.remoteQueueMaxEntries", config.remoteQueueMaxEntries)
  put("config.remoteQueueMaxBytes", config.remoteQueueMaxBytes)
  put("config.diagnosticRateLimitMs", config.diagnosticRateLimitMs)
  put("config.redaction.enabled", config.redaction?.enabled)
  put("config.redaction.maxDepth", config.redaction?.maxDepth)

  for (const key of TRANSPORT_KEYS) put(`transports.${key}`, transports[key])
  put("transports.nativeConfig", transports.nativeConfig)
  put("transports.remoteConfig", transports.remoteConfig)
  put("transports.langfuseConfig", transports.langfuseConfig)
  put("transports.agentTraceConfig", transports.agentTraceConfig)
  put("transports.agentTraceOtlpConfig", transports.agentTraceOtlpConfig)
  put("transports.posthog.managed", transports.posthogConfig?.managed)
  put("transports.posthog.byo", transports.posthogConfig?.byo)

  put("retention.maxEntries", retention.maxEntries)
  put("retention.maxAgeDays", retention.maxAgeDays)

  put(
    "sampling",
    [...draft.samplingRules].sort((left, right) =>
      left.modulePrefix.localeCompare(right.modulePrefix)
    )
  )

  put("behavior.enabled", behaviorTelemetry.enabled)
  put("behavior.destinations", behaviorTelemetry.destinations)
  put("behavior.categories", behaviorTelemetry.categories)
  put("behavior.sampleRate", behaviorTelemetry.sampleRate)
  put("behavior.retentionDays", behaviorTelemetry.retentionDays)
  put("behavior.maxStoredEvents", behaviorTelemetry.maxStoredEvents)

  return out
}

export function countChangedFields(baseline: DraftSnapshot, next: DraftSnapshot): number {
  const a = flattenDraft(baseline)
  const b = flattenDraft(next)
  return Object.keys(b).reduce((total, key) => (a[key] === b[key] ? total : total + 1), 0)
}

/* ── Draft factories ────────────────────────────────────────────────────── */

function pickConfig(config: UnifiedLoggerConfig): LogConfigDraft {
  return {
    minLevel: config.minLevel,
    includeStackTrace: config.includeStackTrace,
    includeSource: config.includeSource,
    perModuleLevels: { ...(config.perModuleLevels ?? {}) },
    bufferSize: config.bufferSize,
    flushInterval: config.flushInterval,
    remoteEndpoint: config.remoteEndpoint,
    remoteQueueMaxEntries: config.remoteQueueMaxEntries,
    remoteQueueMaxBytes: config.remoteQueueMaxBytes,
    diagnosticRateLimitMs: config.diagnosticRateLimitMs,
    redaction: { ...config.redaction },
  }
}

function normalizeTransports(transports: LoggingTransportSettings): LoggingTransportSettings {
  return {
    ...transports,
    posthogConfig: transports.posthogConfig
      ? {
          managed: { ...transports.posthogConfig.managed },
          byo: { ...transports.posthogConfig.byo },
        }
      : {
          managed: { ...DEFAULT_POSTHOG_CONFIG.managed },
          byo: { ...DEFAULT_POSTHOG_CONFIG.byo },
        },
    remoteConfig: { ...transports.remoteConfig },
    langfuseConfig: {
      ...transports.langfuseConfig,
      publicKey: transports.langfuseConfig.publicKey || "",
      host: transports.langfuseConfig.host || "https://cloud.langfuse.com",
    },
    nativeConfig: { ...transports.nativeConfig },
    agentTraceConfig: { ...transports.agentTraceConfig },
    agentTraceOtlpConfig: {
      ...transports.agentTraceOtlpConfig,
      headers: { ...transports.agentTraceOtlpConfig.headers },
      grafanaCloud: { ...transports.agentTraceOtlpConfig.grafanaCloud },
    },
  }
}

/** The factory-fresh draft, sourced from the same records bootstrap reads. */
export function factoryDraft(): DraftSnapshot {
  return {
    config: pickConfig(DEFAULT_UNIFIED_CONFIG),
    transports: normalizeTransports(DEFAULT_TRANSPORT_SETTINGS),
    retention: { ...DEFAULT_RETENTION_SETTINGS },
    samplingRules: [],
    behaviorTelemetry: {
      ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS,
      destinations: { ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS.destinations },
      categories: { ...DEFAULT_BEHAVIOR_TELEMETRY_SETTINGS.categories },
    },
  }
}

/* ── Hook ───────────────────────────────────────────────────────────────── */

export interface UseLogSettingsDraftResult {
  config: LogConfigDraft
  transports: LoggingTransportSettings
  retention: LoggingRetentionSettings
  samplingRules: SamplingRule[]
  behaviorTelemetry: BehaviorTelemetrySettings
  secretDrafts: Record<SecretKind, string>

  /** Fields differing from the last saved baseline. `0` means clean. */
  changedCount: number
  status: LogSettingsSaveStatus
  /** True while the last save (or secret clear) is still showing as failed. */
  saveError: boolean

  setConfig: <K extends keyof LogConfigDraft>(key: K, value: LogConfigDraft[K]) => void
  setRedaction: <K extends keyof NonNullable<LogConfigDraft["redaction"]>>(
    key: K,
    value: NonNullable<LogConfigDraft["redaction"]>[K]
  ) => void
  setModuleLevel: (prefix: string, level: LogLevel) => void
  removeModuleLevel: (prefix: string) => void

  setTransportEnabled: (transport: TransportKey, enabled: boolean) => void
  setTransportDetail: <
    TTransport extends
      | "nativeConfig"
      | "remoteConfig"
      | "langfuseConfig"
      | "agentTraceConfig"
      | "agentTraceOtlpConfig",
    TKey extends keyof LoggingTransportSettings[TTransport],
  >(
    transport: TTransport,
    key: TKey,
    value: LoggingTransportSettings[TTransport][TKey]
  ) => void
  setPostHog: (
    scope: "managed" | "byo",
    key: "productAnalytics" | "aiObservability" | "host" | "projectToken",
    value: boolean | string
  ) => void

  setRetention: (key: keyof LoggingRetentionSettings, value: number) => void
  setSamplingRules: (next: SamplingRule[]) => void
  setBehaviorTelemetry: (
    updater: (previous: BehaviorTelemetrySettings) => BehaviorTelemetrySettings
  ) => void
  setSecretDraft: (kind: SecretKind, value: string) => void
  clearStoredSecret: (kind: SecretKind) => Promise<void>

  save: () => Promise<void>
  /** Revert every field to the last saved baseline. */
  discard: () => void
  /** Load the factory defaults into the draft. Still requires a save. */
  reset: () => void
}

export function useLogSettingsDraft(): UseLogSettingsDraftResult {
  const saveAppSettings = useSettingsStore((state) => state.save)
  const bootstrapState = useMemo(() => getLoggingBootstrapState(), [])

  const [config, setConfigState] = useState<LogConfigDraft>(() => pickConfig(bootstrapState.config))
  const [transports, setTransports] = useState<LoggingTransportSettings>(() => {
    const normalized = normalizeTransports(bootstrapState.transports)
    return {
      ...normalized,
      remoteConfig: {
        ...normalized.remoteConfig,
        endpoint: normalized.remoteConfig.endpoint || bootstrapState.config.remoteEndpoint || "",
      },
    }
  })
  const [retention, setRetentionState] = useState<LoggingRetentionSettings>(() => ({
    ...bootstrapState.retention,
  }))
  const [samplingRules, setSamplingRulesState] = useState<SamplingRule[]>(() => loadSamplingRules())
  const [behaviorTelemetry, setBehaviorTelemetryState] = useState<BehaviorTelemetrySettings>(() =>
    getBehaviorTelemetrySettings()
  )
  const [secretDrafts, setSecretDrafts] = useState<Record<SecretKind, string>>({
    langfuseSecretKey: "",
    grafanaCloudApiToken: "",
  })
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle")

  // The last committed values, kept as state rather than a ref: the change
  // count is derived from it during render, and the React compiler's lint
  // (correctly) refuses a ref read there.
  const [baseline, setBaseline] = useState<DraftSnapshot>(() => ({
    config,
    transports,
    retention,
    samplingRules,
    behaviorTelemetry,
  }))

  const fieldChanges = countChangedFields(baseline, {
    config,
    transports,
    retention,
    samplingRules,
    behaviorTelemetry,
  })
  const pendingSecrets = (["langfuseSecretKey", "grafanaCloudApiToken"] as const).filter(
    (kind) => secretDrafts[kind].length > 0
  ).length
  const changedCount = fieldChanges + pendingSecrets

  const status: LogSettingsSaveStatus =
    saveStatus === "saving"
      ? "saving"
      : saveStatus === "saved"
        ? "saved"
        : changedCount > 0
          ? "dirty"
          : "clean"

  const setConfig = useCallback<UseLogSettingsDraftResult["setConfig"]>((key, value) => {
    setConfigState((previous) => ({ ...previous, [key]: value }))
  }, [])

  const setRedaction = useCallback<UseLogSettingsDraftResult["setRedaction"]>((key, value) => {
    setConfigState((previous) => ({
      ...previous,
      redaction: { ...previous.redaction, [key]: value },
    }))
  }, [])

  const setModuleLevel = useCallback((prefix: string, level: LogLevel) => {
    const trimmed = prefix.trim()
    if (!trimmed) return
    setConfigState((previous) => ({
      ...previous,
      perModuleLevels: { ...(previous.perModuleLevels ?? {}), [trimmed]: level },
    }))
  }, [])

  const removeModuleLevel = useCallback((prefix: string) => {
    setConfigState((previous) => {
      const next = { ...(previous.perModuleLevels ?? {}) }
      delete next[prefix]
      return { ...previous, perModuleLevels: next }
    })
  }, [])

  const setTransportEnabled = useCallback((transport: TransportKey, enabled: boolean) => {
    setTransports((previous) => ({ ...previous, [transport]: enabled }))
  }, [])

  const setTransportDetail = useCallback<UseLogSettingsDraftResult["setTransportDetail"]>(
    (transport, key, value) => {
      setTransports((previous) => ({
        ...previous,
        [transport]: { ...previous[transport], [key]: value },
      }))
    },
    []
  )

  const setPostHog = useCallback<UseLogSettingsDraftResult["setPostHog"]>((scope, key, value) => {
    setTransports((previous) => {
      const current = previous.posthogConfig ?? DEFAULT_POSTHOG_CONFIG
      return {
        ...previous,
        posthogConfig: { ...current, [scope]: { ...current[scope], [key]: value } },
      }
    })
  }, [])

  const setRetention = useCallback((key: keyof LoggingRetentionSettings, value: number) => {
    setRetentionState((previous) => ({ ...previous, [key]: value }))
  }, [])

  const setSamplingRules = useCallback((next: SamplingRule[]) => {
    setSamplingRulesState(next)
  }, [])

  const setBehaviorTelemetry = useCallback(
    (updater: (previous: BehaviorTelemetrySettings) => BehaviorTelemetrySettings) => {
      setBehaviorTelemetryState((previous) => updater(previous))
    },
    []
  )

  const setSecretDraft = useCallback((kind: SecretKind, value: string) => {
    setSecretDrafts((previous) => ({ ...previous, [kind]: value }))
  }, [])

  const clearStoredSecret = useCallback(async (kind: SecretKind) => {
    try {
      await clearTelemetrySecret(kind)
      setSecretDrafts((previous) => ({ ...previous, [kind]: "" }))
      setTransports((previous) =>
        kind === "langfuseSecretKey"
          ? {
              ...previous,
              langfuseConfig: { ...previous.langfuseConfig, secretKeyConfigured: false },
            }
          : {
              ...previous,
              agentTraceOtlpConfig: {
                ...previous.agentTraceOtlpConfig,
                grafanaCloud: {
                  ...previous.agentTraceOtlpConfig.grafanaCloud,
                  apiTokenConfigured: false,
                },
              },
            }
      )
    } catch {
      setSaveStatus("error")
      setTimeout(() => setSaveStatus("idle"), 3000)
    }
  }, [])

  const save = useCallback(async () => {
    setSaveStatus("saving")

    try {
      const previousBehaviorTelemetry = getBehaviorTelemetrySettings()
      const behaviorPreferenceChanged =
        behaviorTelemetry.enabled !== previousBehaviorTelemetry.enabled
      // Opting *out* is reported before the preference lands, opting *in*
      // after — either way the event is only sent while consent covers it.
      if (behaviorPreferenceChanged && !behaviorTelemetry.enabled) {
        await trackEvent("telemetry.preference.changed", { enabled: behaviorTelemetry.enabled })
      }
      saveBehaviorTelemetrySettings(behaviorTelemetry)
      void saveAppSettings({ telemetryEnabled: behaviorTelemetry.enabled, behaviorTelemetry })
      if (behaviorPreferenceChanged && behaviorTelemetry.enabled) {
        await trackEvent("telemetry.preference.changed", { enabled: behaviorTelemetry.enabled })
      }

      if (secretDrafts.langfuseSecretKey) {
        await persistTelemetrySecret("langfuseSecretKey", secretDrafts.langfuseSecretKey)
      }
      if (secretDrafts.grafanaCloudApiToken) {
        await persistTelemetrySecret("grafanaCloudApiToken", secretDrafts.grafanaCloudApiToken)
      }

      const securedTransports: LoggingTransportSettings = {
        ...transports,
        langfuseConfig: {
          ...transports.langfuseConfig,
          secretKeyConfigured:
            transports.langfuseConfig.secretKeyConfigured ||
            Boolean(secretDrafts.langfuseSecretKey),
        },
        agentTraceOtlpConfig: {
          ...transports.agentTraceOtlpConfig,
          grafanaCloud: {
            ...transports.agentTraceOtlpConfig.grafanaCloud,
            apiTokenConfigured:
              transports.agentTraceOtlpConfig.grafanaCloud.apiTokenConfigured ||
              Boolean(secretDrafts.grafanaCloudApiToken),
          },
        },
      }

      const next = applyLoggingSettings({
        config: { ...config, remoteEndpoint: securedTransports.remoteConfig.endpoint },
        transports: securedTransports,
        retention,
        persist: true,
      })
      persistSamplingRules(samplingRules)

      const nextConfig = pickConfig(next.config)
      const nextTransports = normalizeTransports(next.transports)
      setConfigState(nextConfig)
      setTransports(nextTransports)
      setRetentionState({ ...next.retention })
      setSecretDrafts({ langfuseSecretKey: "", grafanaCloudApiToken: "" })
      setBaseline({
        config: nextConfig,
        transports: nextTransports,
        retention: { ...next.retention },
        samplingRules: [...samplingRules],
        behaviorTelemetry,
      })

      setSaveStatus("saved")
      setTimeout(() => setSaveStatus("idle"), 2000)
    } catch {
      setSaveStatus("error")
      setTimeout(() => setSaveStatus("idle"), 3000)
    }
  }, [
    behaviorTelemetry,
    config,
    retention,
    samplingRules,
    saveAppSettings,
    secretDrafts,
    transports,
  ])

  const discard = useCallback(() => {
    setConfigState(baseline.config)
    setTransports(baseline.transports)
    setRetentionState(baseline.retention)
    setSamplingRulesState([...baseline.samplingRules])
    setBehaviorTelemetryState(baseline.behaviorTelemetry)
    setSecretDrafts({ langfuseSecretKey: "", grafanaCloudApiToken: "" })
    setSaveStatus("idle")
  }, [baseline])

  const reset = useCallback(() => {
    const factory = factoryDraft()
    setConfigState(factory.config)
    setTransports(factory.transports)
    setRetentionState(factory.retention)
    setSamplingRulesState([...factory.samplingRules])
    setBehaviorTelemetryState(factory.behaviorTelemetry)
    setSecretDrafts({ langfuseSecretKey: "", grafanaCloudApiToken: "" })
  }, [])

  return {
    config,
    transports,
    retention,
    samplingRules,
    behaviorTelemetry,
    secretDrafts,
    changedCount,
    status,
    saveError: saveStatus === "error",
    setConfig,
    setRedaction,
    setModuleLevel,
    removeModuleLevel,
    setTransportEnabled,
    setTransportDetail,
    setPostHog,
    setRetention,
    setSamplingRules,
    setBehaviorTelemetry,
    setSecretDraft,
    clearStoredSecret,
    save,
    discard,
    reset,
  }
}
