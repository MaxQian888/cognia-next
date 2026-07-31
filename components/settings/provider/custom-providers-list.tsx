"use client"

import React, { useCallback } from "react"
import { Plus, Edit2, RefreshCw, Loader2, Check, AlertCircle } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import type { CustomProviderSettings as TypesCustomProviderSettings } from "@cognia/provider-types"
import type { CustomProviderSettings as StoreCustomProviderSettings } from "@/stores/settings/settings-store"

type AnyCustomProvider = TypesCustomProviderSettings | StoreCustomProviderSettings

interface CustomProvidersListProps {
  providers: Record<string, AnyCustomProvider>
  testResults: Record<string, "success" | "error" | "limited" | null>
  testMessages: Record<string, string | null>
  testingProviders: Record<string, boolean>
  onTestProvider: (providerId: string) => void
  onEditProvider: (providerId: string) => void
  onToggleProvider: (providerId: string, enabled: boolean) => void
  onAddProvider: () => void
  onQuickAdd?: () => void
  searchQuery?: string
}

function getProviderName(provider: AnyCustomProvider): string {
  if ("customName" in provider && provider.customName) return provider.customName
  if ("name" in provider && provider.name) return provider.name
  return ""
}

function getProviderModels(provider: AnyCustomProvider): string[] {
  if ("customModels" in provider && provider.customModels?.length) return provider.customModels
  if ("discoveredModels" in provider && Array.isArray(provider.discoveredModels)) {
    return provider.discoveredModels.map((model) => model.name || model.id)
  }
  if ("models" in provider && Array.isArray(provider.models)) return provider.models
  return []
}

export const CustomProvidersListItem = React.memo(function CustomProvidersListItem({
  providerId: _providerId,
  provider,
  testResult,
  testMessage,
  isTesting,
  onTest,
  onEdit,
  onToggle,
}: {
  providerId: string
  provider: AnyCustomProvider
  testResult: "success" | "error" | "limited" | null
  testMessage: string | null
  isTesting: boolean
  onTest: () => void
  onEdit: () => void
  onToggle: (enabled: boolean) => void
}) {
  const t = useTranslations("providers")
  const canTest = !!provider.baseURL && !!provider.apiKey && !!provider.enabled

  return (
    <div className="flex items-center justify-between rounded-lg border p-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{getProviderName(provider)}</span>
          <Badge variant="secondary" className="text-xs">
            {getProviderModels(provider).length} {t("modelsCount")}
          </Badge>
          {provider.verificationStatus === "stale" && (
            <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-400">
              {t("verificationStaleShort")}
            </Badge>
          )}
          {testResult === "limited" && (
            <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-400">
              {t("verificationLimitedShort")}
            </Badge>
          )}
          {testResult === "success" && <Check className="h-4 w-4 text-green-500" />}
          {testResult === "error" && <AlertCircle className="h-4 w-4 text-destructive" />}
        </div>
        <p className="text-sm text-muted-foreground">{provider.baseURL}</p>
        {testMessage && (
          <p
            className={cn(
              "text-xs",
              testResult === "error"
                ? "text-destructive"
                : testResult === "limited"
                  ? "text-amber-600"
                  : "text-muted-foreground"
            )}
          >
            {testMessage}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={onTest}
          disabled={!canTest || isTesting}
          title={t("testConnection")}
        >
          {isTesting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
        </Button>
        <Button variant="ghost" size="icon" onClick={onEdit}>
          <Edit2 className="h-4 w-4" />
        </Button>
        <Switch checked={provider.enabled} onCheckedChange={onToggle} />
      </div>
    </div>
  )
})

export const CustomProvidersList = React.memo(function CustomProvidersList({
  providers,
  testResults,
  testMessages,
  testingProviders,
  onTestProvider,
  onEditProvider,
  onToggleProvider,
  onAddProvider,
  onQuickAdd,
  searchQuery = "",
}: CustomProvidersListProps) {
  const t = useTranslations("providers")

  // Filter providers by search query
  const filteredProviders = React.useMemo(() => {
    if (!searchQuery.trim()) return providers
    const query = searchQuery.toLowerCase()
    return Object.fromEntries(
      Object.entries(providers).filter(([_id, provider]) => {
        const name = getProviderName(provider)
        const models = getProviderModels(provider)
        const matchesName = name.toLowerCase().includes(query)
        const matchesUrl = (provider.baseURL || "").toLowerCase().includes(query)
        const matchesModel = models.some((m: string) => m.toLowerCase().includes(query))
        return matchesName || matchesUrl || matchesModel
      })
    )
  }, [providers, searchQuery])

  const handleTest = useCallback(
    (providerId: string) => () => onTestProvider(providerId),
    [onTestProvider]
  )

  const handleEdit = useCallback(
    (providerId: string) => () => onEditProvider(providerId),
    [onEditProvider]
  )

  const handleToggle = useCallback(
    (providerId: string) => (enabled: boolean) => onToggleProvider(providerId, enabled),
    [onToggleProvider]
  )

  const providerCount = Object.keys(providers).length
  const filteredCount = Object.keys(filteredProviders).length

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5 min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              {t("customProviders")}
              <Badge variant="outline" className="text-[10px]">
                {t("openaiCompatible")}
              </Badge>
            </CardTitle>
            <CardDescription className="text-xs">{t("customProvidersDescription")}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {onQuickAdd && (
              <Button variant="default" size="sm" className="shrink-0" onClick={onQuickAdd}>
                <Plus className="h-4 w-4 mr-1.5" />
                {t("quickAdd")}
              </Button>
            )}
            <Button variant="outline" size="sm" className="shrink-0" onClick={onAddProvider}>
              <Plus className="h-4 w-4 mr-1.5" />
              {t("addCustom")}
            </Button>
          </div>
        </div>
      </CardHeader>

      {providerCount === 0 ? (
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          {t("noCustomProviders")}
        </CardContent>
      ) : filteredCount === 0 && searchQuery.trim() ? (
        <CardContent className="py-6 text-center text-sm text-muted-foreground">
          {t("noProvidersFound")}
        </CardContent>
      ) : filteredCount > 0 ? (
        <CardContent className="space-y-4">
          {Object.entries(filteredProviders).map(([providerId, provider]) => (
            <CustomProvidersListItem
              key={providerId}
              providerId={providerId}
              provider={provider}
              testResult={testResults[providerId]}
              testMessage={testMessages[providerId]}
              isTesting={testingProviders[providerId] || false}
              onTest={handleTest(providerId)}
              onEdit={handleEdit(providerId)}
              onToggle={handleToggle(providerId)}
            />
          ))}
        </CardContent>
      ) : null}
    </Card>
  )
})

export default CustomProvidersList
