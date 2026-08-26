"use client"

/**
 * Logs → Transports.
 *
 * The logging and AI-trace destinations, each with its own configuration and
 * live health badge. The remote retry-queue bounds moved in here from the old
 * `Advanced` tab: they are properties of the remote transport, and reading
 * "Remote Queue Size (MB)" three screens away from the endpoint that fills it
 * was the reason nobody could tell what they applied to.
 */

import { useTranslations } from "next-intl"
import { CloudIcon, DatabaseIcon, MonitorIcon } from "lucide-react"
import type { TransportHealthSnapshot } from "@cognia/logging/types/transport"

import { SettingsBlock, SettingsStack } from "@/components/settings/common/settings-block"
import { DeferredTextInput } from "@/components/settings/common/deferred-text-input"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { CONFIG_BOUNDS, type LogLevel } from "@/lib/logging"
import { isTauri } from "@/lib/platform/detect"

import { LOG_LEVELS } from "../log-levels"
import { SliderField } from "../components/slider-field"
import { TransportRow } from "../components/transport-row"
import {
  TRANSPORT_KEYS,
  type TransportKey,
  type UseLogSettingsDraftResult,
} from "@/hooks/logging/use-log-settings-draft"

export interface LogsTransportsPanelProps {
  draft: UseLogSettingsDraftResult
  healthByTransport: Record<string, TransportHealthSnapshot>
  expanded: Record<TransportKey, boolean>
  onExpandedChange: (transport: TransportKey, open: boolean) => void
}

/** Registered transport name → the settings key that toggles it. */
const HEALTH_KEY: Record<TransportKey, string> = {
  console: "console",
  indexedDB: "indexeddb",
  native: "native",
  remote: "remote",
  langfuse: "langfuse",
  agentTrace: "agent-trace",
  agentTraceOtlp: "agent-trace-otlp",
  otlpLogs: "otlp-logs",
}

const TRANSPORT_ICONS: Record<TransportKey, typeof MonitorIcon> = {
  console: MonitorIcon,
  indexedDB: DatabaseIcon,
  native: MonitorIcon,
  remote: CloudIcon,
  langfuse: CloudIcon,
  agentTrace: DatabaseIcon,
  agentTraceOtlp: CloudIcon,
  otlpLogs: CloudIcon,
}

