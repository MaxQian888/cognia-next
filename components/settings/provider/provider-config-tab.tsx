"use client"

/**
 * ProviderConfigTab — "Config" tab in the provider detail panel.
 *
 * Laid out as a `SettingsStack` of titled blocks rather than the flat run of
 * unlabelled rows it used to be. The old order put the key, the endpoint, the
 * protocol override, the status card and the test button at the same visual
 * level, so nothing said which controls are needed to connect and which are
 * escape hatches — and the test button moved between the top and the bottom of
 * the pane depending on whether a result existed.
 *
 * Blocks, in order:
 *  0. Anthropic auth extras (subscription reuse) — provider-gated
 *  1. Credentials — API key / Bedrock auth + base URL, verify action in the
 *     header, connection status at the foot. Everything one request needs.
 *  2. Default model — what a new chat picks under this provider
 *  3. Protocol & transport (collapsible) — wire protocol, OpenAI endpoint
 *     flavor, static headers. Opens itself when an override is already set.
 *  4. Key rotation (collapsible) — pool, strategy, ordering
 *  5. Provider-specific extras (`children`)
 *  6. Execution path (collapsible) — read-only ADR-0090 profile + certification,
 *     rendered only when the projection actually has rows for this provider.
 */

import React, { useState, useCallback, useEffect } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  Eye,
  EyeOff,
  Key,
  ChevronDown,
  Plus,
  Trash2,
  GripVertical,
  Check,
  X,
  AlertTriangle,
  ExternalLink,
  Loader2,
  PlugZap,
  RefreshCw,
  Route,
  Sparkles,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  SettingsStack,
  SettingsBlock,
  SettingsField,
} from "@/components/settings/common/settings-block"
import { getDb } from "@/lib/db/schema"
import {
  getBuiltInProviderSettingsBaseURL,
  getBuiltInProviderProtocol,
} from "@cognia/provider-types/built-in-provider-catalog"
import {
  validateBedrockConnectionSettings,
  type UserProviderSettings,
  type ApiKeyRotationStrategy,
  type ApiFlavor,
} from "@cognia/provider-types"
import type { BedrockConnectionSettings } from "@cognia/provider-types"
import { useDraftField } from "@/hooks/settings/use-draft-field"
import { BedrockSettingsFields } from "./bedrock-settings-fields"
import { TransportHeadersEditor } from "./transport-headers-editor"
import { DeploymentProfileCard } from "./deployment-profile-card"
import { DeploymentCertificationPanel } from "./deployment-certification-panel"
import type { ApiTestResult } from "@/lib/ai/infrastructure/api-test"
import { ProtocolSelectContent } from "./protocol-select-content"
import { AnthropicSubscriptionReuseCard } from "./anthropic-subscription-reuse-card"
import { useSecretReveal } from "@/hooks/use-secret-reveal"

/* ── Types ───────────────────────────────────────────────────────────────── */

export interface TestResult {
  success: boolean
  latency?: number
  error?: string
  testedAt?: number
  /**
   * `stale` = a previous verification exists but the credentials / endpoint
   * changed since (readiness fingerprint mismatch) — shown as a warning that
   * asks for a re-test rather than as a pass or a failure.
   */
  outcome?: "verified" | "failed" | "limited" | "stale"
  /** True when this card reflects the persisted verification, not a test run
   *  in this session — the "last tested" line then says so. */
  persisted?: boolean
}

export interface ProviderConfigTabProps {
  providerId: string
  settings: UserProviderSettings
  providerModels?: Array<{
    id: string
    name: string
    source?: "catalog" | "discovered" | "user"
  }>
  providerDashboardUrl?: string
  providerDocsUrl?: string
  onApiKeyChange: (key: string) => void
  onBaseURLChange: (url: string) => void
  onBedrockSettingsChange?: (settings: BedrockConnectionSettings) => void
  /**
   * Wire protocol override for non-Anthropic built-ins. Omit (or leave
   * unset) for `providerId === "anthropic"` — that slot always dispatches
   * through the native Claude Agent SDK subprocess, so a protocol override
   * would be silently ignored; the selector is hidden in that case.
   */
  onApiProtocolChange?: (protocol: string) => void
  /**
   * OpenAI endpoint-family override (Responses vs Chat Completions) for
   * OpenAI-protocol built-ins (Azure OpenAI, gateways, custom URLs). Omit to
   * hide the selector. Ignored for `anthropic`.
   */
  onApiFlavorChange?: (flavor: ApiFlavor) => void
  /** Static transport headers (`UserProviderSettings.customHeaders`). Omit to hide the editor. */
  onCustomHeadersChange?: (headers: Record<string, string> | undefined) => void
  onDefaultModelChange: (model: string) => void
  onTestConnection: () => Promise<TestResult>
  testResult?: TestResult | null
  isTesting?: boolean
  // Key rotation
  onAddApiKey?: (key: string) => void
  onRemoveApiKey?: (index: number) => void
  onReorderApiKeys?: (from: number, to: number) => void
  onToggleRotation?: (enabled: boolean) => void
  onRotationStrategyChange?: (strategy: ApiKeyRotationStrategy) => void
  // Extra content slot
  children?: React.ReactNode
}

