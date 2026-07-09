"use client"

/**
 * ExternalAgentSettings - Settings component for managing external agents
 * Provides UI for configuring external agents, connection settings, and delegation rules
 */

import { useState, useCallback, useEffect } from "react"
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
} from "lucide-react"
import { cn } from "@/lib/utils"
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
import { Empty, EmptyMedia, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { useExternalAgent } from "@/hooks/agent/use-external-agent"
import { DelegationRulesSection } from "./delegation-rules-section"
import { CodexAppServerStatusCard } from "./codex-app-server-status-card"
import {
  getExternalAgentEcosystemReadiness,
  getExternalAgentExecutionBlockReason,
} from "@/lib/ai/agent/external/config-normalizer"
import {
  getAvailablePresets,
  getPresetConfig,
  getPresetDisplayInfo,
  isFromPreset,
  resolvePreferredCodexExecutablePresetId,
} from "@/lib/ai/agent/external/presets"
import {
  adaptPermissionMode,
  supportedPermissionModes,
} from "@/lib/ai/agent/external/permission-modes"
import type {
  ExternalAgentConnectionStatus,
  ExternalAgentConfig,
  CreateExternalAgentInput,
  AcpPermissionMode,
  ExternalAgentProtocol,
  ExternalAgentTransport,
} from "@/types/agent/external-agent"

/** i18n label key (under `externalAgent.settings`) for each permission mode. */
const PERMISSION_MODE_LABEL_KEY: Record<AcpPermissionMode, string> = {
  default: "permissionDefault",
  acceptEdits: "permissionAcceptEdits",
  bypassPermissions: "permissionBypass",
  plan: "permissionPlan",
  dontAsk: "permissionDontAsk",
}

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
  // Codex app-server options (shown only for protocol === "codex-app-server")
  codexSandboxMode: "readOnly" | "workspaceWrite" | "dangerFullAccess"
  codexNetworkAccess: boolean
  /** Empty string = model default */
  codexDefaultEffort: string
  /** Empty string = server default */
  codexReasoningSummary: "" | "auto" | "concise" | "detailed" | "none"
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
  codexSandboxMode: "workspaceWrite",
  codexNetworkAccess: false,
  codexDefaultEffort: "",
  codexReasoningSummary: "",
}

/** Static effort choices offered as per-agent defaults; the true per-model
 * list is session-level (from `model/list` supportedReasoningEfforts). */
