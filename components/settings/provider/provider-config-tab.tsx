"use client"

/**
 * ProviderConfigTab — "Config" tab in the provider detail panel.
 *
 * Sections (vertical layout):
 *  1. API Key (password input + show/hide + "Get API Key" link)
 *  2. Base URL (text input, optional)
 *  3. Default Model (select dropdown)
 *  4. Connection Status card (success / failure)
 *  5. Key Rotation (collapsible) — enable toggle, strategy, key list, add-key input
 *  6. Children slot for provider-specific extras
 */

import React, { useState, useCallback, useEffect } from "react"
import {
  Eye,
  EyeOff,
  Key,
  Globe,
  ChevronDown,
  Plus,
  Trash2,
  GripVertical,
  Check,
  X,
  AlertTriangle,
  ExternalLink,
  Loader2,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import {
  getBuiltInProviderSettingsBaseURL,
  getBuiltInProviderProtocol,
} from "@cognia/provider-types/built-in-provider-catalog"
import {
  validateBedrockConnectionSettings,
  type UserProviderSettings,
  type ApiKeyRotationStrategy,
} from "@cognia/provider-types"
import type { BedrockConnectionSettings } from "@cognia/provider-types"
import { BedrockSettingsFields } from "./bedrock-settings-fields"
import type { ApiTestResult } from "@/lib/ai/infrastructure/api-test"
import { ProtocolSelectContent } from "./protocol-select-content"
import { AnthropicSubscriptionReuseCard } from "./anthropic-subscription-reuse-card"

/* ── Types ───────────────────────────────────────────────────────────────── */

export interface TestResult {
  success: boolean
  latency?: number
  error?: string
  testedAt?: number
  outcome?: "verified" | "failed" | "limited"
}

export interface ProviderConfigTabProps {
  providerId: string
  settings: UserProviderSettings
  providerModels?: Array<{ id: string; name: string }>
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
            {t("configTab.connectionSuccess") || "Connected"}
          </p>
          {result.latency !== undefined && (
            <p className="text-xs text-green-600 dark:text-green-500">
              {t("configTab.latency") || "Latency"}: {result.latency}ms
            </p>
          )}
          {result.testedAt && (
            <p className="text-xs text-muted-foreground">
              {t("configTab.lastTested") || "Last tested"}:{" "}
              {new Date(result.testedAt).toLocaleTimeString()}
            </p>
          )}
        </div>
      </div>
    )
  }

  if (result.outcome === "limited") {
    return (
      <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 dark:border-amber-900 dark:bg-amber-950/30">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
            {t("configTab.verificationLimited") || "Limited verification"}
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

  return (
    <div className="flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5">
      <X className="h-4 w-4 shrink-0 text-destructive mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-destructive">
          {t("configTab.connectionFailed") || "Connection failed"}
        </p>
        {result.error && (
          <p className="text-xs text-destructive/80 mt-0.5 break-words">{result.error}</p>
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
  const [open, setOpen] = useState(false)
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
    <>
      <Separator />
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-center gap-2 py-1 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
          <Key className="h-3.5 w-3.5" />
          <span>{t("configTab.keyRotation") || "Key Rotation"}</span>
          {apiKeys.length > 0 && (
            <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px]">
              {apiKeys.length}
            </span>
          )}
          <ChevronDown
            className={cn("ml-auto h-3.5 w-3.5 transition-transform", open && "rotate-180")}
          />
        </CollapsibleTrigger>

        <CollapsibleContent className="space-y-3 pt-3">
          {/* Enable toggle */}
          {onToggleRotation && (
            <div className="flex items-center justify-between">
              <Label className="text-sm">
                {t("configTab.keyRotationEnabled") || "Enable rotation"}
              </Label>
              <Switch
                checked={rotationEnabled}
                onCheckedChange={onToggleRotation}
                disabled={apiKeys.length < 2}
              />
            </div>
          )}

          {/* Strategy selector — only when rotation is on */}
          {rotationEnabled && onRotationStrategyChange && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                {t("configTab.rotationStrategy") || "Strategy"}
              </Label>
              <Select
                value={rotationStrategy}
                onValueChange={(v) => onRotationStrategyChange(v as ApiKeyRotationStrategy)}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="round-robin">
                    {t("configTab.strategyRoundRobin") || "Round Robin"}
                  </SelectItem>
                  <SelectItem value="random">
                    {t("configTab.strategyRandom") || "Random"}
                  </SelectItem>
                  <SelectItem value="least-used">
                    {t("configTab.strategyLeastUsed") || "Least Used"}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Key list */}
          {apiKeys.length > 0 && (
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
                          title={t("configTab.moveUp") || "Move up"}
                        >
                          <ChevronDown className="h-3 w-3 rotate-180" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5"
                          onClick={() => handleMoveDown(index)}
                          disabled={index === apiKeys.length - 1}
                          title={t("configTab.moveDown") || "Move down"}
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
                        title={t("configTab.removeKey") || "Remove"}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Add key input */}
          {onAddApiKey && (
            <>
              {addingKey ? (
                <div className="flex items-center gap-2">
                  <Input
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value)}
                    placeholder={t("configTab.newKeyPlaceholder") || "sk-..."}
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
                  {t("configTab.addKey") || "Add Key"}
                </Button>
              )}
            </>
          )}
        </CollapsibleContent>
      </Collapsible>
    </>
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

  const handleTest = useCallback(async () => {
    await onTestConnection()
  }, [onTestConnection])

  const defaultModel = settings.defaultModel ?? ""
  const hasRotationSupport = !!(onToggleRotation || onAddApiKey || onRemoveApiKey)
  const isBedrock = providerId === "bedrock"

  // Catalog-default base URL for this provider (empty for OpenAI/Anthropic/…
  // whose SDKs hard-code the endpoint). Drives both the pre-filled field value
  // and the persist-on-configure effect below.
  const defaultBaseURL = getBuiltInProviderSettingsBaseURL(providerId)
  const hasStoredBaseURL = !!settings.baseURL
  const isConfiguringProvider = !!settings.enabled || !!settings.apiKey

  // Protocol override: offered for every built-in EXCEPT the literal
  // "anthropic" id, which always dispatches through the native Claude Agent
  // SDK subprocess regardless of this field (see `sidecar/dispatch/index.mjs`)
  // — showing a selector there would be misleading since it wouldn't apply.
  const showProtocolSelector = providerId !== "anthropic" && !!onApiProtocolChange
  const catalogProtocol = getBuiltInProviderProtocol(providerId)

  // Once the user actually starts configuring this provider (enables it or
  // enters an API key), persist its default base URL so the saved settings
  // carry the real endpoint — not just a placeholder. Gating on
  // `isConfiguringProvider` keeps merely-browsed providers "not-configured"
  // (their status badge stays accurate). No-op when no default exists or the
  // user already supplied a base URL.
  useEffect(() => {
    if (defaultBaseURL && !hasStoredBaseURL && isConfiguringProvider) {
      onBaseURLChange(defaultBaseURL)
    }
  }, [defaultBaseURL, hasStoredBaseURL, isConfiguringProvider, onBaseURLChange])

  return (
    <div className="space-y-5">
      {/* ── 0. Anthropic auth extras (subscription reuse, privacy, ccswitch) ── */}
      {providerId === "anthropic" && <AnthropicSubscriptionReuseCard />}

      {isBedrock && onBedrockSettingsChange && (
        <BedrockSettingsFields
          value={settings.bedrock ?? { authMode: "default-chain", region: "us-east-1" }}
          onChange={onBedrockSettingsChange}
        />
      )}

      {/* ── 1. API Key ─────────────────────────────────────────────── */}
      {!isBedrock && (
        <div className="space-y-2">
          <Label className="flex items-center gap-1.5 text-sm font-medium">
            <Key className="h-3.5 w-3.5" />
            {t("configTab.apiKeyLabel") || "API Key"}
          </Label>

          <div className="relative">
            <Input
              type={showApiKey ? "text" : "password"}
              value={settings.apiKey ?? ""}
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
              onClick={() => setShowApiKey((prev) => !prev)}
              title={
                showApiKey
                  ? t("configTab.hideKey") || "Hide key"
                  : t("configTab.showKey") || "Show key"
              }
              type="button"
            >
              {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
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
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
                >
                  <ExternalLink className="h-3 w-3" />
                  {t("configTab.getApiKey") || "Get API Key →"}
                </a>
              )}
              {providerDocsUrl && (
                <a
                  href={providerDocsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
                >
                  <ExternalLink className="h-3 w-3" />
                  {t("configTab.docs") || "Docs"}
                </a>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── 2. Base URL ────────────────────────────────────────────── */}
      {!isBedrock && (
        <div className="space-y-2">
          <Label className="flex items-center gap-1.5 text-sm font-medium">
            <Globe className="h-3.5 w-3.5" />
            {t("configTab.baseURLLabel") || "Base URL"}
            <span className="font-normal text-muted-foreground text-xs">
              ({t("configTab.baseURLOptional") || "Optional"})
            </span>
          </Label>
          <Input
            type="text"
            value={settings.baseURL ?? defaultBaseURL ?? ""}
            onChange={(e) => onBaseURLChange(e.target.value)}
            placeholder={
              defaultBaseURL || t("configTab.baseURLPlaceholder") || "https://api.example.com/v1"
            }
          />
          <p className="text-xs text-muted-foreground">{t("baseURLHint")}</p>
        </div>
      )}

      {/* ── 2b. API Protocol override (non-Anthropic built-ins only) ─── */}
      {!isBedrock && showProtocolSelector && (
        <div className="space-y-2">
          <Label htmlFor={`api-protocol-${providerId}`} className="text-sm font-medium">
            {t("apiProtocol") || "API Protocol"}
          </Label>
          <Select
            value={settings.apiProtocol ?? catalogProtocol ?? "openai"}
            onValueChange={(v) => onApiProtocolChange?.(v)}
          >
            <SelectTrigger id={`api-protocol-${providerId}`}>
              <SelectValue placeholder={t("selectProtocol") || "Select protocol"} />
            </SelectTrigger>
            <ProtocolSelectContent />
          </Select>
          <p className="text-xs text-muted-foreground">{t("apiProtocolHint")}</p>
        </div>
      )}

      {/* ── 3. Default Model ───────────────────────────────────────── */}
      {providerModels.length > 0 && (
        <div className="space-y-2">
          <Label className="text-sm font-medium">
            {t("configTab.defaultModelLabel") || "Default Model"}
          </Label>
          <Select value={defaultModel} onValueChange={onDefaultModelChange}>
            <SelectTrigger className="h-9 text-sm">
              <SelectValue placeholder={t("configTab.selectModel") || "Select model"} />
            </SelectTrigger>
            <SelectContent>
              {providerModels.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* ── 4. Connection Status ───────────────────────────────────── */}
      {testResult !== null && testResult !== undefined && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">
              {t("configTab.connectionStatus") || "Connection Status"}
            </Label>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={handleTest}
              disabled={isTesting}
            >
              {isTesting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t("detailPanel.testButton") || "Test"}
            </Button>
          </div>
          <ConnectionStatusCard result={testResult} />
        </div>
      )}

      {/* Test button when no result yet */}
      {(testResult === null || testResult === undefined) && (
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={handleTest}
            disabled={
              isTesting ||
              (isBedrock
                ? !settings.bedrock || !validateBedrockConnectionSettings(settings.bedrock).valid
                : !settings.apiKey)
            }
          >
            {isTesting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t("detailPanel.testButton") || "Test Connection"}
          </Button>
        </div>
      )}

      {/* ── 5. Key Rotation ────────────────────────────────────────── */}
      {!isBedrock && hasRotationSupport && (
        <KeyRotationSection
          settings={settings}
          onAddApiKey={onAddApiKey}
          onRemoveApiKey={onRemoveApiKey}
          onReorderApiKeys={onReorderApiKeys}
          onToggleRotation={onToggleRotation}
          onRotationStrategyChange={onRotationStrategyChange}
        />
      )}

      {/* ── 6. Provider-specific extras ────────────────────────────── */}
      {children}
    </div>
  )
}

export default ProviderConfigTab