/* ── Connection Status Card ──────────────────────────────────────────────── */

/**
 * Adapt a raw `ApiTestResult` (from `useConnectionTest`) to the `TestResult`
 * shape `ConnectionStatusCard` renders. Centralised here — next to both the
 * type and the card — so the success→error / latency_ms→latency mapping isn't
 * copy-pasted (and silently drifted) across the provider dialogs.
 */
export function toConnectionCardResult(result: ApiTestResult): TestResult {
  return {
    success: result.success,
    latency: result.latency_ms,
    error: result.success ? undefined : result.message,
    outcome: result.outcome,
  }
}

interface ConnectionStatusCardProps {
  result: TestResult
}

export function ConnectionStatusCard({ result }: ConnectionStatusCardProps) {
  const t = useTranslations("providers")

  if (result.success && result.outcome !== "limited") {
    return (
      <div className="flex items-center gap-3 rounded-md border border-green-200 bg-green-50 px-3 py-2.5 dark:border-green-900 dark:bg-green-950/30">
        <Check className="h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-green-700 dark:text-green-400">
            {t("configTab.connectionSuccess")}
          </p>
          {result.latency !== undefined && (
            <p className="text-xs text-green-600 dark:text-green-500">
              {t("configTab.latency")}: {result.latency}ms
            </p>
          )}
          {result.testedAt && (
            <p className="text-xs text-muted-foreground">
              {result.persisted ? t("configTab.lastVerified") : t("configTab.lastTested")}:{" "}
              {result.persisted
                ? new Date(result.testedAt).toLocaleString()
                : new Date(result.testedAt).toLocaleTimeString()}
            </p>
          )}
        </div>
      </div>
    )
  }

  // "Limited" means no authoritative request was made — e.g. Anthropic in a
  // browser session, where CORS forces a key-*format* check only
  // (`api-test.ts:testAnthropicConnection`). Read as a pass, that's actively
  // misleading, so the hint spells out what was not done. It lives at
  // `providers.verificationLimitedHint`, next to `providers.verificationLimited`
  // — the headline previously reached for `configTab.verificationLimited`,
  // which does not exist, so next-intl rendered the raw key path here.
  if (result.outcome === "limited") {
    return (
      <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 dark:border-amber-900 dark:bg-amber-950/30">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
            {t("verificationLimited")}
          </p>
          <p className="text-xs text-amber-600 dark:text-amber-500 mt-0.5">
            {t("verificationLimitedHint")}
          </p>
          {result.error && (
            <p className="text-xs text-amber-600 dark:text-amber-500 mt-0.5 break-words">
              {result.error}
            </p>
          )}
        </div>
      </div>
    )
  }

  if (result.outcome === "stale") {
    return (
      <div
        className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 dark:border-amber-900 dark:bg-amber-950/30"
        data-testid="connection-status-stale"
      >
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
            {t("verificationStale")}
          </p>
          <p className="text-xs text-amber-600 dark:text-amber-500 mt-0.5">
            {t("verificationStaleHint")}
          </p>
          {result.testedAt && (
            <p className="text-xs text-muted-foreground mt-0.5">
              {t("configTab.lastVerified")}: {new Date(result.testedAt).toLocaleString()}
            </p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5">
      <X className="h-4 w-4 shrink-0 text-destructive mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-destructive">{t("configTab.connectionFailed")}</p>
        {result.error && (
          <p className="text-xs text-destructive/80 mt-0.5 break-words">{result.error}</p>
        )}
        {result.persisted && result.testedAt && (
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("configTab.lastVerified")}: {new Date(result.testedAt).toLocaleString()}
          </p>
        )}
      </div>
    </div>
  )
}

/* ── Key Rotation Section ────────────────────────────────────────────────── */

interface KeyRotationSectionProps {
  settings: UserProviderSettings
  onAddApiKey?: (key: string) => void
  onRemoveApiKey?: (index: number) => void
  onReorderApiKeys?: (from: number, to: number) => void
  onToggleRotation?: (enabled: boolean) => void
  onRotationStrategyChange?: (strategy: ApiKeyRotationStrategy) => void
}

function KeyRotationSection({
  settings,
  onAddApiKey,
  onRemoveApiKey,
  onReorderApiKeys,
  onToggleRotation,
  onRotationStrategyChange,
}: KeyRotationSectionProps) {
  const t = useTranslations("providers")
  const [newKey, setNewKey] = useState("")
  const [addingKey, setAddingKey] = useState(false)

  const apiKeys = settings.apiKeys ?? []
  const rotationEnabled = settings.apiKeyRotationEnabled ?? false
  const rotationStrategy: ApiKeyRotationStrategy = settings.apiKeyRotationStrategy ?? "round-robin"

  const handleAddKey = useCallback(() => {
    if (newKey.trim() && onAddApiKey) {
      onAddApiKey(newKey.trim())
      setNewKey("")
      setAddingKey(false)
    }
  }, [newKey, onAddApiKey])

  const handleMoveUp = useCallback(
    (index: number) => {
      if (index > 0 && onReorderApiKeys) {
        onReorderApiKeys(index, index - 1)
      }
    },
    [onReorderApiKeys]
  )

  const handleMoveDown = useCallback(
    (index: number) => {
      if (index < apiKeys.length - 1 && onReorderApiKeys) {
        onReorderApiKeys(index, index + 1)
      }
    },
    [apiKeys.length, onReorderApiKeys]
  )

  return (
    <SettingsBlock
      collapsible
      defaultOpen={false}
      icon={<RefreshCw />}
      title={t("configTab.keyRotation")}
      description={t("configTab.keyRotationDescription")}
      badge={
        apiKeys.length > 0 ? (
          <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal tabular-nums">
            {apiKeys.length}
          </Badge>
        ) : undefined
      }
      testid="provider-key-rotation"
    >
      {/* Enable toggle — the "needs 2 keys" reason is spelled out instead of
          leaving a switch that silently refuses to move. */}
      {onToggleRotation && (
        <SettingsField
          label={t("configTab.keyRotationEnabled")}
          description={apiKeys.length < 2 ? t("configTab.rotationNeedsTwoKeys") : undefined}
        >
          <Switch
            checked={rotationEnabled}
            onCheckedChange={onToggleRotation}
            disabled={apiKeys.length < 2}
          />
        </SettingsField>
      )}

      {/* Strategy selector — only when rotation is on */}
      {rotationEnabled && onRotationStrategyChange && (
        <SettingsField
          label={t("configTab.rotationStrategy")}
          description={t("configTab.rotationStrategyDescription")}
        >
          <Select
            value={rotationStrategy}
            onValueChange={(v) => onRotationStrategyChange(v as ApiKeyRotationStrategy)}
          >
            <SelectTrigger
              className="h-8 w-[180px] text-xs"
              aria-label={t("configTab.rotationStrategy")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="round-robin">{t("configTab.strategyRoundRobin")}</SelectItem>
              <SelectItem value="random">{t("configTab.strategyRandom")}</SelectItem>
              <SelectItem value="least-used">{t("configTab.strategyLeastUsed")}</SelectItem>
            </SelectContent>
          </Select>
        </SettingsField>
      )}

      {/* Key pool */}
      <div className="space-y-2">
        {apiKeys.map((key, index) => (
          <div
            key={index}
            className="flex items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5 text-xs"
          >
            <GripVertical className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate font-mono">
              {key.slice(0, 8)}
              {"*".repeat(Math.max(0, key.length - 12))}
              {key.slice(-4)}
            </span>
            <div className="flex items-center gap-1">
              {onReorderApiKeys && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5"
                    onClick={() => handleMoveUp(index)}
                    disabled={index === 0}
                    title={t("configTab.moveUp")}
                  >
                    <ChevronDown className="h-3 w-3 rotate-180" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5"
                    onClick={() => handleMoveDown(index)}
                    disabled={index === apiKeys.length - 1}
                    title={t("configTab.moveDown")}
                  >
                    <ChevronDown className="h-3 w-3" />
                  </Button>
                </>
              )}
              {onRemoveApiKey && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 text-destructive hover:text-destructive"
                  onClick={() => onRemoveApiKey(index)}
                  title={t("configTab.removeKey")}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              )}
            </div>
          </div>
        ))}

        {/* Add key input */}
        {onAddApiKey &&
          (addingKey ? (
            <div className="flex items-center gap-2">
              <Input
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder={t("configTab.newKeyPlaceholder")}
                className="h-8 flex-1 text-xs font-mono"
                autoComplete="new-password"
                data-lpignore="true"
                data-form-type="other"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddKey()
                  if (e.key === "Escape") {
                    setAddingKey(false)
                    setNewKey("")
                  }
                }}
              />
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={handleAddKey}
                disabled={!newKey.trim()}
              >
                <Check className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => {
                  setAddingKey(false)
                  setNewKey("")
                }}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-full gap-1.5 text-xs"
              onClick={() => setAddingKey(true)}
            >
              <Plus className="h-3.5 w-3.5" />
              {t("configTab.addKey")}
            </Button>
          ))}
      </div>
    </SettingsBlock>
  )
}

