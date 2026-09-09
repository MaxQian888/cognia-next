"use client"

/**
 * The inline credentials form for a custom provider.
 *
 * Custom-provider credentials live on the `customProviders` row itself
 * (written via `updateCustomProvider`), NOT in the `providerSettings` map.
 * Read and write the same source or the controlled inputs reset on every
 * keystroke and edits get silently mangled.
 *
 * Lifted out of `provider-settings.tsx`, where 200 lines of form sat above the
 * component that rendered it in one slot.
 */

import { useState } from "react"
import { Eye, EyeOff, Key, Loader2, PlugZap, Settings, Sparkles } from "lucide-react"
import { useTranslations } from "next-intl"

import {
  SettingsBlock,
  SettingsField,
  SettingsStack,
} from "@/components/settings/common/settings-block"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useDraftField } from "@/hooks/settings/use-draft-field"
import { useSecretReveal } from "@/hooks/use-secret-reveal"
import type { CustomProviderSettings } from "@cognia/provider-types/provider"

export function CustomProviderInlineConfig({
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
  // Settings → Security → "Require biometrics to reveal secrets".
  const revealSecret = useSecretReveal()
  // Draft-buffered like the built-in tab: no `customProviders` row rewrite per
  // keystroke, and no character drops while the async write is in flight.
  const apiKeyField = useDraftField(cp.apiKey ?? "", onApiKeyChange, { identity: cp.id })
  const baseURLField = useDraftField(cp.baseURL ?? "", onBaseURLChange, { identity: cp.id })

  // Same block layout the built-in config tab uses — selecting a custom
  // provider used to swap the whole first tab for a differently-shaped flat
  // form, so the pane's structure changed under the user with the row.
  const testStatus = testResult ? (
    <span
      data-testid="custom-provider-test-result"
      title={testMessage ?? undefined}
      className={
        testResult === "success"
          ? "text-xs text-emerald-600 dark:text-emerald-400"
          : testResult === "limited"
            ? "text-xs text-amber-600 dark:text-amber-400"
            : "text-xs text-destructive"
      }
    >
      {testResult === "success"
        ? t("customTestSuccess")
        : testResult === "limited"
          ? t("customTestLimited")
          : t("customTestError")}
      {/* The hook has carried the provider's actual error text since the test
          path was written; it was never rendered, so a failed custom test only
          ever said "failed". */}
      {testMessage && testResult !== "success" ? (
        <span className="ml-1 font-normal opacity-80" data-testid="custom-provider-test-message">
          · {testMessage}
        </span>
      ) : null}
    </span>
  ) : (
    <p className="text-xs text-muted-foreground">{t("configTab.notVerifiedHint")}</p>
  )

  return (
    <SettingsStack>
      <SettingsBlock
        icon={<Key />}
        title={t("configTab.credentialsTitle")}
        description={t("configTab.credentialsDescription")}
        badge={
          <Badge variant="secondary" className="text-[10px]">
            {cp.apiProtocol}
          </Badge>
        }
        action={
          <div className="flex shrink-0 items-center gap-1.5">
            {/* `testCustomProvider` was fully implemented but had zero callers,
                so `customTestResults` stayed empty forever and a custom
                provider's status badge could never leave "warning". */}
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
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
              className="h-8 gap-1.5 text-xs"
              onClick={onEditClick}
              data-testid="custom-provider-edit"
            >
              <Settings className="h-3 w-3" />
              {t("editCustomProvider")}
            </Button>
          </div>
        }
        testid="custom-provider-credentials"
      >
        <SettingsField
          stacked
          htmlFor={`custom-${cp.id}-api-key`}
          label={t("configTab.apiKeyLabel")}
          description={t("configTab.apiKeyDescription")}
        >
          <div className="relative">
            <Input
              id={`custom-${cp.id}-api-key`}
              type={showKey ? "text" : "password"}
              value={apiKeyField.value}
              onChange={(e) => apiKeyField.onChange(e.target.value)}
              onBlur={apiKeyField.onBlur}
              onKeyDown={apiKeyField.onKeyDown}
              placeholder={t("configTab.apiKeyPlaceholder")}
              className="pr-10 font-mono"
              autoComplete="new-password"
              data-lpignore="true"
              data-form-type="other"
              data-testid="custom-provider-api-key-input"
            />
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2"
              onClick={() =>
                showKey ? setShowKey(false) : void revealSecret(() => setShowKey(true))
              }
              type="button"
              aria-label={showKey ? t("configTab.hideKey") : t("configTab.showKey")}
              title={showKey ? t("configTab.hideKey") : t("configTab.showKey")}
              data-testid="custom-provider-toggle-key"
            >
              {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </SettingsField>

        <SettingsField
          stacked
          htmlFor={`custom-${cp.id}-base-url`}
          label={t("baseURL")}
          description={t("baseURLHint")}
        >
          <Input
            id={`custom-${cp.id}-base-url`}
            type="text"
            value={baseURLField.value}
            onChange={(e) => baseURLField.onChange(e.target.value)}
            onBlur={baseURLField.onBlur}
            onKeyDown={baseURLField.onKeyDown}
            placeholder={cp.baseURL}
            className="font-mono"
            data-testid="custom-provider-base-url-input"
          />
        </SettingsField>

        {testStatus}
      </SettingsBlock>

      {cp.customModels && cp.customModels.length > 0 && (
        <SettingsBlock
          icon={<Sparkles />}
          title={t("defaultModel")}
          description={t("configTab.defaultModelDescription")}
          testid="custom-provider-default-model"
        >
          <Select value={cp.defaultModel ?? ""} onValueChange={onDefaultModelChange}>
            <SelectTrigger className="w-full text-sm" aria-label={t("defaultModel")}>
              <SelectValue placeholder={t("selectModel")} />
            </SelectTrigger>
            <SelectContent>
              {cp.customModels.map((modelId: string) => (
                <SelectItem key={modelId} value={modelId}>
                  {cp.customModelMetadata?.[modelId]?.name ?? modelId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsBlock>
      )}
    </SettingsStack>
  )
}
