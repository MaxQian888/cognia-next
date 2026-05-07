"use client"

/**
 * ExternalAgentSettings - Settings component for managing external agents
 * Provides UI for configuring external agents, connection settings, and delegation rules
 */

import { useState, useCallback } from "react"
import { useTranslations } from "next-intl"
import {
  Plus,
  Trash2,
  Edit,
  Power,
  PowerOff,
  ExternalLink,
  Plug,
  PlugZap,
  AlertCircle,
  Loader2,
  Terminal,
  Globe,
  ChevronDown,
  ChevronRight,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Empty, EmptyMedia, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { useExternalAgent } from "@/hooks/agent/use-external-agent"
import {
  getExternalAgentEcosystemReadiness,
  getExternalAgentExecutionBlockReason,
} from "@/lib/ai/agent/external/config-normalizer"
import {
  getAvailablePresets,
  getPresetConfig,
  getPresetDisplayInfo,
  isFromPreset,
} from "@/lib/ai/agent/external/presets"
import type {
  ExternalAgentConnectionStatus,
  CreateExternalAgentInput,
  AcpPermissionMode,
  ExternalAgentProtocol,
  ExternalAgentTransport,
} from "@/types/agent/external-agent"

// =============================================================================
// Types
// =============================================================================

interface AgentFormData {
  name: string
  protocol: ExternalAgentProtocol
  transport: ExternalAgentTransport
  // Process config (for stdio)
  processCommand: string
  processArgs: string
  processCwd: string
  // Network config (for http/websocket)
  networkEndpoint: string
  networkApiKey: string
  // Settings
  defaultPermissionMode: AcpPermissionMode
  description: string
  timeoutMs: string
  retryMaxRetries: string
  retryDelayMs: string
  retryExponentialBackoff: boolean
  retryMaxDelayMs: string
  retryOnErrors: string
}

const DEFAULT_TIMEOUT_MS = "300000"
const DEFAULT_RETRY_MAX_RETRIES = "3"
const DEFAULT_RETRY_DELAY_MS = "1000"
const DEFAULT_RETRY_MAX_DELAY_MS = "30000"

const DEFAULT_FORM_DATA: AgentFormData = {
  name: "",
  protocol: "acp",
  transport: "stdio",
  processCommand: "",
  processArgs: "",
  processCwd: "",
  networkEndpoint: "",
  networkApiKey: "",
  defaultPermissionMode: "default",
  description: "",
  timeoutMs: DEFAULT_TIMEOUT_MS,
  retryMaxRetries: DEFAULT_RETRY_MAX_RETRIES,
  retryDelayMs: DEFAULT_RETRY_DELAY_MS,
  retryExponentialBackoff: true,
  retryMaxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS,
  retryOnErrors: "",
}

// =============================================================================
// Connection Status Components
// =============================================================================

function ConnectionStatusIcon({ status }: { status: ExternalAgentConnectionStatus }) {
  switch (status) {
    case "connected":
      return <PlugZap className="h-4 w-4 text-green-500" />
    case "connecting":
    case "reconnecting":
      return <Loader2 className="h-4 w-4 text-yellow-500 animate-spin" />
    case "error":
      return <AlertCircle className="h-4 w-4 text-destructive" />
    default:
      return <Plug className="h-4 w-4 text-muted-foreground" />
  }
}

// =============================================================================
// Agent Editor Dialog
// =============================================================================

interface AgentEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingAgentId?: string | null
  /**
   * Optional preset id to seed the dialog with when opened from the
   * quick-start gallery. Empty string means "manual configuration".
   */
  initialPreset?: string
  onSave: (data: CreateExternalAgentInput) => void
}