/* ── Execution Path Block ────────────────────────────────────────────────── */

/**
 * Collapsible home for the two read-only ADR-0090 panels. Both self-hide when
 * the projection has no row for this provider, so the block repeats their
 * existence checks: a titled, empty disclosure is worse than no section at all.
 */
function ExecutionPathBlock({ providerId }: { providerId: string }) {
  const t = useTranslations("providers")

  const hasDeployment = useLiveQuery(
    async () =>
      (await getDb().deploymentProfiles.where("legacyProviderId").equals(providerId).count()) > 0,
    [providerId],
    false
  )
  const hasCertification = useLiveQuery(
    async () =>
      (await getDb().agentCompatibilityRecords.where("deploymentRef").equals(providerId).count()) >
      0,
    [providerId],
    false
  )

  if (!hasDeployment && !hasCertification) return null

  return (
    <SettingsBlock
      collapsible
      defaultOpen={false}
      icon={<Route />}
      title={t("configTab.executionTitle")}
      description={t("configTab.executionDescription")}
      testid="provider-execution-path"
    >
      <DeploymentProfileCard providerId={providerId} />
      <DeploymentCertificationPanel deploymentRef={providerId} />
    </SettingsBlock>
  )
}

/* ── Main Component ──────────────────────────────────────────────────────── */

