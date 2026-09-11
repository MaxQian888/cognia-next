"use client"

/**
 * Renders `ProviderDetailPanel` for the currently selected provider, filling
 * each of its tab slots with the right component for that provider's kind:
 * a local inference engine, a custom endpoint, or a built-in catalog entry.
 *
 * This is the slot assembly that used to sit at the bottom of
 * `provider-settings.tsx`, where 320 lines of prop wiring buried the three-way
 * branch that is the actual logic. The prop list below is long because that
 * coupling is real, and naming it is the point: every value here is something
 * the detail pane genuinely needs from the list shell.
 *
 * The provider-specific panels stay lazy. Each is 18 to 27 KB and only ever
 * loads for the one provider that needs it.
 */

import dynamic from "next/dynamic"
import { SlidersHorizontal } from "lucide-react"
import { useTranslations } from "next-intl"

import { SettingsBlock, SettingsStack } from "@/components/settings/common/settings-block"
import type { ProviderHealth } from "@/hooks/ai/use-provider-manager"
import type { UseProviderSettingsResult } from "@/hooks/settings/use-provider-settings"
import { getSchemaForProvider } from "@cognia/provider-core/providers/provider-parameter-schemas"
import { validateBedrockConnectionSettings } from "@cognia/provider-types"
import type { LocalModelInfo, LocalProviderName } from "@cognia/provider-types/local-provider"
import type { PROVIDERS, CustomProviderSettings } from "@cognia/provider-types/provider"
import type { UserProviderSettings } from "@cognia/provider-types/provider"

import type { TestResult } from "./connection-status-card"
import { KeyLoginRow } from "./key-login-row"
import { OAuthLoginButton } from "./oauth-login-button"
import { ProviderConfigTab } from "./provider-config-tab"
import { ProviderCostTab } from "./provider-cost-tab"
import { CustomProviderInlineConfig } from "./provider-custom-inline-config"
import { ProviderDetailPanel } from "./provider-detail-panel"
import { ProviderDiagnosticsTab } from "./provider-diagnostics-tab"
import { ProviderModelsTab } from "./provider-models-tab"
import { ProviderParametersTab } from "./provider-parameters-tab"
import type { getBuiltInProviderReadiness, getCustomProviderReadiness } from "./provider-readiness"
import { ProviderSetupChecklist } from "./provider-setup-checklist"
import { deriveStatus } from "./provider-status-utils"
import { preferLiveHealth } from "./use-provider-rows"

const LocalProviderSettings = dynamic(
  () => import("./local-provider-settings").then((m) => m.LocalProviderSettings),
  { ssr: false }
)
const LocalProviderModelManager = dynamic(
  () => import("./local-provider-model-manager").then((m) => m.LocalProviderModelManager),
  { ssr: false }
)
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

type BuiltInProvider = (typeof PROVIDERS)[string]
// A custom provider and a built-in one produce differently shaped readiness
// objects. Only `setupChecklist` is read here, and both carry it.
type ProviderReadiness =
  ReturnType<typeof getBuiltInProviderReadiness> | ReturnType<typeof getCustomProviderReadiness>

export interface ProviderDetailHostProps {
  /** The selected row. Never null: the caller renders its empty state instead. */
  selectedId: string
  selectedBuiltIn: BuiltInProvider | undefined
  selectedCustom: CustomProviderSettings | undefined
  selectedSettings: UserProviderSettings | undefined
  selectedName: string | undefined
  selectedReadiness: ProviderReadiness | null
  isCustom: boolean
  /** A keyless local engine (Ollama, LM Studio, llama.cpp) gets its own dashboard. */
  isLocalProvider: boolean

  isEnabled: boolean
  canEnable: boolean
  enableBlockedReason: string | undefined
  canSetDefault: boolean
  setDefaultBlockedReason: string | undefined
  isDefault: boolean

  settings: UseProviderSettingsResult
  liveProviderHealth: Record<string, ProviderHealth>
  setProviderConfig: (id: string, patch: Partial<UserProviderSettings>) => Promise<void> | void

  /** Default-model options for the connect tab, static catalog plus discovered. */
  configModelOptions: Array<{ id: string; name: string }>
  enrichedBuiltInModels: React.ComponentProps<typeof ProviderModelsTab>["models"]
  modelsDevLoading: boolean
  diagnosticStatusByModel: Record<string, "passed" | "failed" | "stale">
  configTestResult: TestResult | null
  isRefreshingModels: boolean

