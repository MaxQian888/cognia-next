"use client"

/**
 * LocalProviderSettings - Unified settings panel for all local AI providers
 *
 * Provides a consolidated view of all local inference engines with:
 * - Auto-detection of running providers
 * - Quick configuration and connection testing
 * - Model management for supported providers
 */

import { useState, useEffect, useCallback } from "react"
import {
  Server,
  Check,
  Loader2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Download,
  Scan,
  Zap,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { loggers } from "@/lib/logger"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { LocalProviderName } from "@/types/provider/local-provider"
import { LOCAL_PROVIDER_CONFIGS } from "@/lib/ai/providers/local-providers"
import {
  getProviderCapabilities,
  checkAllProvidersInstallation,
  type InstallCheckResult,
} from "@/lib/ai/providers/local-provider-service"
import { useSettingsStore } from "@/stores"
import { useLocalProvidersScan } from "@/hooks/provider/use-local-provider"
import { LocalProviderCard } from "./local-provider-card"
import { LocalProviderModelManager } from "./local-provider-model-manager"
import { LocalProviderSetupWizard } from "./local-provider-setup-wizard"

// Group providers by category
const PROVIDER_GROUPS = {
  recommended: ["ollama", "lmstudio", "jan"] as LocalProviderName[],
  advanced: ["llamacpp", "llamafile", "vllm", "localai"] as LocalProviderName[],
  specialized: ["textgenwebui", "koboldcpp", "tabbyapi"] as LocalProviderName[],
}

export interface LocalProviderSettingsProps {
  onProviderSelect?: (providerId: LocalProviderName) => void
}

const log = loggers.native.child("local-provider-settings")

export function LocalProviderSettings(_props: LocalProviderSettingsProps) {
  const t = useTranslations("providers")

  const providerSettings = useSettingsStore((state) => state.providerSettings)
  const updateProviderSettings = useSettingsStore((state) => state.updateProviderSettings)

  const [isScanning, setIsScanning] = useState(false)
  const [scanResults, setScanResults] = useState<Map<LocalProviderName, InstallCheckResult>>(
    new Map()
  )
  const [expandedGroup, setExpandedGroup] = useState<string>("recommended")
  const [selectedProvider, setSelectedProvider] = useState<LocalProviderName | null>(null)
  const [showModelManager, setShowModelManager] = useState(false)
  const [showSetupWizard, setShowSetupWizard] = useState(false)
  const [setupWizardProvider, setSetupWizardProvider] = useState<LocalProviderName | null>(null)

  // Use the unified hook for quick server status scan
  const {
    detected: serverStatusResults,
    isScanning: isServerScanning,
    scan: serverScan,
  } = useLocalProvidersScan()

  // Scan for installed providers
  const scanProviders = useCallback(async () => {
    setIsScanning(true)
    try {
      const results = await checkAllProvidersInstallation()
      const resultMap = new Map<LocalProviderName, InstallCheckResult>()
      results.forEach((r) => resultMap.set(r.providerId, r))
      setScanResults(resultMap)
      // Also trigger the hook-based server status scan
      serverScan()
    } catch (error) {
      log.error("Failed to scan providers", error)
    } finally {
      setIsScanning(false)
    }
  }, [serverScan])

  // Initial scan on mount
  useEffect(() => {
    const timer = setTimeout(() => {
      scanProviders()
    }, 0)
    return () => clearTimeout(timer)
  }, [scanProviders])

  // Get provider status - enriched with hook-based server status
  const getProviderStatus = (providerId: LocalProviderName) => {
    const result = scanResults.get(providerId)
    const serverStatus = serverStatusResults.get(providerId)
    const settings = providerSettings[providerId]
    return {
      isConnected: result?.running ?? serverStatus?.connected ?? false,
      isInstalled: result?.installed ?? false,
      version: result?.version ?? serverStatus?.version,
      error: result?.error ?? serverStatus?.error,
      enabled: settings?.enabled ?? false,
      baseUrl: settings?.baseURL || LOCAL_PROVIDER_CONFIGS[providerId].defaultBaseURL,
      latency: serverStatus?.latency_ms,
      modelsCount: serverStatus?.models_count,
    }
  }

  // Count running providers
  const runningCount = Array.from(scanResults.values()).filter((r) => r.running).length
  const installedCount = Array.from(scanResults.values()).filter((r) => r.installed).length
  const _isAnyScanning = isScanning || isServerScanning

  // Handle provider toggle
  const handleToggleProvider = (providerId: LocalProviderName, enabled: boolean) => {
    updateProviderSettings(providerId, { enabled })
  }

  // Handle base URL change
  const handleBaseUrlChange = (providerId: LocalProviderName, baseURL: string) => {
    updateProviderSettings(providerId, { baseURL })
  }

  // Handle test connection
  const handleTestConnection = async (providerId: LocalProviderName) => {
    const settings = providerSettings[providerId]
    const baseUrl = settings?.baseURL || LOCAL_PROVIDER_CONFIGS[providerId].defaultBaseURL

    try {
      const { LocalProviderService } = await import("@/lib/ai/providers/local-provider-service")
      const service = new LocalProviderService(providerId, baseUrl)
      const status = await service.getStatus()

      // Update scan results
      setScanResults((prev) => {
        const next = new Map(prev)
        next.set(providerId, {
          providerId,
          installed: status.connected,
          running: status.connected,
          version: status.version,
          error: status.error,
        })
        return next
      })

      return {
        success: status.connected,
        message: status.connected
          ? `Connected${status.version ? ` v${status.version}` : ""}${status.models_count ? ` (${status.models_count} models)` : ""}`
          : status.error || "Connection failed",
        latency: status.latency_ms,
      }
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : "Connection failed",
      }
    }
  }

  // Handle manage models
  const handleManageModels = (providerId: LocalProviderName) => {
    setSelectedProvider(providerId)
    setShowModelManager(true)
  }

  // Handle setup wizard
  const handleSetupWizard = (providerId: LocalProviderName) => {
    setSetupWizardProvider(providerId)
    setShowSetupWizard(true)
  }

  // Render provider group
  const renderProviderGroup = (
    groupId: string,
    providerIds: LocalProviderName[],
    title: string,
    description: string
  ) => {
    const isExpanded = expandedGroup === groupId
    const groupRunning = providerIds.filter((id) => scanResults.get(id)?.running).length

    return (
      <Collapsible
        key={groupId}
        open={isExpanded}
        onOpenChange={() => setExpandedGroup(isExpanded ? "" : groupId)}
      >
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="w-full justify-between p-3 h-auto">
            <div className="flex items-center gap-3">
              <Server className="h-4 w-4 text-muted-foreground" />
              <div className="text-left">
                <div className="font-medium">{title}</div>
                <div className="text-xs text-muted-foreground">{description}</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {groupRunning > 0 && (
                <Badge variant="success">
                  {groupRunning} {t("running")}
                </Badge>
              )}
              {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </div>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="px-3 pb-3 space-y-3">
          {providerIds.map((providerId) => {
            const status = getProviderStatus(providerId)
            const capabilities = getProviderCapabilities(providerId)

            return (
              <LocalProviderCard
                key={providerId}
                providerId={providerId}
                enabled={status.enabled}
                baseUrl={status.baseUrl}
                isConnected={status.isConnected}
                isLoading={isScanning}
                version={status.version}
                modelsCount={undefined}
                latency={undefined}
                error={status.error}
                onToggle={(enabled) => handleToggleProvider(providerId, enabled)}
                onBaseUrlChange={(url) => handleBaseUrlChange(providerId, url)}
                onTestConnection={() => handleTestConnection(providerId)}
                onManageModels={
                  capabilities.canPullModels || capabilities.canListModels
                    ? () => handleManageModels(providerId)
                    : undefined
                }
              />
            )
          })}
        </CollapsibleContent>
      </Collapsible>
    )
  }

  return (
    <TooltipProvider>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Server className="h-5 w-5" />
                {t("localProvidersTitle")}
              </CardTitle>
              <CardDescription>{t("localProvidersDescription")}</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {runningCount > 0 && (
                <Badge variant="success">
                  <Zap className="h-3 w-3 mr-1" />
                  {runningCount} {t("running")}
                </Badge>
              )}
              <Button variant="outline" size="sm" onClick={scanProviders} disabled={isScanning}>
                {isScanning ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                ) : (
                  <Scan className="h-4 w-4 mr-1" />
                )}
                {t("scan")}
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-1">
          {/* Quick stats */}
          <div className="flex items-center gap-4 text-sm text-muted-foreground mb-4">
            <span className="flex items-center gap-1">
              <Check className="h-3.5 w-3.5 text-green-500" />
              {installedCount} {t("installed")}
            </span>
            <span className="flex items-center gap-1">
              <Zap className="h-3.5 w-3.5 text-primary" />
              {runningCount} {t("running")}
            </span>
          </div>

          {/* Provider groups */}
          <div className="space-y-1 border rounded-lg">
            {renderProviderGroup(
              "recommended",
              PROVIDER_GROUPS.recommended,
              t("providerGroups.recommended"),
              t("providerGroups.recommendedDesc")
            )}
            {renderProviderGroup(
              "advanced",
              PROVIDER_GROUPS.advanced,
              t("providerGroups.advanced"),
              t("providerGroups.advancedDesc")
            )}
            {renderProviderGroup(
              "specialized",
              PROVIDER_GROUPS.specialized,
              t("providerGroups.specialized"),
              t("providerGroups.specializedDesc")
            )}
          </div>

          {/* Quick actions */}
          <div className="flex gap-2 pt-4">
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => handleSetupWizard("ollama")}
            >
              <Download className="h-4 w-4 mr-1" />
              {t("quickSetup")}
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href="https://ollama.ai/library" target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4 mr-1" />
                {t("browseModels")}
              </a>
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Model Manager Dialog */}
      <Dialog open={showModelManager} onOpenChange={setShowModelManager}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {selectedProvider &&
                t("providerModels", { provider: LOCAL_PROVIDER_CONFIGS[selectedProvider].name })}
            </DialogTitle>
            <DialogDescription>{t("manageInstalledModels")}</DialogDescription>
          </DialogHeader>
          {selectedProvider && (
            <LocalProviderModelManager
              providerId={selectedProvider}
              baseUrl={providerSettings[selectedProvider]?.baseURL}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Setup Wizard Dialog */}
      <Dialog open={showSetupWizard} onOpenChange={setShowSetupWizard}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {setupWizardProvider &&
                t("providerSetup", { provider: LOCAL_PROVIDER_CONFIGS[setupWizardProvider]?.name })}
            </DialogTitle>
            <DialogDescription>{t("followStepsToStart")}</DialogDescription>
          </DialogHeader>
          {setupWizardProvider && (
            <LocalProviderSetupWizard
              providerId={setupWizardProvider}
              onComplete={() => {
                setShowSetupWizard(false)
                scanProviders()
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}

export default LocalProviderSettings