export function ProviderConfigTab({
  providerId,
  settings,
  providerModels = [],
  providerDashboardUrl,
  providerDocsUrl,
  onApiKeyChange,
  onBaseURLChange,
  onBedrockSettingsChange,
  onApiProtocolChange,
  onApiFlavorChange,
  onCustomHeadersChange,
  onDefaultModelChange,
  onTestConnection,
  testResult,
  isTesting = false,
  onAddApiKey,
  onRemoveApiKey,
  onReorderApiKeys,
  onToggleRotation,
  onRotationStrategyChange,
  children,
}: ProviderConfigTabProps) {
  const t = useTranslations("providers")
  const [showApiKey, setShowApiKey] = useState(false)
  // Settings → Security → "Require biometrics to reveal secrets".
  const revealSecret = useSecretReveal()

  const handleTest = useCallback(async () => {
    await onTestConnection()
  }, [onTestConnection])

  const defaultModel = settings.defaultModel ?? ""
  const defaultModelField = useDraftField(defaultModel, onDefaultModelChange, {
    identity: `${providerId}:default-model`,
    debounceMs: 300,
  })
  const hasRotationSupport = !!(onToggleRotation || onAddApiKey || onRemoveApiKey)
  const isBedrock = providerId === "bedrock"

  // Catalog-default base URL for this provider (empty for OpenAI/Anthropic/…
  // whose SDKs hard-code the endpoint). Drives both the pre-filled field value
  // and the persist-on-configure effect below.
  const defaultBaseURL = getBuiltInProviderSettingsBaseURL(providerId)
  const isConfiguringProvider = !!settings.enabled || !!settings.apiKey

  // Protocol override: offered for every built-in EXCEPT the literal
  // "anthropic" id, which always dispatches through the native Claude Agent
  // SDK subprocess regardless of this field (see `sidecar/dispatch/index.mjs`)
  // — showing a selector there would be misleading since it wouldn't apply.
  const showProtocolSelector = providerId !== "anthropic" && !!onApiProtocolChange
  const catalogProtocol = getBuiltInProviderProtocol(providerId)
  const effectiveProtocol = settings.apiProtocol ?? catalogProtocol ?? "openai"
  // The Responses/Chat override only means something on the OpenAI wire
  // protocol (Azure OpenAI, gateways, custom URLs); `anthropic` always
  // dispatches through the native SDK.
  const showFlavorSelector =
    providerId !== "anthropic" && effectiveProtocol === "openai" && !!onApiFlavorChange

  // Once the user actually starts configuring this provider (enables it or
  // enters an API key), persist its default base URL so the saved settings
  // carry the real endpoint — not just a placeholder. Gating on
  // `isConfiguringProvider` keeps merely-browsed providers "not-configured"
  // (their status badge stays accurate). No-op when no default exists, and —
  // this is the difference from before — only when the field has NEVER been
  // stored (`undefined`): an explicit empty string is the user clearing it,
  // which used to snap straight back to the catalog default.
  const baseURLNeverStored = settings.baseURL === undefined
  useEffect(() => {
    if (defaultBaseURL && baseURLNeverStored && isConfiguringProvider) {
      onBaseURLChange(defaultBaseURL)
    }
  }, [defaultBaseURL, baseURLNeverStored, isConfiguringProvider, onBaseURLChange])

  // Draft-buffered credential inputs: keystrokes stay local and commit on the
  // trailing edge (idle / blur / Enter) instead of one settings-singleton
  // write per character. Keyed on the provider id so switching providers never
  // carries a half-typed key across.
  const apiKeyField = useDraftField(settings.apiKey ?? "", onApiKeyChange, {
    identity: providerId,
  })
  // Shows the catalog default while nothing is stored (browsing), exactly as
  // before; an explicit stored "" (user cleared it) stays empty.
  const baseURLField = useDraftField(settings.baseURL ?? defaultBaseURL ?? "", onBaseURLChange, {
    identity: providerId,
  })

  // Everything the transport block owns. Counting the live overrides drives
  // both the badge and whether the block opens itself — a stored override the
  // user has to hunt for behind a closed disclosure is how endpoints silently
  // drift from what the settings pane appears to say.
  const showTransportBlock =
    !isBedrock && (showProtocolSelector || showFlavorSelector || !!onCustomHeadersChange)
  const transportOverrideCount =
    (settings.apiProtocol ? 1 : 0) +
    (settings.apiFlavor && settings.apiFlavor !== "auto" ? 1 : 0) +
    Object.keys(settings.customHeaders ?? {}).length

  const canTest = isBedrock
    ? !!settings.bedrock && validateBedrockConnectionSettings(settings.bedrock).valid
    : !!settings.apiKey

  // One verification affordance, always in the same place (the credentials
  // block header) whether or not a result exists — it used to sit bottom-right
  // before the first test and top-right after it.
  const testAction = (
    <Button
      variant="outline"
      size="sm"
      className="h-8 gap-1.5"
      onClick={handleTest}
      disabled={isTesting || !canTest}
      title={canTest ? undefined : t("configTab.testDisabledHint")}
      data-testid="config-test-connection"
    >
      {isTesting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {t("detailPanel.testButton")}
    </Button>
  )

  const apiKeyInputId = `provider-${providerId}-api-key`
  const baseURLInputId = `provider-${providerId}-base-url`
  const defaultModelInputId = `provider-${providerId}-default-model`

  return (
    <SettingsStack>
      {/* ── 0. Anthropic auth extras (subscription reuse, privacy, ccswitch) ── */}
      {providerId === "anthropic" && (
        <div className="min-w-0">
          <AnthropicSubscriptionReuseCard />
        </div>
      )}

      {/* ── 1. Credentials + reachability ─────────────────────────────────
          Credentials, endpoint, verify action and status live together: these
          are exactly the controls that decide whether one request can succeed. */}
      <SettingsBlock
        icon={<Key />}
        title={t("configTab.credentialsTitle")}
        description={t("configTab.credentialsDescription")}
        action={testAction}
        testid="provider-credentials"
        settingId={`provider-${providerId}-credentials`}
      >
        {isBedrock ? (
          onBedrockSettingsChange ? (
            <BedrockSettingsFields
              value={settings.bedrock ?? { authMode: "default-chain", region: "us-east-1" }}
              onChange={onBedrockSettingsChange}
            />
          ) : null
        ) : (
          <>
            <SettingsField
              stacked
              htmlFor={apiKeyInputId}
              label={t("configTab.apiKeyLabel")}
              description={t("configTab.apiKeyDescription")}
            >
              <div className="space-y-2">
                <div className="relative">
                  <Input
                    id={apiKeyInputId}
                    type={showApiKey ? "text" : "password"}
                    value={apiKeyField.value}
                    onChange={(e) => apiKeyField.onChange(e.target.value)}
                    onBlur={apiKeyField.onBlur}
                    onKeyDown={apiKeyField.onKeyDown}
                    placeholder={t("configTab.apiKeyPlaceholder")}
                    className="pr-10 font-mono"
                    autoComplete="new-password"
                    data-lpignore="true"
                    data-form-type="other"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2"
                    onClick={() =>
                      showApiKey
                        ? setShowApiKey(false)
                        : void revealSecret(() => setShowApiKey(true))
                    }
                    title={showApiKey ? t("configTab.hideKey") : t("configTab.showKey")}
                    aria-label={showApiKey ? t("configTab.hideKey") : t("configTab.showKey")}
                    type="button"
                  >
                    {showApiKey ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>

                {/* Dashboard / docs links */}
                {(providerDashboardUrl || providerDocsUrl) && (
                  <div className="flex flex-wrap gap-3">
                    {providerDashboardUrl && (
                      <a
                        href={providerDashboardUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-primary"
                      >
                        <ExternalLink className="h-3 w-3" />
                        {t("configTab.getApiKey")}
                      </a>
                    )}
                    {providerDocsUrl && (
                      <a
                        href={providerDocsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-primary"
                      >
                        <ExternalLink className="h-3 w-3" />
                        {t("configTab.docs")}
                      </a>
                    )}
                  </div>
                )}
              </div>
            </SettingsField>

            <SettingsField
              stacked
              htmlFor={baseURLInputId}
              label={`${t("configTab.baseURLLabel")} · ${t("configTab.baseURLOptional")}`}
              description={t("baseURLHint")}
            >
              <Input
                id={baseURLInputId}
                type="text"
                value={baseURLField.value}
                onChange={(e) => baseURLField.onChange(e.target.value)}
                onBlur={baseURLField.onBlur}
                onKeyDown={baseURLField.onKeyDown}
                placeholder={defaultBaseURL || t("configTab.baseURLPlaceholder")}
                className="font-mono"
              />
            </SettingsField>
          </>
        )}

        {testResult !== null && testResult !== undefined ? (
          <ConnectionStatusCard result={testResult} />
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="config-not-verified-hint">
            {t("configTab.notVerifiedHint")}
          </p>
        )}
      </SettingsBlock>

      {/* ── 2. Default model ───────────────────────────────────────────── */}
      {providerModels.length > 0 && (
        <SettingsBlock
          icon={<Sparkles />}
          title={t("configTab.defaultModelLabel")}
          description={t("configTab.defaultModelDescription")}
          testid="provider-default-model"
        >
          <Input
            id={defaultModelInputId}
            list={`${defaultModelInputId}-options`}
            value={defaultModelField.value}
            onChange={(event) => defaultModelField.onChange(event.target.value)}
            onBlur={defaultModelField.onBlur}
            onKeyDown={defaultModelField.onKeyDown}
            placeholder={t("configTab.selectModel")}
            aria-label={t("configTab.defaultModelLabel")}
            autoComplete="off"
          />
          <datalist id={`${defaultModelInputId}-options`}>
            {providerModels.map((model) => (
              <option
                key={model.id}
                value={model.id}
                label={`${model.name} — ${t(`configTab.modelSource.${model.source ?? "catalog"}`)}`}
              />
            ))}
          </datalist>
          <p className="text-xs text-muted-foreground">{t("configTab.defaultModelManualHint")}</p>
        </SettingsBlock>
      )}

      {/* ── 3. Protocol & transport ────────────────────────────────────────
          The wire protocol, the OpenAI endpoint flavor and the static headers
          all answer the same question — how the request is shaped on the way
          out — so they share one disclosure instead of three sibling rows.
          `apiFlavor` has been honoured by the resolver for built-ins all along
          but only the custom-provider dialog could set it; `customHeaders` was
          likewise read by the runtime with no built-in editor. */}
      {showTransportBlock && (
        <SettingsBlock
          key={`transport-${providerId}`}
          collapsible
          defaultOpen={transportOverrideCount > 0}
          icon={<PlugZap />}
          title={t("configTab.transportTitle")}
          description={t("configTab.transportDescription")}
          badge={
            transportOverrideCount > 0 ? (
              <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
                {t("configTab.transportOverrides", { count: transportOverrideCount })}
              </Badge>
            ) : undefined
          }
          testid="provider-transport"
        >
          {showProtocolSelector && (
            <SettingsField
              stacked
              htmlFor={`api-protocol-${providerId}`}
              label={t("apiProtocol")}
              description={t("apiProtocolHint")}
            >
              <Select
                value={settings.apiProtocol ?? catalogProtocol ?? "openai"}
                onValueChange={(v) => onApiProtocolChange?.(v)}
              >
                <SelectTrigger
                  id={`api-protocol-${providerId}`}
                  className="w-full [&_[data-select-desc]]:hidden"
                >
                  <SelectValue placeholder={t("selectProtocol")} />
                </SelectTrigger>
                <ProtocolSelectContent />
              </Select>
            </SettingsField>
          )}

          {showFlavorSelector && (
            <SettingsField
              stacked
              htmlFor={`api-flavor-${providerId}`}
              label={t("apiFlavor")}
              description={t("apiFlavorHint")}
            >
              <Select
                value={settings.apiFlavor ?? "auto"}
                onValueChange={(v) => onApiFlavorChange?.(v as ApiFlavor)}
              >
                <SelectTrigger
                  id={`api-flavor-${providerId}`}
                  className="w-full [&_[data-select-desc]]:hidden"
                  data-testid="config-api-flavor"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">
                    <div className="flex flex-col">
                      <span>{t("apiFlavorAuto")}</span>
                      <span data-select-desc="" className="text-xs text-muted-foreground">
                        {t("apiFlavorAutoDesc")}
                      </span>
                    </div>
                  </SelectItem>
                  <SelectItem value="responses">
                    <div className="flex flex-col">
                      <span>{t("apiFlavorResponses")}</span>
                      <span data-select-desc="" className="text-xs text-muted-foreground">
                        {t("apiFlavorResponsesDesc")}
                      </span>
                    </div>
                  </SelectItem>
                  <SelectItem value="chat">
                    <div className="flex flex-col">
                      <span>{t("apiFlavorChat")}</span>
                      <span data-select-desc="" className="text-xs text-muted-foreground">
                        {t("apiFlavorChatDesc")}
                      </span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </SettingsField>
          )}

          {/* The editor prints its own label and policy hint, so it is NOT
              wrapped in a `SettingsField` — that duplicated both. */}
          {onCustomHeadersChange && (
            <div className="min-w-0" data-testid="config-headers-field">
              <TransportHeadersEditor
                idPrefix={`provider-${providerId}-headers`}
                value={settings.customHeaders}
                onChange={onCustomHeadersChange}
              />
            </div>
          )}
        </SettingsBlock>
      )}

      {/* ── 4. Key rotation ────────────────────────────────────────────── */}
      {!isBedrock && hasRotationSupport && (
        <KeyRotationSection
          key={`rotation-${providerId}`}
          settings={settings}
          onAddApiKey={onAddApiKey}
          onRemoveApiKey={onRemoveApiKey}
          onReorderApiKeys={onReorderApiKeys}
          onToggleRotation={onToggleRotation}
          onRotationStrategyChange={onRotationStrategyChange}
        />
      )}

      {/* ── 5. Provider-specific extras ────────────────────────────────── */}
      {children ? <div className="min-w-0 space-y-4">{children}</div> : null}

      {/* ── 6. Derived execution profile + certification (ADR-0090) ─────── */}
      <ExecutionPathBlock key={`execution-${providerId}`} providerId={providerId} />
    </SettingsStack>
  )
}

export default ProviderConfigTab
