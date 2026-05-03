"use client"

/**
 * LocalProviderCard - Reusable card component for local AI providers
 *
 * Displays connection status, configuration, and quick actions for any
 * OpenAI-compatible local inference engine.
 */

import { useState, useCallback } from "react"
import {
  Server,
  Check,
  AlertCircle,
  ExternalLink,
  RefreshCw,
  Loader2,
  Settings,
  ChevronDown,
  ChevronUp,
  Download,
  Cpu,
  Zap,
  Wrench,
  ImageIcon,
  MessageSquare,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { LocalProviderName } from "@/types/provider/local-provider"
import { LOCAL_PROVIDER_CONFIGS } from "@/lib/ai/providers/local-providers"
import {
  getProviderCapabilities,
  getInstallInstructions,
} from "@/lib/ai/providers/local-provider-service"

export interface LocalProviderCardProps {
  providerId: LocalProviderName
  enabled: boolean
  baseUrl: string
  isConnected: boolean
  isLoading: boolean
  version?: string
  modelsCount?: number
  latency?: number
  error?: string
  onToggle: (enabled: boolean) => void
  onBaseUrlChange: (url: string) => void
  onTestConnection: () => Promise<{ success: boolean; message: string; latency?: number }>
  onManageModels?: () => void
  compact?: boolean
}

export function LocalProviderCard({
  providerId,
  enabled,
  baseUrl,
  isConnected,
  isLoading: _isLoading,
  version,
  modelsCount,
  latency,
  error,
  onToggle,
  onBaseUrlChange,
  onTestConnection,
  onManageModels,
  compact = false,
}: LocalProviderCardProps) {
  const t = useTranslations("providers")

  const [isExpanded, setIsExpanded] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [localBaseUrl, setLocalBaseUrl] = useState(baseUrl)

  const config = LOCAL_PROVIDER_CONFIGS[providerId]
  const capabilities = getProviderCapabilities(providerId)
  const installInfo = getInstallInstructions(providerId)

  const handleTestConnection = useCallback(async () => {
    setIsTesting(true)
    setTestResult(null)
    try {
      const result = await onTestConnection()
      setTestResult(result)
    } finally {
      setIsTesting(false)
    }
  }, [onTestConnection])

  const handleBaseUrlChange = useCallback(() => {
    if (localBaseUrl !== baseUrl) {
      onBaseUrlChange(localBaseUrl)
    }
  }, [localBaseUrl, baseUrl, onBaseUrlChange])

  const handleResetUrl = useCallback(() => {
    setLocalBaseUrl(config.defaultBaseURL)
    onBaseUrlChange(config.defaultBaseURL)
  }, [config.defaultBaseURL, onBaseUrlChange])

  // Compact view
  if (compact) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border p-2">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{config.name}</span>
          {isConnected && (
            <Badge variant="default" className="text-[10px] bg-green-600">
              <Check className="h-2.5 w-2.5 mr-0.5" />
              {t("connected")}
            </Badge>
          )}
        </div>
        <Switch checked={enabled} onCheckedChange={onToggle} className="scale-75" />
      </div>
    )
  }

  return (
    <Card className={cn(!enabled && "opacity-60")}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Server className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                {config.name}
                {version && (
                  <Badge variant="outline" className="text-[10px] font-normal">
                    v{version}
                  </Badge>
                )}
              </CardTitle>
              <CardDescription className="text-xs">{config.description}</CardDescription>
            </div>
          </div>
          <Switch checked={enabled} onCheckedChange={onToggle} />
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Connection Status */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div
              className={cn(
                "h-2 w-2 rounded-full",
                isConnected ? "bg-green-500" : "bg-destructive"
              )}
            />
            <span className="text-sm text-muted-foreground">
              {isConnected ? (
                <>
                  {t("connected")}
                  {modelsCount !== undefined && (
                    <span className="ml-1">({modelsCount} models)</span>
                  )}
                  {latency && <span className="ml-1 text-xs opacity-70">{latency}ms</span>}
                </>
              ) : (
                error || t("disconnected")
              )}
            </span>
          </div>
          <div className="flex items-center gap-1">
            {capabilities.canPullModels && onManageModels && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={onManageModels}
                    disabled={!isConnected}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("manageModels")}</TooltipContent>
              </Tooltip>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleTestConnection}
              disabled={isTesting || !enabled}
            >
              {isTesting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        </div>

        {/* Test Result */}
        {testResult && (
          <div
            className={cn(
              "flex items-center gap-2 rounded-lg p-2 text-sm",
              testResult.success
                ? "bg-green-500/10 text-green-600"
                : "bg-destructive/10 text-destructive"
            )}
          >
            {testResult.success ? (
              <Check className="h-4 w-4" />
            ) : (
              <AlertCircle className="h-4 w-4" />
            )}
            {testResult.message}
          </div>
        )}

        {/* Capabilities */}
        <div className="flex flex-wrap gap-1.5">
          <CapabilityBadge
            icon={<MessageSquare className="h-3 w-3" />}
            label="Chat"
            enabled={true}
            t={t}
          />
          <CapabilityBadge
            icon={<Zap className="h-3 w-3" />}
            label="Stream"
            enabled={capabilities.supportsStreaming}
            t={t}
          />
          <CapabilityBadge
            icon={<ImageIcon className="h-3 w-3" />}
            label="Vision"
            enabled={capabilities.supportsVision}
            t={t}
          />
          <CapabilityBadge
            icon={<Wrench className="h-3 w-3" />}
            label="Tools"
            enabled={capabilities.supportsTools}
            t={t}
          />
          <CapabilityBadge
            icon={<Cpu className="h-3 w-3" />}
            label="Embed"
            enabled={capabilities.canGenerateEmbeddings}
            t={t}
          />
        </div>

        {/* Expandable Settings */}
        <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="w-full justify-between">
              <span className="flex items-center gap-1.5 text-xs">
                <Settings className="h-3 w-3" />
                {t("configuration")}
              </span>
              {isExpanded ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3 space-y-3">
            {/* Base URL */}
            <div className="space-y-1.5">
              <Label className="text-xs">{t("serverUrl")}</Label>
              <div className="flex gap-2">
                <Input
                  value={localBaseUrl}
                  onChange={(e) => setLocalBaseUrl(e.target.value)}
                  onBlur={handleBaseUrlChange}
                  placeholder={config.defaultBaseURL}
                  className="h-8 text-sm"
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      onClick={handleResetUrl}
                    >
                      <RefreshCw className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("resetToDefault")}</TooltipContent>
                </Tooltip>
              </div>
              <p className="text-[10px] text-muted-foreground">
                {t("default")}: {config.defaultBaseURL}
              </p>
            </div>

            {/* Documentation Link */}
            <Button variant="outline" size="sm" className="w-full justify-start text-xs" asChild>
              <a href={installInfo.docsUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3 w-3 mr-1.5" />
                {t("providerDocumentation", { provider: config.name })}
              </a>
            </Button>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  )
}

/**
 * Capability badge component
 */
function CapabilityBadge({
  icon,
  label,
  enabled,
  t,
}: {
  icon: React.ReactNode
  label: string
  enabled: boolean
  t: ReturnType<typeof useTranslations<"providers">>
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]",
            enabled ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground opacity-50"
          )}
        >
          {icon}
          {label}
        </div>
      </TooltipTrigger>
      <TooltipContent>
        {label}: {enabled ? t("supported") : t("notSupported")}
      </TooltipContent>
    </Tooltip>
  )
}

export default LocalProviderCard