const CODEX_EFFORT_CHOICES = ["minimal", "low", "medium", "high", "xhigh"] as const

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
      codexSandboxMode: agent.codexOptions?.sandboxMode ?? "workspaceWrite",
      codexNetworkAccess: agent.codexOptions?.networkAccess ?? false,
      codexDefaultEffort: agent.codexOptions?.defaultReasoningEffort ?? "",
      codexReasoningSummary: agent.codexOptions?.reasoningSummary ?? "",
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

    const selectedPresetConfig =
      selectedPreset && selectedPreset !== "custom" ? getPresetConfig(selectedPreset) : null

    if (formData.protocol === "opencode") {
      // OpenCode auto-spawns a local `opencode serve` when the preset requests
      // it; otherwise it connects to a configured server endpoint.
      if (selectedPresetConfig?.metadata?.autoSpawnServer === true) {
        input.process = {
          command: formData.processCommand.trim() || "opencode",
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
    } else if (formData.transport === "stdio") {
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

    if (formData.protocol === "codex-app-server") {
      input.codexOptions = {
        sandboxMode: formData.codexSandboxMode,
        ...(formData.codexSandboxMode !== "dangerFullAccess"
          ? { networkAccess: formData.codexNetworkAccess }
          : {}),
        ...(formData.codexDefaultEffort
          ? { defaultReasoningEffort: formData.codexDefaultEffort }
          : {}),
        ...(formData.codexReasoningSummary
          ? { reasoningSummary: formData.codexReasoningSummary }
          : {}),
      }
    }

    if (selectedPresetConfig) {
      input.metadata = {
        preset: selectedPreset,
        ecosystemAdapterId: selectedPresetConfig.adapterId,
        ecosystemSurfaceId: selectedPresetConfig.surfaceId,
        ecosystemSupportTier: selectedPresetConfig.supportTier,
        ecosystemDocsUrl: selectedPresetConfig.docsUrl,
        ...selectedPresetConfig.metadata,
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
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-[500px]">
        <DialogHeader className="shrink-0">
          <DialogTitle>{editingAgentId ? t("editAgent") : t("addAgent")}</DialogTitle>
          <DialogDescription>{t("agentConfigDescription")}</DialogDescription>
        </DialogHeader>

        <div className="-mx-1 grid min-h-0 flex-1 gap-4 overflow-y-auto px-1 py-4">
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
                {/* i18n-exempt: protocol identifier (brand/technical) */}
                <SelectItem value="acp">ACP (Agent Client Protocol)</SelectItem>
                {/* i18n-exempt: protocol identifier (brand/technical) */}
                <SelectItem value="opencode">OpenCode (HTTP + SSE)</SelectItem>
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
                    <span>{t("transportStdioLabel")}</span>
                  </div>
                </SelectItem>
                <SelectItem value="http">
                  <div className="flex items-center gap-2">
                    <Globe className="h-4 w-4" />
                    <span>{t("transportHttpLabel")}</span>
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
                  // i18n-exempt: example CLI command, not UI prose
                  placeholder="npx @anthropics/claude-code"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="args">{t("arguments")}</Label>
                <Input
                  id="args"
                  value={formData.processArgs}
                  onChange={(e) => setFormData({ ...formData, processArgs: e.target.value })}
                  // i18n-exempt: example CLI arguments, not UI prose
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

          {/* Permission Mode — narrowed to the modes the chosen backend can
              enforce, and clamped for display so switching protocol never shows
              a mode the backend would silently downgrade. */}
          <Separator />
          <div className="grid gap-2">
            <Label>{t("defaultPermissionMode")}</Label>
            <Select
              value={adaptPermissionMode(formData.defaultPermissionMode, formData.protocol).mode}
              onValueChange={(v) =>
                setFormData({ ...formData, defaultPermissionMode: v as AcpPermissionMode })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {supportedPermissionModes(formData.protocol).map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {t(PERMISSION_MODE_LABEL_KEY[mode])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Codex app-server options — sandbox + reasoning defaults applied at
              thread/start (sandbox) and turn/start (sandboxPolicy/effort/summary).
              Session-level overrides remain available via config options. */}
          {formData.protocol === "codex-app-server" && (
            <>
              <Separator />
              <div className="grid gap-2" data-testid="codex-options-section">
                <Label>{t("codexSandboxMode")}</Label>
                <p className="text-sm text-muted-foreground">{t("codexSandboxModeDesc")}</p>
                <Select
                  value={formData.codexSandboxMode}
                  onValueChange={(v) =>
                    setFormData({
                      ...formData,
                      codexSandboxMode: v as AgentFormData["codexSandboxMode"],
                    })
                  }
                >
                  <SelectTrigger data-testid="codex-sandbox-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="readOnly">{t("codexSandboxReadOnly")}</SelectItem>
                    <SelectItem value="workspaceWrite">
                      {t("codexSandboxWorkspaceWrite")}
                    </SelectItem>
                    <SelectItem value="dangerFullAccess">
                      {t("codexSandboxDangerFullAccess")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {formData.codexSandboxMode !== "dangerFullAccess" && (
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label htmlFor="codexNetworkAccess">{t("codexNetworkAccess")}</Label>
                    <p className="text-sm text-muted-foreground">{t("codexNetworkAccessDesc")}</p>
                  </div>
                  <Switch
                    id="codexNetworkAccess"
                    checked={formData.codexNetworkAccess}
                    onCheckedChange={(checked) =>
                      setFormData({ ...formData, codexNetworkAccess: checked })
                    }
                  />
                </div>
              )}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label>{t("codexDefaultEffort")}</Label>
                  <Select
                    value={formData.codexDefaultEffort || "model-default"}
                    onValueChange={(v) =>
                      setFormData({
                        ...formData,
                        codexDefaultEffort: v === "model-default" ? "" : v,
                      })
                    }
                  >
                    <SelectTrigger data-testid="codex-default-effort">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="model-default">{t("codexModelDefault")}</SelectItem>
                      {CODEX_EFFORT_CHOICES.map((effort) => (
                        <SelectItem key={effort} value={effort}>
                          {effort}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label>{t("codexReasoningSummary")}</Label>
                  <Select
                    value={formData.codexReasoningSummary || "server-default"}
                    onValueChange={(v) =>
                      setFormData({
                        ...formData,
                        codexReasoningSummary: (v === "server-default"
                          ? ""
                          : v) as AgentFormData["codexReasoningSummary"],
                      })
                    }
                  >
                    <SelectTrigger data-testid="codex-reasoning-summary">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="server-default">{t("codexServerDefault")}</SelectItem>
                      <SelectItem value="auto">{t("codexSummaryAuto")}</SelectItem>
                      <SelectItem value="concise">{t("codexSummaryConcise")}</SelectItem>
                      <SelectItem value="detailed">{t("codexSummaryDetailed")}</SelectItem>
                      <SelectItem value="none">{t("codexSummaryNone")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </>
          )}

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

        <DialogFooter className="shrink-0">
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

const CODEX_EXECUTABLE_PRESET_IDS = ["codex", "codex-app-server"] as const

function PresetGalleryCard({ disabled, onPick }: PresetGalleryCardProps) {
  const t = useTranslations("externalAgent.settings")
  const [showExperimental, setShowExperimental] = useState(false)
  // Auto-prefer the native app-server Codex preset when the `codex` CLI is on
  // PATH; otherwise the ACP shim. Surfaced as a "Recommended" hint — both stay
  // selectable. Defaults to the ACP preset until detection resolves.
  const [preferredCodexPreset, setPreferredCodexPreset] = useState<string>("codex")
  useEffect(() => {
    let active = true
    void resolvePreferredCodexExecutablePresetId().then((id) => {
      if (active) setPreferredCodexPreset(id)
    })
    return () => {
      active = false
    }
  }, [])

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
                  {(CODEX_EXECUTABLE_PRESET_IDS as readonly string[]).includes(id) &&
                    id === preferredCodexPreset && (
                      <Badge
                        variant="default"
                        className="text-[10px]"
                        data-testid={`preset-recommended-${id}`}
                      >
                        {t("recommendedPreset")}
                      </Badge>
                    )}
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
// Agent Detail Panel
// =============================================================================

interface AgentDetailProps {
  agent: ExternalAgentConfig
  isConnecting: boolean
  onConnect: () => void
  onDisconnect: () => void
  onEdit: () => void
  onDelete: () => void
}

/**
 * Right-hand detail pane for the selected agent. Renders the full connection
 * config, ecosystem metadata, the native Codex app-server status (when
 * applicable), and the connect/edit/delete actions. Replaces the old per-row
 * `Collapsible` drawer so the wide settings frame is actually used.
 */
function AgentDetail({
  agent,
  isConnecting,
  onConnect,
  onDisconnect,
  onEdit,
  onDelete,
}: AgentDetailProps) {
  const t = useTranslations("externalAgent.settings")
  const tCommon = useTranslations("common")
  const { getConnectionStatus, getAgentValidity } = useExternalAgentStore()

  const status = getConnectionStatus(agent.id)
  const isConnected = status === "connected"
  const runtimeValidity = getAgentValidity(agent.id)
  const executionBlockedReason =
    (runtimeValidity?.executable === false ? runtimeValidity.blockingReason : null) ??
    getExternalAgentExecutionBlockReason(agent)
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

  return (
    <Card data-testid={`agent-detail-${agent.id}`}>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <ConnectionStatusIcon status={status} />
              <CardTitle className="truncate">{agent.name}</CardTitle>
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
            </div>
            {agent.description && <CardDescription>{agent.description}</CardDescription>}
            {executionBlockedReason && (
              <p className="text-xs text-amber-600 dark:text-amber-400">{executionBlockedReason}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isConnected ? (
              <Button variant="outline" size="sm" onClick={onDisconnect}>
                <PowerOff className="mr-1 h-4 w-4" />
                {t("disconnect")}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={onConnect}
                disabled={isConnecting || !!executionBlockedReason}
              >
                {isConnecting ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Power className="mr-1 h-4 w-4" />
                )}
                {t("connect")}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Agent Details */}
        <div className="grid grid-cols-1 gap-4 text-sm @lg/agents-pane:grid-cols-2">
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
              {agent.retryConfig?.maxRetries ?? 3} @ {agent.retryConfig?.retryDelay ?? 1000}ms
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
                <code className="ml-2 rounded bg-muted px-1 text-xs">{agent.process.command}</code>
              </div>
              {agent.process.cwd && (
                <div className="@lg/agents-pane:col-span-2">
                  <span className="text-muted-foreground">{t("workingDirectory")}:</span>
                  <code className="ml-2 rounded bg-muted px-1 text-xs">{agent.process.cwd}</code>
                </div>
              )}
            </>
          )}
          {agent.network && (
            <div className="@lg/agents-pane:col-span-2">
              <span className="text-muted-foreground">{t("endpoint")}:</span>
              <code className="ml-2 rounded bg-muted px-1 text-xs">{agent.network.endpoint}</code>
            </div>
          )}
          {ecosystem?.adapterName && (
            <div>
              <span className="text-muted-foreground">{t("detailsAdapter")}:</span>
              <span className="ml-2">{ecosystem.adapterName}</span>
            </div>
          )}
          {ecosystem?.surfaceName && (
            <div>
              <span className="text-muted-foreground">{t("detailsSurface")}:</span>
              <span className="ml-2">{ecosystem.surfaceName}</span>
            </div>
          )}
          {supportTier && (
            <div>
              <span className="text-muted-foreground">{t("detailsSupportTier")}:</span>
              <span className="ml-2">{supportTier}</span>
            </div>
          )}
          {ecosystem?.prerequisiteStatus && (
            <div>
              <span className="text-muted-foreground">{t("detailsPrerequisiteStatus")}:</span>
              <span className="ml-2">{ecosystem.prerequisiteStatus}</span>
            </div>
          )}
          {ecosystem?.docsUrl && (
            <div className="@lg/agents-pane:col-span-2">
              <span className="text-muted-foreground">{t("detailsOfficialDocs")}:</span>
              <a
                href={ecosystem.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="ml-2 inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {t("detailsDocsLink")}
              </a>
            </div>
          )}
          {ecosystem?.limitationNote && (
            <div className="@lg/agents-pane:col-span-2">
              <span className="text-muted-foreground">{t("detailsLimitation")}:</span>
              <span className="ml-2">{ecosystem.limitationNote}</span>
            </div>
          )}
          {ecosystem?.recommendedActions?.length ? (
            <div className="@lg/agents-pane:col-span-2">
              <span className="text-muted-foreground">{t("detailsRecommendedActions")}:</span>
              <span className="ml-2">{ecosystem.recommendedActions.join(" | ")}</span>
            </div>
          ) : null}
        </div>

        {/* Native Codex app-server status (MCP servers + skills) */}
        {agent.protocol === "codex-app-server" && (
          <CodexAppServerStatusCard agentId={agent.id} connected={isConnected} />
        )}

        {/* Actions */}
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Edit className="mr-1 h-4 w-4" />
            {tCommon("edit")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 className="mr-1 h-4 w-4" />
            {tCommon("delete")}
          </Button>
        </div>
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
  // Master/detail selection: the agent whose config is shown in the right pane.
  // `null` keeps the quick-start preset gallery in view.
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
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

  // Keep the selection valid: if the selected agent is removed, fall back to
  // the gallery (null) so the detail pane never points at a missing agent.
  const selectedAgent = selectedAgentId
    ? agents.find((agent) => agent.id === selectedAgentId)
    : undefined

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      {/* Page header — title, the master enable switch, and the add action stay
          pinned above the scrolling body so they are always reachable. */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b pb-4">
        <div className="flex min-w-0 items-center gap-2">
          <ExternalLink className="h-5 w-5 shrink-0" />
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold">{t("title")}</h2>
            <p className="text-sm text-muted-foreground">{t("description")}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Label htmlFor="enable-external-agents" className="text-sm">
              {t("enableExternalAgents")}
            </Label>
            <Switch id="enable-external-agents" checked={enabled} onCheckedChange={setEnabled} />
          </div>
          <Button
            onClick={() => {
              setSelectedPresetForNew("")
              setEditingAgentId(null)
              setEditorOpen(true)
            }}
            disabled={!enabled}
          >
            <Plus className="mr-2 h-4 w-4" />
            {t("addAgent")}
          </Button>
        </div>
      </div>

      {/* Scrolling body — owns the vertical scroll and declares the container so
          the master/detail split responds to the panel's own width, not the
          viewport. */}
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto pt-4 pr-0.5 @container/agents-pane">
        {/* Global Settings */}
        <Card>
          <CardContent className="space-y-4 pt-6">
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

        {/* Rule-based delegation — route matching chat turns to an external
            agent automatically (Thread B). */}
        <DelegationRulesSection disabled={!enabled} />

        {/* Master/detail split — the agent list is the master on the left; the
            selected agent's full config (or the quick-start preset gallery when
            nothing is selected) fills the detail pane on the right. Collapses to
            a single stacked column below the @3xl container breakpoint. */}
        <div className="flex flex-col gap-4 @3xl/agents-pane:flex-row @3xl/agents-pane:items-start">
          {/* Master: agent list */}
          <aside className="space-y-2 @3xl/agents-pane:sticky @3xl/agents-pane:top-0 @3xl/agents-pane:max-h-[calc(100dvh-14rem)] @3xl/agents-pane:w-72 @3xl/agents-pane:shrink-0 @3xl/agents-pane:self-start @3xl/agents-pane:overflow-y-auto @3xl/agents-pane:pr-1">
            <div className="flex items-center justify-between gap-2 px-0.5">
              <h3 className="text-sm font-medium">{t("configuredAgents")}</h3>
              {agents.length > 0 && (
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                  {agents.length}
                </Badge>
              )}
            </div>
            {agents.length === 0 ? (
              <Empty className="border-0 py-8">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <ExternalLink className="h-6 w-6" />
                  </EmptyMedia>
                  <EmptyTitle>{t("noAgentsConfigured")}</EmptyTitle>
                  <EmptyDescription>{t("addAgentToStart")}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="space-y-2">
                {agents.map((agent) => {
                  const status = getConnectionStatus(agent.id)
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
                  const isSelected = selectedAgentId === agent.id

                  return (
                    <button
                      key={agent.id}
                      type="button"
                      data-testid={`agent-row-${agent.id}`}
                      onClick={() => setSelectedAgentId(agent.id)}
                      aria-pressed={isSelected}
                      className={cn(
                        "w-full rounded-lg border p-3 text-left transition-colors hover:bg-accent/50",
                        isSelected && "border-primary bg-accent ring-1 ring-primary"
                      )}
                    >
                      <div className="flex items-start gap-2">
                        <ConnectionStatusIcon status={status} />
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate text-sm font-medium">{agent.name}</span>
                            <Badge variant="outline" className="text-[10px]">
                              {agent.protocol.toUpperCase()}
                            </Badge>
                            <Badge variant="secondary" className="text-[10px]">
                              {agent.transport}
                            </Badge>
                            {supportTier && (
                              <Badge variant={supportTierVariant} className="text-[10px]">
                                {supportTier}
                              </Badge>
                            )}
                            {fromPresetName && (
                              <Badge
                                variant="outline"
                                className="text-[10px]"
                                data-testid={`agent-from-preset-${agent.id}`}
                              >
                                {t("fromPreset", { name: fromPresetName })}
                              </Badge>
                            )}
                          </div>
                          {executionBlockedReason && (
                            <p className="text-[11px] text-amber-600 dark:text-amber-400">
                              {executionBlockedReason}
                            </p>
                          )}
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </aside>

          {/* Detail: the selected agent's config, or the quick-start gallery */}
          <section className="min-w-0 flex-1">
            {selectedAgent ? (
              <AgentDetail
                agent={selectedAgent}
                isConnecting={isConnecting(selectedAgent.id)}
                onConnect={() => handleConnect(selectedAgent.id)}
                onDisconnect={() => handleDisconnect(selectedAgent.id)}
                onEdit={() => handleEditAgent(selectedAgent.id)}
                onDelete={() => setDeleteConfirmId(selectedAgent.id)}
              />
            ) : (
              <PresetGalleryCard
                disabled={!enabled}
                onPick={(presetId) => {
                  setSelectedPresetForNew(presetId)
                  setEditingAgentId(null)
                  setEditorOpen(true)
                }}
              />
            )}
          </section>
        </div>
      </div>

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
