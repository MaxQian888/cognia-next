"use client"

/**
 * CLIProxyAPI Settings Component
 * Provides UI for server configuration, WebUI access, and model management
 * https://help.router-for.me
 */

import { useState, useEffect, useCallback, useMemo } from "react"
import { useTranslations } from "next-intl"
import {
  Server,
  RefreshCw,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  Loader2,
  Settings2,
  Globe,
  Check,
  Copy,
  Zap,
  LayoutDashboard,
  List,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { useSettingsStore } from "@/stores"
import type {
  CLIProxyAPIProviderSettings,
  ProviderModelDiscoveryEntry,
} from "@cognia/provider-types"
import { testConnection, getWebUIURL, getAPIURL } from "@cognia/provider-core/providers/cliproxyapi"
import { discoverCLIProxyAPIModels } from "@cognia/provider-core/providers/model-discovery"

interface CLIProxyAPISettingsProps {
  className?: string
}

export function CLIProxyAPISettings({ className }: CLIProxyAPISettingsProps) {
  const t = useTranslations("providers")
  const providerSettings = useSettingsStore((state) => state.providerSettings)
  const updateProviderSettings = useSettingsStore((state) => state.updateProviderSettings)

  const settings = providerSettings.cliproxyapi
  const apiKey = settings?.apiKey
  const enabled = settings?.enabled
  const discoveredModels = settings?.discoveredModels
  const cliProxyAPISettings = useMemo(
    () => settings?.cliProxyAPISettings || {},
    [settings?.cliProxyAPISettings]
  )

  const [isConnectionTesting, setIsConnectionTesting] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<
    "connected" | "disconnected" | "error" | null
  >(null)
  const [connectionLatency, setConnectionLatency] = useState<number | null>(null)
  const [connectionError, setConnectionError] = useState<string | null>(null)

  const [isModelsLoading, setIsModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)

  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false)
  const [isModelsOpen, setIsModelsOpen] = useState(false)
  const [copiedUrl, setCopiedUrl] = useState(false)

  const host = cliProxyAPISettings.host || "localhost"
  const port = cliProxyAPISettings.port || 8317

  const availableModels = useMemo<ProviderModelDiscoveryEntry[]>(
    () => discoveredModels || [],
    [discoveredModels]
  )

  const updateCLIProxyAPISettings = useCallback(
    (updates: Partial<CLIProxyAPIProviderSettings>) => {
      updateProviderSettings("cliproxyapi", {
        cliProxyAPISettings: {
          ...cliProxyAPISettings,
          ...updates,
        },
      })
    },
    [cliProxyAPISettings, updateProviderSettings]
  )

  const handleTestConnection = useCallback(async () => {
    if (!apiKey) return

    setIsConnectionTesting(true)
    setConnectionError(null)

    try {
      const result = await testConnection(apiKey, host, port)

      if (result.success) {
        setConnectionStatus("connected")
        setConnectionLatency(result.latency || null)
        updateCLIProxyAPISettings({
          connectionStatus: "connected",
          lastHealthCheck: Date.now(),
        })
      } else {
        setConnectionStatus("error")
        setConnectionError(result.message)
        updateCLIProxyAPISettings({
          connectionStatus: "error",
        })
      }
    } catch (error) {
      setConnectionStatus("error")
      setConnectionError(error instanceof Error ? error.message : "Connection failed")
      updateCLIProxyAPISettings({
        connectionStatus: "error",
      })
    } finally {
      setIsConnectionTesting(false)
    }
  }, [apiKey, host, port, updateCLIProxyAPISettings])

  const handleFetchModels = useCallback(async () => {
    if (!apiKey) return

    setIsModelsLoading(true)
    setModelsError(null)

    try {
      const models = await discoverCLIProxyAPIModels({
        apiKey,
        host,
        port,
      })
      const fetchedAt = Date.now()
      updateProviderSettings("cliproxyapi", {
        discoveredModels: models,
        discoveredModelsLastFetched: fetchedAt,
        cliProxyAPISettings: {
          ...cliProxyAPISettings,
          availableModels: models.map((m) => m.id),
          modelsLastFetched: fetchedAt,
        },
      })
    } catch (error) {
      setModelsError(error instanceof Error ? error.message : "Failed to fetch models")
    } finally {
      setIsModelsLoading(false)
    }
  }, [cliProxyAPISettings, host, port, apiKey, updateProviderSettings])

  const handleOpenWebUI = useCallback(() => {
    const url = getWebUIURL(host, port)
    window.open(url, "_blank", "noopener,noreferrer")
    updateCLIProxyAPISettings({
      webUIEnabled: true,
      webUILastOpened: Date.now(),
    })
  }, [host, port, updateCLIProxyAPISettings])

  const handleCopyAPIUrl = useCallback(() => {
    const url = getAPIURL(host, port)
    navigator.clipboard.writeText(url)
    setCopiedUrl(true)
    setTimeout(() => setCopiedUrl(false), 2000)
  }, [host, port])

  // Auto-test connection when API key changes
  useEffect(() => {
    if (!apiKey || !enabled) return
    const timer = setTimeout(() => {
      handleTestConnection()
    }, 0)
    return () => clearTimeout(timer)
  }, [apiKey, enabled, handleTestConnection])

  if (!enabled) {
    return null
  }

  return (
    <div className={className}>
      {/* Connection Status Card */}
      <Card className="mb-4">
        <CardHeader className="py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Server className="h-4 w-4 text-blue-500" />
              <CardTitle className="text-sm">{t("serverStatus")}</CardTitle>
              {connectionStatus === "connected" && (
                <Badge variant="success" className="text-xs">
                  <Check className="h-3 w-3 mr-1" />
                  {t("connected")}
                </Badge>
              )}
              {connectionStatus === "error" && (
                <Badge variant="destructive" className="text-xs">
                  <AlertCircle className="h-3 w-3 mr-1" />
                  {t("status.error")}
                </Badge>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleTestConnection}
              disabled={isConnectionTesting || !settings?.apiKey}
            >
              {isConnectionTesting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="py-2">
          {connectionError ? (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {connectionError}
            </div>
          ) : connectionStatus === "connected" ? (
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground">{t("endpoint")}</p>
                <div className="flex items-center gap-2">
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                    {host}:{port}
                  </code>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={handleCopyAPIUrl}
                        >
                          {copiedUrl ? (
                            <Check className="h-3 w-3 text-green-500" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{copiedUrl ? t("copied") : t("copyApiUrl")}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </div>
              {connectionLatency && (
                <div>
                  <p className="text-muted-foreground">{t("latency")}</p>
                  <p className="font-medium text-green-600">{connectionLatency}ms</p>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("clickRefreshToTest")}</p>
          )}
        </CardContent>
      </Card>

      {/* WebUI Access Card */}
      <Card className="mb-4">
        <CardHeader className="py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <LayoutDashboard className="h-4 w-4 text-purple-500" />
              <CardTitle className="text-sm">{t("managementWebUI")}</CardTitle>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleOpenWebUI}
              disabled={connectionStatus !== "connected"}
            >
              <ExternalLink className="h-4 w-4 mr-2" />
              {t("openWebUI")}
            </Button>
          </div>
          <CardDescription className="text-xs">{t("webUIDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="py-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Globe className="h-3 w-3" />
            <a
              href={getWebUIURL(host, port)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              {getWebUIURL(host, port)}
            </a>
          </div>
        </CardContent>
      </Card>

      {/* Available Models Section */}
      <Collapsible open={isModelsOpen} onOpenChange={setIsModelsOpen}>
        <Card className="mb-4">
          <CollapsibleTrigger asChild>
            <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <List className="h-4 w-4" />
                  <CardTitle className="text-sm">{t("availableModels")}</CardTitle>
                  {availableModels.length > 0 && (
                    <Badge variant="secondary" className="ml-2">
                      {availableModels.length}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleFetchModels()
                    }}
                    disabled={isModelsLoading || !settings?.apiKey}
                  >
                    {isModelsLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4" />
                    )}
                  </Button>
                  {isModelsOpen ? (
                    <ChevronUp className="h-4 w-4" />
                  ) : (
                    <ChevronDown className="h-4 w-4" />
                  )}
                </div>
              </div>
              <CardDescription className="text-xs">{t("modelsAvailableThrough")}</CardDescription>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="pt-0">
              {modelsError ? (
                <div className="flex items-center gap-2 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4" />
                  {modelsError}
                </div>
              ) : availableModels.length > 0 ? (
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {availableModels.map((model) => (
                    <div
                      key={model.id}
                      className="flex items-center justify-between p-2 rounded-lg border bg-muted/30 text-sm"
                    >
                      <div className="flex items-center gap-2">
                        <Zap className="h-3 w-3 text-muted-foreground" />
                        <span className="font-mono text-xs">{model.id}</span>
                      </div>
                      {model.provider && (
                        <Badge variant="outline" className="text-xs">
                          {model.provider}
                        </Badge>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-4">
                  {t("clickRefreshToLoad")}
                </p>
              )}
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      {/* Server Configuration Section */}
      <Collapsible open={isAdvancedOpen} onOpenChange={setIsAdvancedOpen}>
        <Card>
          <CollapsibleTrigger asChild>
            <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Settings2 className="h-4 w-4" />
                  <CardTitle className="text-sm">{t("serverConfiguration")}</CardTitle>
                </div>
                {isAdvancedOpen ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </div>
              <CardDescription className="text-xs">{t("configDescription")}</CardDescription>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="pt-0 space-y-4">
              {/* Host and Port */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="cliproxy-host" className="text-xs">
                    {t("host")}
                  </Label>
                  <Input
                    id="cliproxy-host"
                    placeholder="localhost"
                    value={cliProxyAPISettings.host || ""}
                    onChange={(e) =>
                      updateCLIProxyAPISettings({ host: e.target.value || "localhost" })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="cliproxy-port" className="text-xs">
                    {t("port")}
                  </Label>
                  <Input
                    id="cliproxy-port"
                    type="number"
                    placeholder="8317"
                    value={cliProxyAPISettings.port || ""}
                    onChange={(e) =>
                      updateCLIProxyAPISettings({ port: parseInt(e.target.value) || 8317 })
                    }
                  />
                </div>
              </div>

              <Separator />

              {/* Routing Strategy */}
              <div className="space-y-2">
                <Label htmlFor="routing-strategy" className="text-xs">
                  {t("routingStrategy")}
                </Label>
                <Select
                  value={cliProxyAPISettings.routingStrategy || "round-robin"}
                  onValueChange={(value) =>
                    updateCLIProxyAPISettings({
                      routingStrategy: value as "round-robin" | "fill-first",
                    })
                  }
                >
                  <SelectTrigger id="routing-strategy">
                    <SelectValue placeholder="Select strategy" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="round-robin">{t("roundRobin")}</SelectItem>
                    <SelectItem value="fill-first">{t("fillFirst")}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t("routingHint")}</p>
              </div>

              <Separator />

              {/* Retry Settings */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="request-retry" className="text-xs">
                    {t("requestRetries")}
                  </Label>
                  <Input
                    id="request-retry"
                    type="number"
                    placeholder="3"
                    value={cliProxyAPISettings.requestRetry || ""}
                    onChange={(e) =>
                      updateCLIProxyAPISettings({ requestRetry: parseInt(e.target.value) || 3 })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="max-retry-interval" className="text-xs">
                    {t("maxRetryInterval")}
                  </Label>
                  <Input
                    id="max-retry-interval"
                    type="number"
                    placeholder="30"
                    value={cliProxyAPISettings.maxRetryInterval || ""}
                    onChange={(e) =>
                      updateCLIProxyAPISettings({
                        maxRetryInterval: parseInt(e.target.value) || 30,
                      })
                    }
                  />
                </div>
              </div>

              <Separator />

              {/* Quota Exceeded Behavior */}
              <div className="space-y-3">
                <Label className="text-xs font-medium">{t("quotaExceeded")}</Label>
                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="switch-project" className="text-xs">
                      {t("autoSwitchProject")}
                    </Label>
                    <p className="text-xs text-muted-foreground">{t("routingHint")}</p>
                  </div>
                  <Switch
                    id="switch-project"
                    checked={cliProxyAPISettings.quotaExceededSwitchProject ?? true}
                    onCheckedChange={(checked) =>
                      updateCLIProxyAPISettings({ quotaExceededSwitchProject: checked })
                    }
                  />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="switch-preview" className="text-xs">
                      {t("autoSwitchPreview")}
                    </Label>
                    <p className="text-xs text-muted-foreground">{t("routingHint")}</p>
                  </div>
                  <Switch
                    id="switch-preview"
                    checked={cliProxyAPISettings.quotaExceededSwitchPreviewModel ?? true}
                    onCheckedChange={(checked) =>
                      updateCLIProxyAPISettings({ quotaExceededSwitchPreviewModel: checked })
                    }
                  />
                </div>
              </div>

              <Separator />

              {/* Streaming Settings */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="keepalive-seconds" className="text-xs">
                    {t("keepaliveInterval")}
                  </Label>
                  <Input
                    id="keepalive-seconds"
                    type="number"
                    placeholder="15"
                    value={cliProxyAPISettings.streamingKeepaliveSeconds || ""}
                    onChange={(e) =>
                      updateCLIProxyAPISettings({
                        streamingKeepaliveSeconds: parseInt(e.target.value) || 0,
                      })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="bootstrap-retries" className="text-xs">
                    {t("bootstrapRetries")}
                  </Label>
                  <Input
                    id="bootstrap-retries"
                    type="number"
                    placeholder="1"
                    value={cliProxyAPISettings.streamingBootstrapRetries || ""}
                    onChange={(e) =>
                      updateCLIProxyAPISettings({
                        streamingBootstrapRetries: parseInt(e.target.value) || 0,
                      })
                    }
                  />
                </div>
              </div>

              <Separator />

              {/* Management Key */}
              <div className="space-y-2">
                <Label htmlFor="management-key" className="text-xs">
                  {t("managementKey")}
                </Label>
                <Input
                  id="management-key"
                  type="password"
                  placeholder={t("managementKeyPlaceholder")}
                  value={cliProxyAPISettings.managementKey || ""}
                  onChange={(e) => updateCLIProxyAPISettings({ managementKey: e.target.value })}
                  autoComplete="new-password"
                  data-lpignore="true"
                  data-form-type="other"
                />
                <p className="text-xs text-muted-foreground">{t("managementKeyHint")}</p>
              </div>

              {/* Documentation Link */}
              <div className="text-xs text-muted-foreground pt-2">
                <a
                  href="https://help.router-for.me/configuration/options.html"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-primary hover:underline"
                >
                  {t("viewDocumentation")} <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>
    </div>
  )
}