  onRefreshModels: () => void | Promise<void>
  onTestConnection: () => void | Promise<void>
  onEditCustom: () => void
  onPersistLocalModels: (models: LocalModelInfo[]) => void | Promise<void>
  onRequestDelete: () => void
  /** Mobile push-navigation back arrow. Absent on a split layout. */
  onBack?: () => void
}

export function ProviderDetailHost({
  selectedId,
  selectedBuiltIn,
  selectedCustom,
  selectedSettings,
  selectedName,
  selectedReadiness,
  isCustom,
  isLocalProvider,
  isEnabled,
  canEnable,
  enableBlockedReason,
  canSetDefault,
  setDefaultBlockedReason,
  isDefault,
  settings: s,
  liveProviderHealth,
  setProviderConfig,
  configModelOptions,
  enrichedBuiltInModels,
  modelsDevLoading,
  diagnosticStatusByModel,
  configTestResult,
  isRefreshingModels,
  onRefreshModels,
  onTestConnection,
  onEditCustom,
  onPersistLocalModels,
  onRequestDelete,
  onBack,
}: ProviderDetailHostProps) {
  const t = useTranslations("providers")

  // Request parameters used to be a tab of their own, holding this one
  // collapsible block. It belongs with the rest of the connection setup, so it
  // is the last block of the connect tab for every provider kind instead.
  const parametersBlock = (
    <SettingsStack>
      <SettingsBlock
        collapsible
        icon={<SlidersHorizontal />}
        title={t("tabs.parameters")}
        description={t("configTab.parametersDescription")}
        settingId={`provider-${selectedId}-parameters`}
      >
        <ProviderParametersTab
          providerId={selectedId}
          settings={
            (isCustom ? selectedCustom : selectedSettings) ?? {
              providerId: selectedId,
              enabled: false,
              defaultModel: selectedBuiltIn?.defaultModel ?? selectedCustom?.defaultModel ?? "",
            }
          }
          schema={getSchemaForProvider(
            selectedId,
            Object.fromEntries(
              Object.values(s.customProviders).map((provider) => [
                provider.id,
                { apiProtocol: provider.apiProtocol, name: provider.name },
              ])
            )
          )}
          onSettingsChange={(patch) =>
            isCustom
              ? s.updateCustomProvider(selectedId, patch)
              : setProviderConfig(selectedId, patch)
          }
        />
      </SettingsBlock>
    </SettingsStack>
  )

  return (
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
      isDefault={isDefault}
      onSetDefault={canSetDefault ? () => void s.setDefaultProvider(selectedId) : undefined}
      setDefaultBlockedReason={setDefaultBlockedReason}
      connectionStatus={
        isCustom
          ? (() => {
              const testOutcome = s.customTestResults[selectedId]
              const effectiveTest = preferLiveHealth(
                liveProviderHealth[selectedId],
                testOutcome === "success" ? true : testOutcome === "error" ? false : undefined,
                testOutcome
              )
              return deriveStatus(
                (s.readinessCustomProviders?.[selectedId] ?? selectedCustom)?.apiKey,
                (s.readinessCustomProviders?.[selectedId] ?? selectedCustom)?.baseURL,
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
                (s.readinessProviderSettings?.[selectedId] ?? selectedSettings)?.apiKey,
                (s.readinessProviderSettings?.[selectedId] ?? selectedSettings)?.baseURL,
                effectiveTest.ok,
                effectiveTest.outcome,
                selectedId === "bedrock" && !!selectedSettings?.bedrock
                  ? validateBedrockConnectionSettings(selectedSettings.bedrock).valid
                  : false,
                selectedReadiness?.verificationStatus ??
                  selectedSettings?.verificationStatus ??
                  null
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
      onDelete={isCustom ? onRequestDelete : undefined}
      onBack={onBack}
      connectTab={
        // A local engine (Ollama, LM Studio, llama.cpp, …) is keyless
        // and gets its own dashboard, but it stays INSIDE the shared
        // detail shell so it keeps the header, enable switch, default
        // badge and status the rest of the list has.
        isLocalProvider ? (
          <div className="space-y-6">
            {selectedReadiness && (
              <ProviderSetupChecklist checklist={selectedReadiness.setupChecklist} isLocalEngine />
            )}
            <LocalProviderSettings providerId={selectedId as LocalProviderName} />
            {parametersBlock}
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
              canTestConnection={selectedReadiness?.eligibility.testConnection.allowed}
              hasSubscriptionCredential={
                !!s.readinessCustomProviders?.[selectedId]?.apiKey?.startsWith("subscription:")
              }
              onApiKeyChange={(key) => void s.updateCustomProvider(selectedId, { apiKey: key })}
              onBaseURLChange={(url) => void s.updateCustomProvider(selectedId, { baseURL: url })}
              onDefaultModelChange={(model) =>
                void s.updateCustomProvider(selectedId, { defaultModel: model })
              }
              onEditClick={onEditCustom}
              onTestConnection={() => void s.testCustomProvider(selectedId)}
              testResult={s.customTestResults[selectedId] ?? null}
              testMessage={s.customTestMessages[selectedId] ?? null}
              isTesting={!!s.testingCustomProviders[selectedId]}
            />
            {parametersBlock}
          </div>
        ) : selectedBuiltIn ? (
          <div className="space-y-6">
            {selectedReadiness && (
              <ProviderSetupChecklist
                checklist={selectedReadiness.setupChecklist}
                onVerify={onTestConnection}
                isVerifying={!!s.testingProviders[selectedId]}
              />
            )}
            <ProviderConfigTab
              providerId={selectedId}
              hasSubscriptionCredential={
                !!s.readinessProviderSettings?.[selectedId]?.apiKey?.startsWith("subscription:")
              }
              canTestConnection={selectedReadiness?.eligibility.testConnection.allowed}
              authSlot={
                <>
                  {/* Both self-gate on the catalog (`supportsOAuth`, and whether
                      the provider has a console page or a validation probe), so
                      mounting them for every built-in is safe and any provider
                      that grows one picks it up for free. */}
                  <OAuthLoginButton providerId={selectedId} />
                  <KeyLoginRow providerId={selectedId} apiKey={selectedSettings?.apiKey} />
                </>
              }
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
              onApiKeyChange={(key) => void setProviderConfig(selectedId, { apiKey: key })}
              onBaseURLChange={(url) => void setProviderConfig(selectedId, { baseURL: url })}
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
              onApiFlavorChange={(apiFlavor) => void setProviderConfig(selectedId, { apiFlavor })}
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
            >
              {/* Provider-specific panels. Both shipped with a catalog entry and
                  a full settings schema but were never mounted, so every field
                  they expose was unreachable. */}
              {selectedId === "openrouter" && (
                <>
                  <OpenRouterSettings />
                  <OpenRouterKeyManagement />
                </>
              )}
              {selectedId === "cliproxyapi" && <CLIProxyAPISettings />}
            </ProviderConfigTab>
            {parametersBlock}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground" data-testid="unknown-provider-placeholder">
            {t("unknownProviderType")}
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
            onModelsChange={(models) => void onPersistLocalModels(models)}
          />
        ) : isCustom ? (
          // The Models slot is fill-height (it owns its own scroller),
          // so these text fallbacks bring their own padding.
          <div className="p-4 text-sm text-muted-foreground">
            {t("customProviderModelsManaged")}
          </div>
        ) : selectedBuiltIn ? (
          <ProviderModelsTab
            providerId={selectedId}
            models={enrichedBuiltInModels}
            enabledModels={selectedSettings?.enabledModels ?? []}
            onEnabledModelsChange={(ids) =>
              void setProviderConfig(selectedId, { enabledModels: ids })
            }
            onRefreshModels={onRefreshModels}
            isRefreshing={isRefreshingModels}
            onTestConnection={onTestConnection}
            isTesting={!!s.testingProviders[selectedId]}
            metadataLoading={modelsDevLoading}
            diagnosticStatusByModel={diagnosticStatusByModel}
          />
        ) : (
          <div className="p-4 text-sm text-muted-foreground">{t("noModelsAvailable")}</div>
        )
      }
      usageTab={isLocalProvider ? undefined : <ProviderCostTab providerId={selectedId} />}
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
    />
  )
}