function LevelSelect({
  id,
  label,
  value,
  onChange,
}: {
  id: string
  label: string
  value: LogLevel
  onChange: (level: LogLevel) => void
}) {
  const t = useTranslations("logging")
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Select value={value} onValueChange={(next) => onChange(next as LogLevel)}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {LOG_LEVELS.map((level) => (
              <SelectItem key={level} value={level}>
                {t(`settings.logLevel.${level}`)}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  )
}

function TextField({
  id,
  label,
  value,
  placeholder,
  onChange,
  type,
  testid,
  hint,
  action,
  deferred = false,
}: {
  id: string
  label: string
  value: string
  placeholder?: string
  onChange: (value: string) => void
  type?: "password"
  testid?: string
  hint?: string
  action?: React.ReactNode
  /**
   * Commit on blur / Enter rather than per keystroke. Use this for values that
   * should not trigger an expensive settings update on every character.
   */
  deferred?: boolean
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {deferred ? (
        <DeferredTextInput
          id={id}
          data-testid={testid}
          value={value}
          placeholder={placeholder}
          onCommit={onChange}
        />
      ) : (
        <Input
          id={id}
          data-testid={testid}
          type={type}
          autoComplete={type === "password" ? "off" : undefined}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {action}
    </div>
  )
}

export function LogsTransportsPanel({
  draft,
  healthByTransport,
  expanded,
  onExpandedChange,
}: LogsTransportsPanelProps) {
  const t = useTranslations("logging")
  const { transports } = draft
  const otlp = transports.agentTraceOtlpConfig
  const secureTelemetryHost = isTauri()

  const renderDetail = (key: TransportKey) => {
    switch (key) {
      case "console":
        return (
          <p className="text-xs text-muted-foreground">{t("settings.transports.consoleDetail")}</p>
        )

      case "otlpLogs":
        return (
          <p className="text-xs text-muted-foreground">{t("settings.transports.otlpLogsDetail")}</p>
        )

      case "indexedDB":
        return (
          <div className="grid gap-4 @md/settings-stack:grid-cols-2">
            <p className="text-xs text-muted-foreground @md/settings-stack:col-span-2">
              {t("settings.transports.indexedDBDetail")}
            </p>
            <SliderField
              id="logs-indexeddb-buffer-size"
              label={t("settings.transports.indexedDBBufferSize")}
              description={t("settings.transports.indexedDBBufferSizeDesc")}
              valueLabel={String(draft.config.bufferSize)}
              value={draft.config.bufferSize}
              min={CONFIG_BOUNDS.bufferSize.min}
              max={CONFIG_BOUNDS.bufferSize.max}
              onValueChange={(value) => draft.setConfig("bufferSize", value)}
              className="border-b-0 pb-0"
            />
            <SliderField
              id="logs-indexeddb-flush-interval"
              label={t("settings.transports.indexedDBFlushInterval")}
              description={t("settings.transports.indexedDBFlushIntervalDesc")}
              valueLabel={`${draft.config.flushInterval} ms`}
              value={draft.config.flushInterval}
              min={CONFIG_BOUNDS.flushInterval.min}
              max={CONFIG_BOUNDS.flushInterval.max}
              step={250}
              onValueChange={(value) => draft.setConfig("flushInterval", value)}
              className="border-b-0 pb-0"
            />
          </div>
        )

      case "native":
        return (
          <div className="grid gap-4 @md/settings-stack:grid-cols-2">
            <LevelSelect
              id="logs-native-min-level"
              label={t("settings.transports.nativeMinLevel")}
              value={transports.nativeConfig.minLevel}
              onChange={(level) => draft.setTransportDetail("nativeConfig", "minLevel", level)}
            />
            <SliderField
              id="logs-native-batch-size"
              label={t("settings.transports.nativeBatchSize")}
              valueLabel={String(transports.nativeConfig.batchSize)}
              value={transports.nativeConfig.batchSize}
              min={1}
              max={100}
              onValueChange={(value) =>
                draft.setTransportDetail("nativeConfig", "batchSize", value)
              }
              className="border-b-0 pb-0"
            />
            <SliderField
              id="logs-native-flush-interval"
              label={t("settings.transports.nativeFlushInterval")}
              valueLabel={`${transports.nativeConfig.flushInterval} ms`}
              value={transports.nativeConfig.flushInterval}
              min={250}
              max={30000}
              step={250}
              onValueChange={(value) =>
                draft.setTransportDetail("nativeConfig", "flushInterval", value)
              }
              className="border-b-0 pb-0 @md/settings-stack:col-span-2"
            />
          </div>
        )

      case "remote":
        return (
          <div className="grid gap-4 @md/settings-stack:grid-cols-2">
            <div className="@md/settings-stack:col-span-2">
              <TextField
                id="logs-remote-endpoint"
                label={t("settings.transports.remoteEndpoint")}
                value={transports.remoteConfig.endpoint}
                placeholder={t("settings.transports.remoteEndpointPlaceholder")}
                hint={
                  transports.remoteConfig.endpoint
                    ? undefined
                    : t("settings.transports.remoteEndpointRequired")
                }
                onChange={(value) => draft.setTransportDetail("remoteConfig", "endpoint", value)}
              />
            </div>
            <SliderField
              id="logs-remote-batch-size"
              label={t("settings.transports.remoteBatchSize")}
              valueLabel={String(transports.remoteConfig.batchSize)}
              value={transports.remoteConfig.batchSize}
              min={10}
              max={200}
              step={10}
              onValueChange={(value) =>
                draft.setTransportDetail("remoteConfig", "batchSize", value)
              }
              className="border-b-0 pb-0"
            />
            <SliderField
              id="logs-remote-flush-interval"
              label={t("settings.transports.remoteFlushInterval")}
              valueLabel={`${transports.remoteConfig.flushInterval} ms`}
              value={transports.remoteConfig.flushInterval}
              min={1000}
              max={30000}
              step={1000}
              onValueChange={(value) =>
                draft.setTransportDetail("remoteConfig", "flushInterval", value)
              }
              className="border-b-0 pb-0"
            />
            <SliderField
              id="logs-remote-max-retries"
              label={t("settings.transports.remoteMaxRetries")}
              valueLabel={String(transports.remoteConfig.maxRetries)}
              value={transports.remoteConfig.maxRetries}
              min={0}
              max={10}
              onValueChange={(value) =>
                draft.setTransportDetail("remoteConfig", "maxRetries", value)
              }
              className="border-b-0 pb-0"
            />
            <SliderField
              id="logs-remote-retry-delay"
              label={t("settings.transports.remoteRetryDelay")}
              valueLabel={`${transports.remoteConfig.retryDelay} ms`}
              value={transports.remoteConfig.retryDelay}
              min={500}
              max={10000}
              step={500}
              onValueChange={(value) =>
                draft.setTransportDetail("remoteConfig", "retryDelay", value)
              }
              className="border-b-0 pb-0"
            />
            <SliderField
              id="logs-remote-queue-entries"
              label={t("settings.advanced.remoteQueueEntries")}
              description={t("settings.advanced.remoteQueueEntriesDesc")}
              valueLabel={draft.config.remoteQueueMaxEntries.toLocaleString()}
              value={draft.config.remoteQueueMaxEntries}
              min={CONFIG_BOUNDS.remoteQueueMaxEntries.min}
              max={CONFIG_BOUNDS.remoteQueueMaxEntries.max}
              step={500}
              onValueChange={(value) => draft.setConfig("remoteQueueMaxEntries", value)}
              className="border-b-0 pb-0"
            />
            <SliderField
              id="logs-remote-queue-bytes"
              label={t("settings.advanced.remoteQueueBytes")}
              description={t("settings.advanced.remoteQueueBytesDesc")}
              valueLabel={`${Math.max(1, Math.round(draft.config.remoteQueueMaxBytes / (1024 * 1024)))} MB`}
              value={Math.max(1, Math.round(draft.config.remoteQueueMaxBytes / (1024 * 1024)))}
              min={CONFIG_BOUNDS.remoteQueueMaxBytes.min / (1024 * 1024)}
              max={CONFIG_BOUNDS.remoteQueueMaxBytes.max / (1024 * 1024)}
              onValueChange={(value) => draft.setConfig("remoteQueueMaxBytes", value * 1024 * 1024)}
              className="border-b-0 pb-0"
            />
          </div>
        )

      case "langfuse":
        return (
          <div className="grid gap-4 @md/settings-stack:grid-cols-2">
            <TextField
              id="logs-langfuse-public-key"
              label={t("settings.transports.langfusePublicKey")}
              value={transports.langfuseConfig.publicKey}
              placeholder={t("settings.transports.langfusePublicKeyPlaceholder")}
              onChange={(value) => draft.setTransportDetail("langfuseConfig", "publicKey", value)}
            />
            <TextField
              id="logs-langfuse-secret-key"
              label={t("settings.transports.langfuseSecretKey")}
              type="password"
              value={draft.secretDrafts.langfuseSecretKey}
              placeholder={t(
                transports.langfuseConfig.secretKeyConfigured
                  ? "settings.transports.secretConfiguredPlaceholder"
                  : "settings.transports.langfuseSecretKeyPlaceholder"
              )}
              onChange={(value) => draft.setSecretDraft("langfuseSecretKey", value)}
              action={
                transports.langfuseConfig.secretKeyConfigured ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void draft.clearStoredSecret("langfuseSecretKey")}
                  >
                    {t("settings.transports.clearStoredSecret")}
                  </Button>
                ) : undefined
              }
            />
            <div className="@md/settings-stack:col-span-2">
              <TextField
                id="logs-langfuse-base-url"
                label={t("settings.transports.langfuseBaseUrl")}
                value={transports.langfuseConfig.baseUrl}
                placeholder={t("settings.transports.langfuseBaseUrlPlaceholder")}
                hint={t("settings.transports.langfuseBaseUrlHint")}
                onChange={(value) => draft.setTransportDetail("langfuseConfig", "baseUrl", value)}
              />
            </div>
            <TextField
              id="logs-langfuse-environment"
              label={t("settings.transports.langfuseEnvironment")}
              value={transports.langfuseConfig.environment}
              placeholder={t("settings.transports.langfuseEnvironmentPlaceholder")}
              onChange={(value) => draft.setTransportDetail("langfuseConfig", "environment", value)}
            />
            <div className="flex items-center gap-3 @md/settings-stack:col-span-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={
                  !transports.langfuseConfig.secretKeyConfigured ||
                  draft.langfuseConnectionStatus === "testing"
                }
                onClick={() => void draft.testLangfuseConnection()}
              >
                {t(
                  draft.langfuseConnectionStatus === "testing"
                    ? "settings.transports.langfuseConnectionTesting"
                    : "settings.transports.langfuseConnectionTest"
                )}
              </Button>
              {draft.langfuseConnectionStatus !== "idle" &&
                draft.langfuseConnectionStatus !== "testing" && (
                  <p className="text-xs text-muted-foreground" role="status">
                    {t(
                      draft.langfuseConnectionStatus === "connected"
                        ? "settings.transports.langfuseConnectionSuccess"
                        : "settings.transports.langfuseConnectionFailed"
                    )}
                  </p>
                )}
            </div>
            <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
              <div className="min-w-0 flex-1 space-y-0.5">
                <Label htmlFor="logs-langfuse-model-content" className="text-sm font-medium">
                  {t("settings.transports.langfuseCaptureModelContent")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("settings.transports.langfuseCaptureModelContentDesc")}
                </p>
              </div>
              <Switch
                id="logs-langfuse-model-content"
                checked={transports.langfuseConfig.captureModelContent}
                onCheckedChange={(checked) =>
                  draft.setTransportDetail("langfuseConfig", "captureModelContent", checked)
                }
              />
            </div>
            <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
              <div className="min-w-0 flex-1 space-y-0.5">
                <Label htmlFor="logs-langfuse-tool-content" className="text-sm font-medium">
                  {t("settings.transports.langfuseCaptureToolContent")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("settings.transports.langfuseCaptureToolContentDesc")}
                </p>
              </div>
              <Switch
                id="logs-langfuse-tool-content"
                checked={transports.langfuseConfig.captureToolContent}
                onCheckedChange={(checked) =>
                  draft.setTransportDetail("langfuseConfig", "captureToolContent", checked)
                }
              />
            </div>
          </div>
        )

      case "agentTrace":
        return (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
              <div className="min-w-0 flex-1 space-y-0.5">
                <Label htmlFor="agent-trace-capture-content-switch" className="text-sm font-medium">
                  {t("panel.agentTrace.settings.captureContent")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("panel.agentTrace.settings.captureContentHint", {
                    bytes: transports.agentTraceConfig.maxPreviewBytes,
                  })}
                </p>
              </div>
              <Switch
                id="agent-trace-capture-content-switch"
                data-testid="agent-trace-capture-content-switch"
                checked={transports.agentTraceConfig.captureContent}
                onCheckedChange={(checked) =>
                  draft.setTransportDetail("agentTraceConfig", "captureContent", checked)
                }
              />
            </div>
            <SliderField
              id="agent-trace-retention-slider"
              label={t("panel.agentTrace.settings.retentionDays")}
              description={t("panel.agentTrace.settings.retentionDaysHint")}
              valueLabel={
                transports.agentTraceConfig.retentionDays === 0
                  ? "∞"
                  : `${transports.agentTraceConfig.retentionDays}d`
              }
              value={transports.agentTraceConfig.retentionDays}
              min={0}
              max={365}
              onValueChange={(value) =>
                draft.setTransportDetail("agentTraceConfig", "retentionDays", value)
              }
              testid="agent-trace-retention-slider"
              className="border-b-0 pb-0"
            />
          </div>
        )

      case "agentTraceOtlp":
        return (
          <div className="grid gap-4 @md/settings-stack:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="agent-trace-otlp-preset" className="text-xs">
                {t("panel.agentTraceOtlp.preset")}
              </Label>
              <Select
                value={otlp.preset}
                onValueChange={(value) =>
                  draft.setTransportDetail(
                    "agentTraceOtlpConfig",
                    "preset",
                    value as "off" | "grafana-cloud" | "self-hosted" | "custom"
                  )
                }
              >
                <SelectTrigger id="agent-trace-otlp-preset" data-testid="agent-trace-otlp-preset">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="off">
                      {t("panel.agentTraceOtlp.presetOptions.off")}
                    </SelectItem>
                    <SelectItem value="grafana-cloud" disabled={!secureTelemetryHost}>
                      {t("panel.agentTraceOtlp.presetOptions.grafanaCloud")}
                    </SelectItem>
                    <SelectItem value="self-hosted">
                      {t("panel.agentTraceOtlp.presetOptions.selfHosted")}
                    </SelectItem>
                    <SelectItem value="custom">
                      {t("panel.agentTraceOtlp.presetOptions.custom")}
                    </SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <TextField
              id="agent-trace-otlp-service-name"
              label={t("panel.agentTraceOtlp.serviceName")}
              value={otlp.serviceName}
              placeholder={t("panel.agentTraceOtlp.serviceNamePlaceholder")}
              onChange={(value) =>
                draft.setTransportDetail("agentTraceOtlpConfig", "serviceName", value)
              }
            />
            <div className="@md/settings-stack:col-span-2">
              <TextField
                id="agent-trace-otlp-endpoint"
                testid="agent-trace-otlp-endpoint"
                label={t("panel.agentTraceOtlp.endpoint")}
                value={otlp.endpoint}
                placeholder={t(
                  `panel.agentTraceOtlp.endpointPlaceholder.${
                    otlp.preset === "grafana-cloud" ? "grafanaCloud" : "selfHosted"
                  }`
                )}
                onChange={(value) =>
                  draft.setTransportDetail("agentTraceOtlpConfig", "endpoint", value)
                }
              />
            </div>
            {otlp.preset === "grafana-cloud" && secureTelemetryHost ? (
              <>
                <TextField
                  id="agent-trace-otlp-grafana-instance-id"
                  testid="agent-trace-otlp-grafana-instance-id"
                  label={t("panel.agentTraceOtlp.grafanaInstanceId")}
                  value={otlp.grafanaCloud.instanceId}
                  placeholder={t("panel.agentTraceOtlp.grafanaInstanceIdPlaceholder")}
                  onChange={(value) =>
                    draft.setTransportDetail("agentTraceOtlpConfig", "grafanaCloud", {
                      ...otlp.grafanaCloud,
                      instanceId: value,
                    })
                  }
                />
                <TextField
                  id="agent-trace-otlp-grafana-api-token"
                  testid="agent-trace-otlp-grafana-api-token"
                  label={t("panel.agentTraceOtlp.grafanaApiToken")}
                  type="password"
                  value={draft.secretDrafts.grafanaCloudApiToken}
                  placeholder={t(
                    otlp.grafanaCloud.apiTokenConfigured
                      ? "settings.transports.secretConfiguredPlaceholder"
                      : "panel.agentTraceOtlp.grafanaApiTokenPlaceholder"
                  )}
                  onChange={(value) => draft.setSecretDraft("grafanaCloudApiToken", value)}
                  action={
                    otlp.grafanaCloud.apiTokenConfigured ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void draft.clearStoredSecret("grafanaCloudApiToken")}
                      >
                        {t("settings.transports.clearStoredSecret")}
                      </Button>
                    ) : undefined
                  }
                />
                <p className="text-xs text-muted-foreground @md/settings-stack:col-span-2">
                  {t("panel.agentTraceOtlp.grafanaCloudHint")}
                </p>
              </>
            ) : otlp.preset === "grafana-cloud" ? (
              <p className="text-xs text-muted-foreground @md/settings-stack:col-span-2">
                {t("panel.agentTraceOtlp.grafanaHostRequired")}
              </p>
            ) : otlp.preset !== "off" ? (
              <div className="text-xs text-muted-foreground @md/settings-stack:col-span-2">
                {t("panel.agentTraceOtlp.collectorAuthHint")}
              </div>
            ) : null}
            <div className="@md/settings-stack:col-span-2">
              <TextField
                id="agent-trace-otlp-environment"
                label={t("panel.agentTraceOtlp.environment")}
                value={otlp.environment}
                placeholder={t("panel.agentTraceOtlp.environmentPlaceholder")}
                onChange={(value) =>
                  draft.setTransportDetail("agentTraceOtlpConfig", "environment", value)
                }
              />
            </div>
          </div>
        )
    }
  }

  return (
    <SettingsStack>
      <SettingsBlock
        title={t("settings.transports.title")}
        description={t("settings.transports.description")}
        testid="logs-transports"
        contentClassName="space-y-3"
      >
        {TRANSPORT_KEYS.map((key) => (
          <TransportRow
            key={key}
            id={key}
            icon={TRANSPORT_ICONS[key]}
            title={t(`settings.transports.${key}`)}
            description={t(`settings.transports.${key}Desc`)}
            enabled={Boolean(transports[key])}
            onEnabledChange={(enabled) => draft.setTransportEnabled(key, enabled)}
            health={healthByTransport[HEALTH_KEY[key]]}
            open={expanded[key]}
            onOpenChange={(open) => onExpandedChange(key, open)}
          >
            {renderDetail(key)}
          </TransportRow>
        ))}
      </SettingsBlock>
    </SettingsStack>
  )
}