function AgentEditorDialog({
  open,
  onOpenChange,
  editingAgentId,
  initialPreset,
  onSave,
}: AgentEditorDialogProps) {
  const t = useTranslations("externalAgent.settings")
  const tCommon = useTranslations("common")
  const { getAgent } = useExternalAgentStore()

  // Quick-start preset selector — mirrors the chat-side AddAgentDialog pattern
  // in `components/agent/external-agent-manager.tsx`. Picking a preset fills
  // the form fields and stamps `metadata.preset` on save so `isFromPreset()`
  // can later badge the row.
  const [selectedPreset, setSelectedPreset] = useState<string>(initialPreset ?? "")

  const [formData, setFormData] = useState<AgentFormData>(() => {
    // Quick-start gallery: open with the preset's defaults so the user only
    // has to tweak env vars / cwd before saving.
    if (!editingAgentId && initialPreset && initialPreset !== "custom") {
      const preset = getPresetConfig(initialPreset)
      if (preset) {
        return {
          ...DEFAULT_FORM_DATA,
          name: preset.name,
          protocol: preset.protocol,
          transport: preset.transport,
          processCommand: preset.process?.command ?? "",
          processArgs: preset.process?.args.join(" ") ?? "",
          networkEndpoint: preset.network?.endpoint ?? "",
          defaultPermissionMode: preset.defaultPermissionMode,
          description: preset.description,
        }
      }
    }
    if (!editingAgentId) {
      return DEFAULT_FORM_DATA
    }

    const agent = getAgent(editingAgentId)
    if (!agent) {
      return DEFAULT_FORM_DATA
    }

    return {
      name: agent.name,
      protocol: agent.protocol,
      transport: agent.transport,
      processCommand: agent.process?.command || "",
      processArgs: agent.process?.args?.join(" ") || "",
      processCwd: agent.process?.cwd || "",
      networkEndpoint: agent.network?.endpoint || "",
      networkApiKey: agent.network?.apiKey || "",
      defaultPermissionMode: agent.defaultPermissionMode || "default",
      description: agent.description || "",
      timeoutMs: String(agent.timeout ?? DEFAULT_TIMEOUT_MS),
      retryMaxRetries: String(agent.retryConfig?.maxRetries ?? DEFAULT_RETRY_MAX_RETRIES),
      retryDelayMs: String(agent.retryConfig?.retryDelay ?? DEFAULT_RETRY_DELAY_MS),
      retryExponentialBackoff: agent.retryConfig?.exponentialBackoff ?? true,
      retryMaxDelayMs: String(agent.retryConfig?.maxRetryDelay ?? DEFAULT_RETRY_MAX_DELAY_MS),
      retryOnErrors: agent.retryConfig?.retryOnErrors?.join(", ") || "",
    }
  })

  const handleSave = useCallback(() => {
    const toNonNegativeInteger = (value: string, fallback: number): number => {
      const parsed = Number.parseInt(value, 10)
      if (Number.isNaN(parsed) || parsed < 0) {
        return fallback
      }
      return parsed
    }

    const retryOnErrors = formData.retryOnErrors
      .split(/\r?\n|,/)
      .map((pattern) => pattern.trim())
      .filter(Boolean)

    if (!formData.name.trim()) {
      toast.error(t("nameRequired"))
      return
    }

    const input: CreateExternalAgentInput = {
      name: formData.name.trim(),
      protocol: formData.protocol,
      transport: formData.transport,
      description: formData.description,
      defaultPermissionMode: formData.defaultPermissionMode,
      timeout: toNonNegativeInteger(formData.timeoutMs, Number.parseInt(DEFAULT_TIMEOUT_MS, 10)),
      retryConfig: {
        maxRetries: toNonNegativeInteger(
          formData.retryMaxRetries,
          Number.parseInt(DEFAULT_RETRY_MAX_RETRIES, 10)
        ),
        retryDelay: toNonNegativeInteger(
          formData.retryDelayMs,
          Number.parseInt(DEFAULT_RETRY_DELAY_MS, 10)
        ),
        exponentialBackoff: formData.retryExponentialBackoff,
        maxRetryDelay: toNonNegativeInteger(
          formData.retryMaxDelayMs,
          Number.parseInt(DEFAULT_RETRY_MAX_DELAY_MS, 10)
        ),
        retryOnErrors,
      },
    }

    if (formData.transport === "stdio") {
      if (!formData.processCommand.trim()) {
        toast.error(t("commandRequired"))
        return
      }
      input.process = {
        command: formData.processCommand.trim(),
        args: formData.processArgs.split(" ").filter(Boolean),
        cwd: formData.processCwd || undefined,
      }
    } else {
      if (!formData.networkEndpoint.trim()) {
        toast.error(t("endpointRequired"))
        return
      }
      input.network = {
        endpoint: formData.networkEndpoint.trim(),
        apiKey: formData.networkApiKey || undefined,
      }
    }

    if (selectedPreset && selectedPreset !== "custom") {
      const preset = getPresetConfig(selectedPreset)
      input.metadata = {
        preset: selectedPreset,
        ecosystemAdapterId: preset?.adapterId,
        ecosystemSurfaceId: preset?.surfaceId,
        ecosystemSupportTier: preset?.supportTier,
        ecosystemDocsUrl: preset?.docsUrl,
      }
    }

    onSave(input)
    onOpenChange(false)
    setFormData(DEFAULT_FORM_DATA)
    setSelectedPreset("")
  }, [formData, selectedPreset, onSave, onOpenChange, t])

  // Preset picker — keep tightly aligned with the chat-side AddAgentDialog
  // pattern. When a real preset is chosen, prefill the form fields so the user
  // only edits the truly variable bits (cwd, env keys). Choosing "" or
  // "custom" leaves the form alone.
  const handlePresetChange = useCallback(
    (presetId: string) => {
      setSelectedPreset(presetId)
      if (!presetId || presetId === "custom") return
      const preset = getPresetConfig(presetId)
      if (!preset) return
      setFormData((current) => ({
        ...current,
        name: preset.name,
        protocol: preset.protocol,
        transport: preset.transport,
        processCommand: preset.process?.command || current.processCommand,
        processArgs: preset.process?.args.join(" ") || current.processArgs,
        networkEndpoint: preset.network?.endpoint || current.networkEndpoint,
        defaultPermissionMode: preset.defaultPermissionMode,
        description: preset.description,
      }))
    },
    [setFormData]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{editingAgentId ? t("editAgent") : t("addAgent")}</DialogTitle>
          <DialogDescription>{t("agentConfigDescription")}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          {/* Quick start preset — only shown when creating, not when editing,
              to avoid silently overwriting hand-tuned fields. */}
          {!editingAgentId && (
            <div className="grid gap-2" data-testid="preset-picker">
              <Label>{t("quickStartPreset")}</Label>
              <Select value={selectedPreset || "custom"} onValueChange={handlePresetChange}>
                <SelectTrigger>
                  <SelectValue placeholder={t("selectPresetOrCustom")} />
                </SelectTrigger>
                <SelectContent>
                  {getAvailablePresets().map((presetId) => {
                    const preset = getPresetConfig(presetId)
                    if (!preset) return null
                    return (
                      <SelectItem key={presetId} value={presetId}>
                        <div className="flex items-center gap-2">
                          <span>{preset.name}</span>
                          {preset.tags.length > 0 && (
                            <span className="text-xs text-muted-foreground">
                              ({preset.tags.slice(0, 3).join(", ")})
                            </span>
                          )}
                        </div>
                      </SelectItem>
                    )
                  })}
                  <SelectItem value="custom">{t("customConfiguration")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Name */}
          <div className="grid gap-2">
            <Label htmlFor="name">{t("agentName")}</Label>
            <Input
              id="name"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder={t("agentNamePlaceholder")}
            />
          </div>

          {/* Protocol */}
          <div className="grid gap-2">
            <Label>{t("protocol")}</Label>
            <Select
              value={formData.protocol}
              onValueChange={(v) =>
                setFormData({ ...formData, protocol: v as AgentFormData["protocol"] })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="acp">ACP (Agent Client Protocol)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Transport */}
          <div className="grid gap-2">
            <Label>{t("transport")}</Label>
            <Select
              value={formData.transport}
              onValueChange={(v) =>
                setFormData({ ...formData, transport: v as AgentFormData["transport"] })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stdio">
                  <div className="flex items-center gap-2">
                    <Terminal className="h-4 w-4" />
                    <span>{t("transport.stdio.label")}</span>
                  </div>
                </SelectItem>
                <SelectItem value="http">
                  <div className="flex items-center gap-2">
                    <Globe className="h-4 w-4" />
                    <span>{t("transport.http.label")}</span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Process Config (for stdio) */}
          {formData.transport === "stdio" && (
            <>
              <Separator />
              <div className="grid gap-2">
                <Label htmlFor="command">{t("command")}</Label>
                <Input
                  id="command"
                  value={formData.processCommand}
                  onChange={(e) => setFormData({ ...formData, processCommand: e.target.value })}
                  placeholder="npx @anthropics/claude-code"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="args">{t("arguments")}</Label>
                <Input
                  id="args"
                  value={formData.processArgs}
                  onChange={(e) => setFormData({ ...formData, processArgs: e.target.value })}
                  placeholder="--stdio --model claude-sonnet"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="cwd">{t("workingDirectory")}</Label>
                <Input
                  id="cwd"
                  value={formData.processCwd}
                  onChange={(e) => setFormData({ ...formData, processCwd: e.target.value })}
                  placeholder={t("cwdPlaceholder")}
                />
              </div>
            </>
          )}

          {/* Network Config (for http/websocket) */}
          {formData.transport !== "stdio" && (
            <>
              <Separator />
              <div className="grid gap-2">
                <Label htmlFor="endpoint">{t("endpoint")}</Label>
                <Input
                  id="endpoint"
                  value={formData.networkEndpoint}
                  onChange={(e) => setFormData({ ...formData, networkEndpoint: e.target.value })}
                  placeholder="https://api.example.com/agent"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="apiKey">{t("apiKey")}</Label>
                <Input
                  id="apiKey"
                  type="password"
                  value={formData.networkApiKey}
                  onChange={(e) => setFormData({ ...formData, networkApiKey: e.target.value })}
                  placeholder={t("apiKeyPlaceholder")}
                />
              </div>
            </>
          )}

          {/* Permission Mode */}
          <Separator />
          <div className="grid gap-2">
            <Label>{t("defaultPermissionMode")}</Label>
            <Select
              value={formData.defaultPermissionMode}
              onValueChange={(v) =>
                setFormData({ ...formData, defaultPermissionMode: v as AcpPermissionMode })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">{t("permissionDefault")}</SelectItem>
                <SelectItem value="acceptEdits">{t("permissionAcceptEdits")}</SelectItem>
                <SelectItem value="bypassPermissions">{t("permissionBypass")}</SelectItem>
                <SelectItem value="plan">{t("permissionPlan")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Separator />
          <div className="grid gap-2">
            <Label htmlFor="timeoutMs">{t("executionTimeoutMs")}</Label>
            <Input
              id="timeoutMs"
              type="number"
              min={1000}
              step={1000}
              value={formData.timeoutMs}
              onChange={(e) => setFormData({ ...formData, timeoutMs: e.target.value })}
              placeholder={DEFAULT_TIMEOUT_MS}
            />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="retryMaxRetries">{t("maxRetries")}</Label>
              <Input
                id="retryMaxRetries"
                type="number"
                min={0}
                step={1}
                value={formData.retryMaxRetries}
                onChange={(e) => setFormData({ ...formData, retryMaxRetries: e.target.value })}
                placeholder={DEFAULT_RETRY_MAX_RETRIES}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="retryDelayMs">{t("retryDelayMs")}</Label>
              <Input
                id="retryDelayMs"
                type="number"
                min={0}
                step={100}
                value={formData.retryDelayMs}
                onChange={(e) => setFormData({ ...formData, retryDelayMs: e.target.value })}
                placeholder={DEFAULT_RETRY_DELAY_MS}
              />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="retryMaxDelayMs">{t("maxRetryDelayMs")}</Label>
              <Input
                id="retryMaxDelayMs"
                type="number"
                min={0}
                step={100}
                value={formData.retryMaxDelayMs}
                onChange={(e) => setFormData({ ...formData, retryMaxDelayMs: e.target.value })}
                placeholder={DEFAULT_RETRY_MAX_DELAY_MS}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="retryExponentialBackoff">{t("backoffStrategy")}</Label>
              <Select
                value={formData.retryExponentialBackoff ? "true" : "false"}
                onValueChange={(value) =>
                  setFormData({ ...formData, retryExponentialBackoff: value === "true" })
                }
              >
                <SelectTrigger id="retryExponentialBackoff">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">{t("backoffExponential")}</SelectItem>
                  <SelectItem value="false">{t("backoffFixedDelay")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="retryOnErrors">{t("retryErrorPatterns")}</Label>
            <textarea
              id="retryOnErrors"
              className="min-h-20 rounded-md border border-input bg-transparent px-3 py-2 text-sm"
              value={formData.retryOnErrors}
              onChange={(e) => setFormData({ ...formData, retryOnErrors: e.target.value })}
              placeholder={t("retryErrorPatternsPlaceholder")}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={handleSave}>{editingAgentId ? tCommon("save") : tCommon("add")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// =============================================================================
// Preset Gallery Card
// =============================================================================

interface PresetGalleryCardProps {
  disabled: boolean
  onPick: (presetId: string) => void
}

function PresetGalleryCard({ disabled, onPick }: PresetGalleryCardProps) {
  const t = useTranslations("externalAgent.settings")
  const [showExperimental, setShowExperimental] = useState(false)

  const presets = getAvailablePresets()
    .map((id) => ({ id, config: getPresetConfig(id) }))
    .filter(
      (entry): entry is { id: string; config: NonNullable<ReturnType<typeof getPresetConfig>> } =>
        entry.config !== null
    )
    .filter(({ config }) => showExperimental || config.supportTier !== "documented-only")

  return (
    <Card data-testid="preset-gallery-card">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>{t("quickStartTitle")}</CardTitle>
            <CardDescription>{t("quickStartDescription")}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="show-experimental-presets" className="text-xs">
              {t("showExperimental")}
            </Label>
            <Switch
              id="show-experimental-presets"
              checked={showExperimental}
              onCheckedChange={setShowExperimental}
              disabled={disabled}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {presets.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("presetGalleryEmpty")}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {presets.map(({ id, config }) => (
              <Card key={id} data-testid={`preset-card-${id}`} className="space-y-2 p-3">
                <div className="flex flex-wrap items-start justify-between gap-1">
                  <p className="text-sm font-medium">{config.name}</p>
                  {config.supportTier && (
                    <Badge
                      variant={
                        config.supportTier === "documented-only"
                          ? "destructive"
                          : config.supportTier === "guided"
                            ? "secondary"
                            : "outline"
                      }
                      className="text-[10px]"
                    >
                      {config.supportTier}
                    </Badge>
                  )}
                </div>
                <p className="line-clamp-3 text-xs text-muted-foreground">{config.description}</p>
                {config.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {config.tags.slice(0, 3).map((tag) => (
                      <Badge key={tag} variant="outline" className="text-[10px]">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                )}
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onPick(id)}
                    disabled={disabled}
                    data-testid={`preset-pick-${id}`}
                  >
                    {t("useThisPreset")}
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// =============================================================================
// Main Settings Component
// =============================================================================

export function ExternalAgentSettings() {
  const t = useTranslations("externalAgent.settings")
  const tCommon = useTranslations("common")

  // Store
  const {
    getAllAgents,
    getAgent,
    getConnectionStatus,
    getAgentValidity,
    addAgent,
    updateAgent,
    removeAgent,
    enabled,
    setEnabled,
    defaultPermissionMode,
    setDefaultPermissionMode,
    autoConnectOnStartup,
    setAutoConnectOnStartup,
    showConnectionNotifications,
    setShowConnectionNotifications,
    chatFailurePolicy,
    setChatFailurePolicy,
  } = useExternalAgentStore()

  // Hook for connection management
  const { connect, disconnect } = useExternalAgent()

  // Check if a specific agent is connecting
  const isConnecting = useCallback(
    (agentId: string) => {
      const status = getConnectionStatus(agentId)
      return status === "connecting" || status === "reconnecting"
    },
    [getConnectionStatus]
  )

  // Local state
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set())
  // Preset id seeded into the AgentEditorDialog when opening from the
  // quick-start gallery. Empty when the user opens the manual "Add agent"
  // button.
  const [selectedPresetForNew, setSelectedPresetForNew] = useState<string>("")

  // Get agents
  const agents = getAllAgents()

  // Handlers
  const handleAddAgent = useCallback(
    (data: CreateExternalAgentInput) => {
      addAgent(data)
      toast.success(t("agentAdded"))
    },
    [addAgent, t]
  )

  const handleEditAgent = useCallback((agentId: string) => {
    setEditingAgentId(agentId)
    setEditorOpen(true)
  }, [])

  const handleUpdateAgent = useCallback(
    (data: CreateExternalAgentInput) => {
      if (editingAgentId) {
        updateAgent(editingAgentId, data)
        toast.success(t("agentUpdated"))
      }
      setEditingAgentId(null)
    },
    [editingAgentId, updateAgent, t]
  )

  const handleDeleteAgent = useCallback(() => {
    if (deleteConfirmId) {
      removeAgent(deleteConfirmId)
      toast.success(t("agentRemoved"))
      setDeleteConfirmId(null)
    }
  }, [deleteConfirmId, removeAgent, t])

  const handleConnect = useCallback(
    async (agentId: string) => {
      try {
        const agent = getAgent(agentId)
        if (!agent) {
          throw new Error("Agent not found")
        }
        const runtimeValidity = getAgentValidity(agentId)
        const blockedReason =
          (runtimeValidity?.executable === false ? runtimeValidity.blockingReason : null) ??
          getExternalAgentExecutionBlockReason(agent)
        if (blockedReason) {
          throw new Error(blockedReason)
        }
        await connect(agentId)
        toast.success(t("connected"))
      } catch (error) {
        toast.error(t("connectionFailed"), {
          description: (error as Error).message,
        })
      }
    },
    [connect, t, getAgent, getAgentValidity]
  )

  const handleDisconnect = useCallback(
    async (agentId: string) => {
      try {
        await disconnect(agentId)
        toast.success(t("disconnected"))
      } catch (_error) {
        toast.error(t("disconnectFailed"))
      }
    },
    [disconnect, t]
  )

  const toggleExpanded = useCallback((agentId: string) => {
    setExpandedAgents((prev) => {
      const next = new Set(prev)
      if (next.has(agentId)) {
        next.delete(agentId)
      } else {
        next.add(agentId)
      }
      return next
    })
  }, [])

  return (
    <div className="space-y-6">
      {/* Global Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ExternalLink className="h-5 w-5" />
            {t("title")}
          </CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Enable External Agents */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>{t("enableExternalAgents")}</Label>
              <p className="text-sm text-muted-foreground">{t("enableExternalAgentsDesc")}</p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>

          <Separator />

          {/* Auto Connect */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>{t("autoConnect")}</Label>
              <p className="text-sm text-muted-foreground">{t("autoConnectDesc")}</p>
            </div>
            <Switch
              checked={autoConnectOnStartup}
              onCheckedChange={setAutoConnectOnStartup}
              disabled={!enabled}
            />
          </div>

          {/* Notifications */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>{t("showNotifications")}</Label>
              <p className="text-sm text-muted-foreground">{t("showNotificationsDesc")}</p>
            </div>
            <Switch
              checked={showConnectionNotifications}
              onCheckedChange={setShowConnectionNotifications}
              disabled={!enabled}
            />
          </div>

          <Separator />

          {/* Default Permission Mode */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>{t("defaultPermissionMode")}</Label>
              <p className="text-sm text-muted-foreground">{t("defaultPermissionModeDesc")}</p>
            </div>
            <Select
              value={defaultPermissionMode}
              onValueChange={(v) =>
                setDefaultPermissionMode(
                  v as "default" | "acceptEdits" | "bypassPermissions" | "plan"
                )
              }
              disabled={!enabled}
            >
              <SelectTrigger className="w-full sm:w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">{t("permissionDefault")}</SelectItem>
                <SelectItem value="acceptEdits">{t("permissionAcceptEdits")}</SelectItem>
                <SelectItem value="bypassPermissions">{t("permissionBypass")}</SelectItem>
                <SelectItem value="plan">{t("permissionPlan")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Separator />

          {/* External Failure Policy */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>{t("chatFailurePolicy")}</Label>
              <p className="text-sm text-muted-foreground">{t("chatFailurePolicyDesc")}</p>
            </div>
            <Select
              value={chatFailurePolicy}
              onValueChange={(value) => setChatFailurePolicy(value as "fallback" | "strict")}
              disabled={!enabled}
            >
              <SelectTrigger className="w-full sm:w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fallback">{t("chatFailurePolicyFallback")}</SelectItem>
                <SelectItem value="strict">{t("chatFailurePolicyStrict")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Quick-start preset gallery — surfaces the four shipping presets +
          any plugin-contributed presets. Picking a card opens the editor with
          the form pre-filled, so the user only edits the truly variable bits
          (env, cwd, custom args). */}
      <PresetGalleryCard
        disabled={!enabled}
        onPick={(presetId) => {
          setSelectedPresetForNew(presetId)
          setEditingAgentId(null)
          setEditorOpen(true)
        }}
      />

      {/* Agent List */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{t("configuredAgents")}</CardTitle>
              <CardDescription>{t("configuredAgentsDesc")}</CardDescription>
            </div>
            <Button
              onClick={() => {
                setSelectedPresetForNew("")
                setEditingAgentId(null)
                setEditorOpen(true)
              }}
              disabled={!enabled}
            >
              <Plus className="h-4 w-4 mr-2" />
              {t("addAgent")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {agents.length === 0 ? (
            <Empty className="py-8 border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ExternalLink className="h-6 w-6" />
                </EmptyMedia>
                <EmptyTitle>{t("noAgentsConfigured")}</EmptyTitle>
                <EmptyDescription>{t("addAgentToStart")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ScrollArea className="max-h-[min(400px,60vh)]">
              <div className="space-y-3">
                {agents.map((agent) => {
                  const status = getConnectionStatus(agent.id)
                  const isExpanded = expandedAgents.has(agent.id)
                  const isConnected = status === "connected"
                  const runtimeValidity = getAgentValidity(agent.id)
                  const executionBlockedReason =
                    (runtimeValidity?.executable === false
                      ? runtimeValidity.blockingReason
                      : null) ?? getExternalAgentExecutionBlockReason(agent)
                  const ecosystem =
                    runtimeValidity?.ecosystem ??
                    agent.validitySnapshot?.ecosystem ??
                    getExternalAgentEcosystemReadiness(agent)
                  const supportTier = ecosystem?.supportTier
                  const supportTierVariant =
                    supportTier === "documented-only"
                      ? "destructive"
                      : supportTier === "guided"
                        ? "secondary"
                        : "outline"

                  const fromPresetId = isFromPreset(agent)
                  const fromPresetName = fromPresetId
                    ? getPresetDisplayInfo(fromPresetId)?.name
                    : null

                  return (
                    <Collapsible
                      key={agent.id}
                      open={isExpanded}
                      onOpenChange={() => toggleExpanded(agent.id)}
                    >
                      <div className="border rounded-lg p-4" data-testid={`agent-row-${agent.id}`}>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <ConnectionStatusIcon status={status} />
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium">{agent.name}</span>
                                <Badge variant="outline" className="text-xs">
                                  {agent.protocol.toUpperCase()}
                                </Badge>
                                <Badge variant="secondary" className="text-xs">
                                  {agent.transport}
                                </Badge>
                                {supportTier && (
                                  <Badge variant={supportTierVariant} className="text-xs">
                                    {supportTier}
                                  </Badge>
                                )}
                                {fromPresetName && (
                                  <Badge
                                    variant="outline"
                                    className="text-xs"
                                    data-testid={`agent-from-preset-${agent.id}`}
                                  >
                                    {t("fromPreset", { name: fromPresetName })}
                                  </Badge>
                                )}
                              </div>
                              {agent.description && (
                                <p className="text-sm text-muted-foreground">{agent.description}</p>
                              )}
                              {ecosystem?.surfaceName && (
                                <p className="text-xs text-muted-foreground">
                                  {ecosystem.surfaceName}
                                </p>
                              )}
                              {executionBlockedReason && (
                                <p className="text-xs text-amber-600 dark:text-amber-400">
                                  {executionBlockedReason}
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {isConnected ? (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleDisconnect(agent.id)}
                              >
                                <PowerOff className="h-4 w-4 mr-1" />
                                {t("disconnect")}
                              </Button>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleConnect(agent.id)}
                                disabled={isConnecting(agent.id) || !!executionBlockedReason}
                              >
                                {isConnecting(agent.id) ? (
                                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                                ) : (
                                  <Power className="h-4 w-4 mr-1" />
                                )}
                                {t("connect")}
                              </Button>
                            )}
                            <CollapsibleTrigger asChild>
                              <Button variant="ghost" size="icon">
                                {isExpanded ? (
                                  <ChevronDown className="h-4 w-4" />
                                ) : (
                                  <ChevronRight className="h-4 w-4" />
                                )}
                              </Button>
                            </CollapsibleTrigger>
                          </div>
                        </div>

                        <CollapsibleContent className="mt-4 pt-4 border-t space-y-4">
                          {/* Agent Details */}
                          <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
                            <div>
                              <span className="text-muted-foreground">{t("transport")}:</span>
                              <span className="ml-2">{agent.transport}</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">{t("detailTimeout")}:</span>
                              <span className="ml-2">{agent.timeout ?? 300000}ms</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">{t("detailRetry")}:</span>
                              <span className="ml-2">
                                {agent.retryConfig?.maxRetries ?? 3} @{" "}
                                {agent.retryConfig?.retryDelay ?? 1000}ms
                              </span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">{t("detailBackoff")}:</span>
                              <span className="ml-2">
                                {(agent.retryConfig?.exponentialBackoff ?? true)
                                  ? t("backoffExponential")
                                  : t("backoffFixed")}
                              </span>
                            </div>
                            {agent.process && (
                              <>
                                <div>
                                  <span className="text-muted-foreground">{t("command")}:</span>
                                  <code className="ml-2 text-xs bg-muted px-1 rounded">
                                    {agent.process.command}
                                  </code>
                                </div>
                                {agent.process.cwd && (
                                  <div className="col-span-2">
                                    <span className="text-muted-foreground">
                                      {t("workingDirectory")}:
                                    </span>
                                    <code className="ml-2 text-xs bg-muted px-1 rounded">
                                      {agent.process.cwd}
                                    </code>
                                  </div>
                                )}
                              </>
                            )}
                            {agent.network && (
                              <div className="col-span-2">
                                <span className="text-muted-foreground">{t("endpoint")}:</span>
                                <code className="ml-2 text-xs bg-muted px-1 rounded">
                                  {agent.network.endpoint}
                                </code>
                              </div>
                            )}
                            {ecosystem?.adapterName && (
                              <div>
                                <span className="text-muted-foreground">
                                  {t("details.adapter")}:
                                </span>
                                <span className="ml-2">{ecosystem.adapterName}</span>
                              </div>
                            )}
                            {ecosystem?.surfaceName && (
                              <div>
                                <span className="text-muted-foreground">
                                  {t("details.surface")}:
                                </span>
                                <span className="ml-2">{ecosystem.surfaceName}</span>
                              </div>
                            )}
                            {supportTier && (
                              <div>
                                <span className="text-muted-foreground">
                                  {t("details.supportTier")}:
                                </span>
                                <span className="ml-2">{supportTier}</span>
                              </div>
                            )}
                            {ecosystem?.prerequisiteStatus && (
                              <div>
                                <span className="text-muted-foreground">
                                  {t("details.prerequisiteStatus")}:
                                </span>
                                <span className="ml-2">{ecosystem.prerequisiteStatus}</span>
                              </div>
                            )}
                            {ecosystem?.docsUrl && (
                              <div className="col-span-2">
                                <span className="text-muted-foreground">
                                  {t("details.officialDocs")}:
                                </span>
                                <a
                                  href={ecosystem.docsUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="ml-2 inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                                >
                                  <ExternalLink className="h-3.5 w-3.5" />
                                  {t("details.docsLink")}
                                </a>
                              </div>
                            )}
                            {ecosystem?.limitationNote && (
                              <div className="col-span-2">
                                <span className="text-muted-foreground">
                                  {t("details.limitation")}:
                                </span>
                                <span className="ml-2">{ecosystem.limitationNote}</span>
                              </div>
                            )}
                            {ecosystem?.recommendedActions?.length ? (
                              <div className="col-span-2">
                                <span className="text-muted-foreground">
                                  {t("details.recommendedActions")}:
                                </span>
                                <span className="ml-2">
                                  {ecosystem.recommendedActions.join(" | ")}
                                </span>
                              </div>
                            ) : null}
                          </div>

                          {/* Actions */}
                          <div className="flex gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleEditAgent(agent.id)}
                            >
                              <Edit className="h-4 w-4 mr-1" />
                              {tCommon("edit")}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-destructive hover:text-destructive"
                              onClick={() => setDeleteConfirmId(agent.id)}
                            >
                              <Trash2 className="h-4 w-4 mr-1" />
                              {tCommon("delete")}
                            </Button>
                          </div>
                        </CollapsibleContent>
                      </div>
                    </Collapsible>
                  )
                })}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* Agent Editor Dialog */}
      <AgentEditorDialog
        key={`agent-editor-${editingAgentId ?? "new"}-${selectedPresetForNew || "manual"}-${editorOpen ? "open" : "closed"}`}
        open={editorOpen}
        onOpenChange={(next) => {
          setEditorOpen(next)
          if (!next) setSelectedPresetForNew("")
        }}
        editingAgentId={editingAgentId}
        initialPreset={editingAgentId ? "" : selectedPresetForNew}
        onSave={editingAgentId ? handleUpdateAgent : handleAddAgent}
      />

      {/* Delete Confirmation */}
      <AlertDialog
        open={!!deleteConfirmId}
        onOpenChange={(open) => !open && setDeleteConfirmId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteAgent")}</AlertDialogTitle>
            <AlertDialogDescription>{t("deleteAgentConfirm")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteAgent}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {tCommon("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default ExternalAgentSettings
