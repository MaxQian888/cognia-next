"use client"

/**
 * External Agent Manager
 *
 * Chat-side dialog body that surfaces every Codex / OpenCode / Claude Code
 * (ACP) capability the runtime exposes:
 *
 *   - Agent CRUD with preset-driven onboarding (codex, claude-code,
 *     gemini-cli, cursor-cli, custom).
 *   - Connection lifecycle + per-agent runtime diagnostics
 *     (executable / health / auth / session-extension support /
 *     ecosystem readiness / canonical contract / last-run snapshot).
 *   - ACP session list, fork, resume — gated by extension support.
 *   - Available slash commands and execution plan rendering.
 *   - Dynamic ACP config options (model, agent, mode selectors).
 *   - ACP permission flow via the ACP-aware ToolApprovalDialog.
 *
 * Ported from `D:\Project\Cognia\components\agent\external-agent-manager.tsx`.
 * cognia-next has not migrated the agent-trace observability stack yet, so
 * the analytics hook + health badge are local stubs that no-op gracefully.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertCircle,
  ChevronDown,
  ExternalLink,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Settings,
  Trash2,
} from "lucide-react"

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
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { toast } from "@/components/ui/sonner"
import { cn, isTauri } from "@/lib/utils"

import { useExternalAgent } from "@/hooks/agent"
import { useAgentTraceAnalytics } from "@/hooks/agent-trace"
import { ExternalAgentCommands } from "./commands"
import { ExternalAgentPlan } from "./plan"
import { ExternalAgentConfigOptions } from "./config-options"
import { ToolApprovalDialog, type ToolApprovalRequest } from "./tool-approval-dialog"
import { TraceHealthBadge } from "./trace-health-badge"
import { ConnectionStatusBadge } from "./connection-status-badge"

import type {
  AcpPermissionOption,
  CreateExternalAgentInput,
  ExternalAgentConfig,
  ExternalAgentConnectionStatus,
  ExternalAgentValiditySnapshot,
} from "@/types/agent/external-agent"
import {
  getExternalAgentEcosystemReadiness,
  getExternalAgentExecutionBlockReason,
  isSupportedExternalAgentProtocol,
} from "@/lib/ai/agent/external/config-normalizer"
import { getExternalAgentEcosystemAdapter } from "@/lib/ai/agent/external/ecosystem-adapters"
import { isExternalAgentSessionExtensionUnsupportedForMethod } from "@/lib/ai/agent/external/session-extension-errors"
import {
  getAvailablePresets,
  getPresetConfig,
  type ExternalAgentPresetId,
} from "@/lib/ai/agent/external/presets"
import { protocolAdapterRegistry } from "@/lib/ai/agent/external/protocol-adapter"

import type { AddAgentFormData } from "@/types/agent/component-types"
import type { SessionObservationSummary } from "@/types/agent/agent-trace"

const DEFAULT_TIMEOUT_MS = "300000"
const DEFAULT_RETRY_MAX_RETRIES = "3"
const DEFAULT_RETRY_DELAY_MS = "1000"
const DEFAULT_RETRY_MAX_DELAY_MS = "30000"

/** Built-in protocol <SelectItem> values; anything else is plugin-contributed. */
const BUILTIN_PROTOCOL_OPTIONS = ["acp", "opencode", "a2a", "http", "websocket", "custom"]

const DEFAULT_ADD_AGENT_FORM_DATA: AddAgentFormData = {
  name: "",
  protocol: "acp",
  transport: "stdio",
  command: "",
  args: "",
  bare: false,
  debug: false,
  endpoint: "",
  autoSpawnServer: false,
  port: "",
  hostname: "",
  serverPassword: "",
  serverUsername: "",
  model: "",
  timeoutMs: DEFAULT_TIMEOUT_MS,
  retryMaxRetries: DEFAULT_RETRY_MAX_RETRIES,
  retryDelayMs: DEFAULT_RETRY_DELAY_MS,
  retryExponentialBackoff: true,
  retryMaxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS,
  retryOnErrors: "",
}

// ============================================================================
// Agent Card
// ============================================================================

interface AgentCardProps {
  agent: {
    config: ExternalAgentConfig
    connectionStatus: ExternalAgentConnectionStatus
    validity?: ExternalAgentValiditySnapshot
  }
  isActive: boolean
  onConnect: () => void
  onDisconnect: () => void
  onRemove: () => void
  onSelect: () => void
}

function AgentCard({
  agent,
  isActive,
  onConnect,
  onDisconnect,
  onRemove,
  onSelect,
}: AgentCardProps) {
  const tSettings = useTranslations("externalAgent.settings")
  const tManager = useTranslations("externalAgent.manager")
  const tCommon = useTranslations("common")
  const { config, connectionStatus, validity } = agent
  const isConnected = connectionStatus === "connected"
  const executionBlockReason =
    (validity?.executable === false ? validity.blockingReason : null) ??
    getExternalAgentExecutionBlockReason(config)
  const connectDisabled = !isConnected && !!executionBlockReason
  const ecosystem = validity?.ecosystem ?? getExternalAgentEcosystemReadiness(config)

  return (
    // One row per agent: name + status on the first line, endpoint on the
    // second. The previous header+content card was ~5 lines tall, so a handful
    // of agents pushed the sessions/diagnostics panels off-screen. The surface
    // name moved out — it is already spelled out in Runtime Diagnostics.
    <Card
      data-testid={`agent-card-${config.id}`}
      className={cn(
        "cursor-pointer gap-0 py-2 transition-all hover:shadow-md",
        isActive && "ring-2 ring-primary"
      )}
      onClick={onSelect}
    >
      <CardContent className="px-3">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium">{config.name}</span>
              {ecosystem?.supportTier && (
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  {ecosystem.supportTier}
                </Badge>
              )}
              <ConnectionStatusBadge
                status={connectionStatus}
                withIcon
                className="ml-auto shrink-0"
              />
            </div>
            <p className="truncate text-[11px] text-muted-foreground">
              {tManager("protocolViaTransport", {
                protocol: config.protocol.toUpperCase(),
                transport: config.transport,
              })}
              {" · "}
              {config.process?.command || config.network?.endpoint || tManager("noEndpoint")}
            </p>
          </div>
          <div className="flex shrink-0 gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (connectDisabled) return
                    if (isConnected) {
                      onDisconnect()
                    } else {
                      onConnect()
                    }
                  }}
                  disabled={connectDisabled}
                >
                  {isConnected ? (
                    <PowerOff className="h-4 w-4 text-destructive" />
                  ) : (
                    <Power className="h-4 w-4 text-green-600" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {isConnected ? tSettings("disconnect") : tSettings("connect")}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemove()
                  }}
                >
                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{tCommon("remove")}</TooltipContent>
            </Tooltip>
          </div>
        </div>
        {executionBlockReason && (
          <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
            {executionBlockReason}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

// ============================================================================
// Collapsible Section
// ============================================================================

interface CollapsibleSectionProps {
  title: string
  /** Optional count badge shown next to the title (hidden when 0/undefined). */
  count?: number
  /** Start expanded. Verbose/advanced sections stay collapsed by default. */
  defaultOpen?: boolean
  /** Forwarded to the always-mounted root so tests can target the section. */
  dataTestId?: string
  children: React.ReactNode
}

/**
 * Bordered, collapsible detail block used by the manager's diagnostics and
 * benchmark panels. Keeps the default view compact while leaving verbose
 * runtime data one click away. The whole header row is the toggle; sections
 * that need an inline action in the header (e.g. Sessions) build their own
 * Collapsible instead.
 */
function CollapsibleSection({
  title,
  count,
  defaultOpen = false,
  dataTestId,
  children,
}: CollapsibleSectionProps) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="rounded-md border" data-testid={dataTestId}>
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{title}</span>
          {typeof count === "number" && count > 0 && (
            <Badge variant="secondary" className="h-4 shrink-0 px-1.5 text-[10px]">
              {count}
            </Badge>
          )}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-3">{children}</CollapsibleContent>
    </Collapsible>
  )
}

// ============================================================================
// Add Agent Dialog
// ============================================================================

interface AddAgentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdd: (data: AddAgentFormData) => Promise<void> | void
}

function AddAgentDialog({ open, onOpenChange, onAdd }: AddAgentDialogProps) {
  const tSettings = useTranslations("externalAgent.settings")
  const tManager = useTranslations("externalAgent.manager")
  const tCommon = useTranslations("common")
  const tauriRuntime = isTauri()
  const [selectedPreset, setSelectedPreset] = useState<ExternalAgentPresetId | "">("")
  const [formData, setFormData] = useState<AddAgentFormData>(DEFAULT_ADD_AGENT_FORM_DATA)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const isOpenCode = formData.protocol === "opencode"
  const isStdio = !isOpenCode && formData.transport === "stdio"

  const handlePresetChange = (presetId: string) => {
    setSelectedPreset(presetId as ExternalAgentPresetId | "")
    if (presetId && presetId !== "custom") {
      // getPresetConfig is dynamic-aware (plugin-contributed presets too),
      // matching how the dropdown is built from getAvailablePresets().
      const preset = getPresetConfig(presetId)
      if (preset) {
        const presetPort = preset.metadata?.port
        setFormData((current) => ({
          ...current,
          name: preset.name,
          protocol: preset.protocol,
          transport: preset.transport,
          command: preset.process?.command || "",
          args: preset.process?.args.join(" ") || "",
          endpoint: preset.network?.endpoint || "",
          autoSpawnServer: preset.metadata?.autoSpawnServer === true,
          port: typeof presetPort === "number" ? String(presetPort) : "",
          hostname: typeof preset.metadata?.hostname === "string" ? preset.metadata.hostname : "",
          model: typeof preset.metadata?.model === "string" ? preset.metadata.model : "",
        }))
      }
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    // Accept any built-in protocol (acp / codex-app-server / opencode / a2a) OR
    // any plugin-contributed adapter currently registered in the runtime registry
    // (mirrors the registry-aware gate in getExternalAgentExecutionBlock). Using
    // the canonical built-in list keeps every shipping protocol — including A2A —
    // selectable without depending on registry bootstrap order. A disabled-plugin
    // protocol is no longer in the registry, so it stays correctly blocked.
    if (
      !isSupportedExternalAgentProtocol(formData.protocol) &&
      !protocolAdapterRegistry.has(formData.protocol)
    ) {
      toast.error(tManager("unsupportedProtocol"))
      return
    }
    if (!formData.name.trim()) {
      toast.error(tSettings("nameRequired"))
      return
    }
    if (isOpenCode) {
      // Remote mode (no auto-spawn) needs an endpoint; auto-spawn defaults the
      // command to `opencode`, so nothing else is strictly required.
      if (!formData.autoSpawnServer && !formData.endpoint.trim()) {
        toast.error(tSettings("endpointRequired"))
        return
      }
    } else if (isStdio && !formData.command.trim()) {
      toast.error(tSettings("commandRequired"))
      return
    } else if (!isStdio && !formData.endpoint.trim()) {
      toast.error(tSettings("endpointRequired"))
      return
    }

    setIsSubmitting(true)
    try {
      await onAdd({
        ...formData,
        name: formData.name.trim(),
        command: formData.command.trim(),
        endpoint: formData.endpoint.trim(),
      })
      setFormData(DEFAULT_ADD_AGENT_FORM_DATA)
      setSelectedPreset("")
      onOpenChange(false)
    } catch (error) {
      const message =
        error instanceof Error && error.message ? error.message : tManager("addAgentFailed")
      toast.error(message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const currentPreset = selectedPreset ? getPresetConfig(selectedPreset) : null
  const currentAdapter = currentPreset?.adapterId
    ? getExternalAgentEcosystemAdapter(currentPreset.adapterId)
    : null
  const relatedOfficialSurfaces =
    currentAdapter?.surfaces.filter((surface) => surface.id !== currentPreset?.surfaceId) ?? []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-125">
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{tManager("addExternalAgent")}</DialogTitle>
            <DialogDescription>{tManager("configureNewExternalAgentConnection")}</DialogDescription>
          </DialogHeader>
          <div className="-mx-6 grid min-h-0 flex-1 gap-4 overflow-y-auto px-6 py-4">
            {/* Preset Selector */}
            <div className="grid gap-2">
              <Label>{tManager("quickStartPreset")}</Label>
              <Select value={selectedPreset} onValueChange={handlePresetChange}>
                <SelectTrigger>
                  <SelectValue placeholder={tManager("selectPresetOrConfigureManually")} />
                </SelectTrigger>
                <SelectContent>
                  {getAvailablePresets().map((presetId) => {
                    // Route through `getPresetConfig` so plugin-contributed
                    // presets (registered via the §A-3 dynamic overlay)
                    // resolve identically to the four builtin entries.
                    const preset = getPresetConfig(presetId)
                    if (!preset) return null
                    return (
                      <SelectItem key={presetId} value={presetId}>
                        <div className="flex items-center gap-2">
                          <span>{preset.name}</span>
                          <span className="text-xs text-muted-foreground">
                            ({preset.tags.join(", ")})
                          </span>
                        </div>
                      </SelectItem>
                    )
                  })}
                  <SelectItem value="custom">{tManager("customConfiguration")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {currentPreset && (
              <div className="rounded-md border p-3 text-xs space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  {currentPreset.supportTier && (
                    <Badge variant="outline" className="text-[10px]">
                      {currentPreset.supportTier}
                    </Badge>
                  )}
                  {currentPreset.docsUrl && (
                    <a
                      href={currentPreset.docsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" />
                      {tManager("officialDocs")}
                    </a>
                  )}
                </div>
                {currentPreset.setupHint && <p>{currentPreset.setupHint}</p>}
                {relatedOfficialSurfaces.length > 0 && (
                  <div className="space-y-1">
                    <p className="font-medium">{tManager("otherOfficialSurfaces")}</p>
                    {relatedOfficialSurfaces.map((surface) => (
                      <div key={surface.id} className="rounded-sm border bg-muted/40 px-2 py-1.5">
                        <div className="flex items-center gap-2">
                          <span>{surface.name}</span>
                          <Badge variant="secondary" className="text-[10px]">
                            {surface.supportTier}
                          </Badge>
                        </div>
                        <p className="mt-1 text-muted-foreground">
                          {surface.limitationNote ?? surface.setupHint ?? surface.description}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {currentPreset?.envVarHint && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                <span className="font-medium">{tManager("noteLabel")}:</span>{" "}
                {currentPreset.envVarHint}
              </div>
            )}

            <Separator />

            <div className="grid gap-2">
              <Label htmlFor="name">{tManager("name")}</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                // i18n-exempt: example agent name (brand), not UI prose
                placeholder="Claude Code"
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="protocol">{tSettings("protocol")}</Label>
                <Select
                  value={formData.protocol}
                  onValueChange={(value: AddAgentFormData["protocol"]) => {
                    // Radix can emit "" when the controlled value matches no
                    // built-in item (e.g. a plugin-contributed protocol like
                    // `${pluginId}:${id}`); ignore it so the preset's protocol
                    // isn't silently wiped.
                    if (!value) return
                    setFormData({
                      ...formData,
                      protocol: value,
                      // OpenCode runs over HTTP + SSE; A2A is a remote HTTP
                      // (JSON-RPC + optional SSE) protocol — both need a network
                      // endpoint rather than a stdio command.
                      transport:
                        value === "opencode"
                          ? "sse"
                          : value === "a2a"
                            ? "http"
                            : formData.transport,
                    })
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* A plugin-contributed protocol (`${pluginId}:${id}`) is not
                        one of the built-in items; render it so the controlled
                        Select preserves the value instead of clearing it. */}
                    {formData.protocol && !BUILTIN_PROTOCOL_OPTIONS.includes(formData.protocol) && (
                      <SelectItem value={formData.protocol}>{formData.protocol}</SelectItem>
                    )}
                    {/* i18n-exempt: protocol identifier (brand/technical) */}
                    <SelectItem value="acp">ACP</SelectItem>
                    {/* i18n-exempt: protocol identifier (brand/technical) */}
                    <SelectItem value="opencode">OpenCode</SelectItem>
                    <SelectItem value="a2a">{tManager("a2aProtocol")}</SelectItem>
                    <SelectItem value="http" disabled>
                      {tManager("httpProtocolComingSoon")}
                    </SelectItem>
                    <SelectItem value="websocket" disabled>
                      {tManager("websocketProtocolComingSoon")}
                    </SelectItem>
                    <SelectItem value="custom" disabled>
                      {tManager("customProtocolComingSoon")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="transport">{tSettings("transport")}</Label>
                <Select
                  value={formData.transport}
                  onValueChange={(value: AddAgentFormData["transport"]) =>
                    setFormData({ ...formData, transport: value })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stdio">{tManager("transportStdioLocal")}</SelectItem>
                    <SelectItem value="http">{tManager("transportHttp")}</SelectItem>
                    <SelectItem value="websocket">{tManager("transportWebsocket")}</SelectItem>
                    <SelectItem value="sse">{tManager("transportSse")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {isOpenCode ? (
              <>
                <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/20 p-3">
                  <div className="space-y-0.5">
                    <Label htmlFor="auto-spawn" className="cursor-pointer text-sm">
                      {tManager("autoSpawnServer")}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {tManager("autoSpawnServerHint")}
                    </p>
                  </div>
                  <Switch
                    id="auto-spawn"
                    checked={formData.autoSpawnServer}
                    onCheckedChange={(v) => setFormData({ ...formData, autoSpawnServer: v })}
                    aria-label={tManager("autoSpawnServer")}
                  />
                </div>
                {formData.autoSpawnServer ? (
                  <>
                    {!tauriRuntime && (
                      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                        {tManager("opencodeDesktopRuntimeWarning")}
                      </div>
                    )}
                    <div className="grid gap-2">
                      <Label htmlFor="command">{tSettings("command")}</Label>
                      <Input
                        id="command"
                        value={formData.command}
                        onChange={(e) => setFormData({ ...formData, command: e.target.value })}
                        // i18n-exempt: example CLI command, not UI prose
                        placeholder="opencode"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="grid gap-2">
                        <Label htmlFor="port">{tManager("serverPort")}</Label>
                        <Input
                          id="port"
                          type="number"
                          min={0}
                          value={formData.port}
                          onChange={(e) => setFormData({ ...formData, port: e.target.value })}
                          placeholder="0"
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="hostname">{tManager("serverHostname")}</Label>
                        <Input
                          id="hostname"
                          value={formData.hostname}
                          onChange={(e) => setFormData({ ...formData, hostname: e.target.value })}
                          // i18n-exempt: example hostname, not UI prose
                          placeholder="127.0.0.1"
                        />
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="grid gap-2">
                    <Label htmlFor="endpoint">{tSettings("endpoint")}</Label>
                    <Input
                      id="endpoint"
                      value={formData.endpoint}
                      onChange={(e) => setFormData({ ...formData, endpoint: e.target.value })}
                      placeholder="http://127.0.0.1:4096"
                      required={!formData.autoSpawnServer}
                    />
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <div className="grid gap-2">
                    <Label htmlFor="server-password">{tManager("serverPassword")}</Label>
                    <Input
                      id="server-password"
                      type="password"
                      value={formData.serverPassword}
                      onChange={(e) => setFormData({ ...formData, serverPassword: e.target.value })}
                      placeholder="••••••••"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="server-username">{tManager("serverUsername")}</Label>
                    <Input
                      id="server-username"
                      value={formData.serverUsername}
                      onChange={(e) => setFormData({ ...formData, serverUsername: e.target.value })}
                      // i18n-exempt: the server's documented default Basic-Auth user
                      placeholder="opencode"
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">{tManager("serverPasswordHint")}</p>
                <div className="grid gap-2">
                  <Label htmlFor="opencode-model">{tManager("defaultModel")}</Label>
                  <Input
                    id="opencode-model"
                    value={formData.model}
                    onChange={(e) => setFormData({ ...formData, model: e.target.value })}
                    // i18n-exempt: example provider/model id, not UI prose
                    placeholder="anthropic/claude-sonnet-4-5"
                  />
                  <p className="text-xs text-muted-foreground">{tManager("defaultModelHint")}</p>
                </div>
              </>
            ) : isStdio ? (
              <>
                {!tauriRuntime && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                    {tManager("stdioDesktopRuntimeWarning")}
                  </div>
                )}
                <div className="grid gap-2">
                  <Label htmlFor="command">{tSettings("command")}</Label>
                  <Input
                    id="command"
                    value={formData.command}
                    onChange={(e) => setFormData({ ...formData, command: e.target.value })}
                    // i18n-exempt: example CLI command, not UI prose
                    placeholder="npx"
                    required={isStdio}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="args">{tSettings("arguments")}</Label>
                  <Input
                    id="args"
                    value={formData.args}
                    onChange={(e) => setFormData({ ...formData, args: e.target.value })}
                    // i18n-exempt: example CLI arguments, not UI prose
                    placeholder="@anthropics/claude-code --stdio"
                  />
                </div>
                <div className="space-y-2 rounded-md border bg-muted/20 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-0.5">
                      <Label htmlFor="bare-flag" className="cursor-pointer text-sm">
                        {tSettings("passBareFlag")}
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {tSettings("passBareFlagHint")}
                      </p>
                    </div>
                    <Switch
                      id="bare-flag"
                      checked={formData.bare}
                      onCheckedChange={(v) => setFormData({ ...formData, bare: v })}
                      aria-label={tSettings("passBareFlag")}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-0.5">
                      <Label htmlFor="debug-flag" className="cursor-pointer text-sm">
                        {tSettings("passDebugFlag")}
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {tSettings("passDebugFlagHint")}
                      </p>
                    </div>
                    <Switch
                      id="debug-flag"
                      checked={formData.debug}
                      onCheckedChange={(v) => setFormData({ ...formData, debug: v })}
                      aria-label={tSettings("passDebugFlag")}
                    />
                  </div>
                </div>
              </>
            ) : (
              <div className="grid gap-2">
                <Label htmlFor="endpoint">{tSettings("endpoint")}</Label>
                <Input
                  id="endpoint"
                  value={formData.endpoint}
                  onChange={(e) => setFormData({ ...formData, endpoint: e.target.value })}
                  placeholder="http://localhost:8080"
                  required={!isStdio}
                />
              </div>
            )}
            <Collapsible className="rounded-md border">
              <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium">
                <span>{tManager("advancedOptions")}</span>
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
              </CollapsibleTrigger>
              <CollapsibleContent className="grid gap-4 px-3 pb-3">
                <div className="grid gap-2">
                  <Label htmlFor="timeoutMs">{tSettings("executionTimeoutMs")}</Label>
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
                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="retryMaxRetries">{tSettings("maxRetries")}</Label>
                    <Input
                      id="retryMaxRetries"
                      type="number"
                      min={0}
                      step={1}
                      value={formData.retryMaxRetries}
                      onChange={(e) =>
                        setFormData({ ...formData, retryMaxRetries: e.target.value })
                      }
                      placeholder={DEFAULT_RETRY_MAX_RETRIES}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="retryDelayMs">{tSettings("retryDelayMs")}</Label>
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
                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="retryMaxDelayMs">{tSettings("maxRetryDelayMs")}</Label>
                    <Input
                      id="retryMaxDelayMs"
                      type="number"
                      min={0}
                      step={100}
                      value={formData.retryMaxDelayMs}
                      onChange={(e) =>
                        setFormData({ ...formData, retryMaxDelayMs: e.target.value })
                      }
                      placeholder={DEFAULT_RETRY_MAX_DELAY_MS}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="retryExponentialBackoff">{tSettings("backoffStrategy")}</Label>
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
                        <SelectItem value="true">{tSettings("backoffExponential")}</SelectItem>
                        <SelectItem value="false">{tSettings("backoffFixedDelay")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="retryOnErrors">{tSettings("retryErrorPatterns")}</Label>
                  <Textarea
                    id="retryOnErrors"
                    className="min-h-20 text-sm"
                    value={formData.retryOnErrors}
                    onChange={(e) => setFormData({ ...formData, retryOnErrors: e.target.value })}
                    placeholder={tSettings("retryErrorPatternsPlaceholder")}
                  />
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? tManager("addingAgent") : tSettings("addAgent")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ============================================================================
// Main Component
// ============================================================================

export interface ExternalAgentManagerProps {
  className?: string
}

export function ExternalAgentManager({ className }: ExternalAgentManagerProps) {
  const t = useTranslations("externalAgent")
  const tSettings = useTranslations("externalAgent.settings")
  const tManager = useTranslations("externalAgent.manager")
  const tDiag = useTranslations("externalAgent.manager.diagnostics")
  const tCommon = useTranslations("common")
  const refreshSessionsFailedMessage = tManager("refreshSessionsFailed")
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  /** Agent queued for removal; drives the confirmation AlertDialog. */
  const [removeConfirmId, setRemoveConfirmId] = useState<string | null>(null)
  const [sessionList, setSessionList] = useState<
    Array<{
      sessionId: string
      cwd?: string
      additionalDirectories?: string[]
      title?: string
      createdAt?: string
      updatedAt?: string
    }>
  >([])
  const [isLoadingSessions, setIsLoadingSessions] = useState(false)

  const {
    agents,
    activeAgentId,
    activeSession,
    activeAgentValidity,
    activeLastRunSnapshot,
    activeBenchmarkCapabilities,
    isExecuting,
    isLoading,
    error,
    pendingPermission,
    availableCommands,
    planEntries,
    planStep,
    planDocument,
    configOptions,
    addAgent,
    removeAgent,
    connect,
    disconnect,
    execute,
    setActiveAgent,
    respondToPermission,
    setConfigOption,
    listSessions,
    forkSession,
    resumeSession,
    refresh,
    clearError,
  } = useExternalAgent()

  const handleAddAgent = useCallback(
    async (data: AddAgentFormData) => {
      const toNonNegativeInteger = (value: string, fallback: number): number => {
        const parsed = Number.parseInt(value, 10)
        if (Number.isNaN(parsed) || parsed < 0) return fallback
        return parsed
      }

      const retryOnErrors = data.retryOnErrors
        .split(/\r?\n|,/)
        .map((pattern) => pattern.trim())
        .filter(Boolean)

      const config: CreateExternalAgentInput = {
        name: data.name,
        protocol: data.protocol,
        transport: data.transport,
        timeout: toNonNegativeInteger(data.timeoutMs, Number.parseInt(DEFAULT_TIMEOUT_MS, 10)),
        retryConfig: {
          maxRetries: toNonNegativeInteger(
            data.retryMaxRetries,
            Number.parseInt(DEFAULT_RETRY_MAX_RETRIES, 10)
          ),
          retryDelay: toNonNegativeInteger(
            data.retryDelayMs,
            Number.parseInt(DEFAULT_RETRY_DELAY_MS, 10)
          ),
          exponentialBackoff: data.retryExponentialBackoff,
          maxRetryDelay: toNonNegativeInteger(
            data.retryMaxDelayMs,
            Number.parseInt(DEFAULT_RETRY_MAX_DELAY_MS, 10)
          ),
          retryOnErrors,
        },
      }

      if (data.protocol === "opencode") {
        const metadata: Record<string, unknown> = {}
        if (data.autoSpawnServer) {
          metadata.autoSpawnServer = true
          config.process = {
            command: data.command.trim() || "opencode",
            args: data.args.split(" ").filter(Boolean),
          }
          const port = Number.parseInt(data.port, 10)
          if (!Number.isNaN(port) && port > 0) {
            metadata.port = port
          }
        } else if (data.endpoint.trim()) {
          config.network = { endpoint: data.endpoint.trim() }
        }
        if (data.hostname.trim()) {
          metadata.hostname = data.hostname.trim()
        }
        if (data.serverPassword) {
          metadata.serverPassword = data.serverPassword
        }
        if (data.serverUsername.trim()) {
          metadata.serverUsername = data.serverUsername.trim()
        }
        if (data.model.trim()) {
          metadata.model = data.model.trim()
        }
        if (Object.keys(metadata).length > 0) {
          config.metadata = metadata
        }
      } else if (data.transport === "stdio") {
        config.process = {
          command: data.command,
          args: data.args.split(" ").filter(Boolean),
          bare: data.bare || undefined,
          debug: data.debug || undefined,
        }
      } else {
        config.network = {
          endpoint: data.endpoint,
        }
      }

      await addAgent(config)
    },
    [addAgent]
  )

  const getErrorMessage = useCallback((err: unknown, fallback: string) => {
    if (err instanceof Error && err.message) return err.message
    return fallback
  }, [])

  const handleConnect = useCallback(
    async (agentId: string) => {
      try {
        await connect(agentId)
        toast.success(tSettings("connected"))
      } catch (err) {
        toast.error(getErrorMessage(err, tSettings("connectionFailed")))
      }
    },
    [connect, tSettings, getErrorMessage]
  )

  const handleDisconnect = useCallback(
    async (agentId: string) => {
      try {
        await disconnect(agentId)
        toast.success(tSettings("disconnected"))
      } catch (err) {
        toast.error(getErrorMessage(err, tSettings("disconnectFailed")))
      }
    },
    [disconnect, tSettings, getErrorMessage]
  )

  // Removal is confirmed through the app's own AlertDialog rather than the
  // native `window.confirm` sheet, which broke out of the dialog's styling and
  // could not be dismissed with the app's own keyboard handling.
  const handleRemove = useCallback(async () => {
    const agentId = removeConfirmId
    if (!agentId) return
    setRemoveConfirmId(null)
    try {
      await removeAgent(agentId)
      toast.success(tSettings("agentRemoved"))
    } catch (err) {
      toast.error(getErrorMessage(err, tManager("removeAgentFailed")))
    }
  }, [removeConfirmId, removeAgent, tManager, tSettings, getErrorMessage])

  const handleCommandExecute = useCallback(
    async (command: string, args?: string) => {
      const prompt = args ? `${command} ${args}` : command
      await execute(prompt)
    },
    [execute]
  )

  const activeAgent = activeAgentId
    ? agents.find((agent) => agent.config.id === activeAgentId) || null
    : null
  const activeAgentBlockedReason =
    activeAgentValidity?.blockingReason ??
    (activeAgent ? getExternalAgentExecutionBlockReason(activeAgent.config) : null)
  const isActiveAgentExecutable =
    activeAgentValidity?.executable ?? (activeAgentBlockedReason ? false : true)
  const isActiveAgentConnected = activeAgent?.connectionStatus === "connected"
  const listSupport = activeAgentValidity?.sessionExtensions["session/list"]
  const forkSupport = activeAgentValidity?.sessionExtensions["session/fork"]
  const resumeSupport = activeAgentValidity?.sessionExtensions["session/resume"]
  const canUseSessionActions =
    !!activeAgentId &&
    isActiveAgentConnected &&
    isActiveAgentExecutable &&
    listSupport?.state !== "unsupported"
  const contractVersion = activeAgentValidity?.contractVersion ?? 1
  const lifecycleStage = activeAgentValidity?.lifecycleStage || "config"
  const blockedStage = activeAgentValidity?.blockedStage
  const canonicalReasonCode =
    activeAgentValidity?.canonicalReasonCode || activeAgentValidity?.lastBranchReasonCode || "ok"
  const canonicalReason =
    activeAgentValidity?.canonicalReason ||
    activeAgentValidity?.lastBranchReason ||
    activeAgentBlockedReason ||
    tDiag("noBlockingReason")
  const branchOutcome = activeAgentValidity?.branchOutcome || "external"
  const recoveryHints = activeAgentValidity?.recoveryHints || []
  const activeEcosystem =
    activeAgentValidity?.ecosystem ??
    (activeAgent ? getExternalAgentEcosystemReadiness(activeAgent.config) : undefined)
  const correlationSessionId = activeAgentValidity?.correlation?.sessionId
  const correlationTurnId = activeAgentValidity?.correlation?.turnId
  const benchmarkEntries = activeBenchmarkCapabilities || []
  const commandsDisabled =
    isExecuting || !isActiveAgentConnected || !isActiveAgentExecutable || !activeSession

  const { sessionSummary: lastRunSessionSummary } = useAgentTraceAnalytics({
    sessionId: activeLastRunSnapshot?.linkedSessionId,
    autoLoad: Boolean(activeLastRunSnapshot?.linkedSessionId),
  })

  const lastRunHealthSummary: SessionObservationSummary | null =
    activeLastRunSnapshot?.linkedSessionId && lastRunSessionSummary
      ? {
          sessionId: activeLastRunSnapshot.linkedSessionId,
          outcome:
            activeLastRunSnapshot.terminalOutcome === "error" ||
            (lastRunSessionSummary.eventTypeCounts.error ?? 0) > 0
              ? "error"
              : "success",
          totalTokenCost: lastRunSessionSummary.totalCost,
          toolCallCount: lastRunSessionSummary.toolCallCount,
          errorCount:
            (lastRunSessionSummary.eventTypeCounts.error ?? 0) ||
            lastRunSessionSummary.toolFailureCount,
          latencyP50Ms: lastRunSessionSummary.avgLatencyMs,
          startedAt: lastRunSessionSummary.firstTimestamp,
          endedAt: lastRunSessionSummary.lastTimestamp,
        }
      : null

  const refreshSessions = useCallback(async () => {
    const clearSessionListIfNeeded = () => {
      setSessionList((prev) => (prev.length === 0 ? prev : []))
    }

    if (
      !activeAgentId ||
      !isActiveAgentConnected ||
      !isActiveAgentExecutable ||
      listSupport?.state === "unsupported"
    ) {
      clearSessionListIfNeeded()
      return
    }
    setIsLoadingSessions(true)
    try {
      const configuredCwd = agents.find((agent) => agent.config.id === activeAgentId)?.config
        .process?.cwd
      const sessions = await listSessions(
        activeAgentId,
        configuredCwd ? { cwd: configuredCwd } : undefined
      )
      setSessionList(sessions)
    } catch (err) {
      const unsupported = isExternalAgentSessionExtensionUnsupportedForMethod(err, "session/list")
      clearSessionListIfNeeded()
      if (!unsupported) {
        toast.error(getErrorMessage(err, refreshSessionsFailedMessage))
      }
    } finally {
      setIsLoadingSessions(false)
    }
  }, [
    activeAgentId,
    agents,
    isActiveAgentConnected,
    isActiveAgentExecutable,
    listSupport?.state,
    listSessions,
    getErrorMessage,
    refreshSessionsFailedMessage,
  ])

  const handleResumeSession = useCallback(
    async (sessionId: string) => {
      try {
        const source = sessionList.find((session) => session.sessionId === sessionId)
        const options = source?.cwd
          ? { cwd: source.cwd, additionalDirectories: source.additionalDirectories }
          : undefined
        await resumeSession(sessionId, options)
        await refreshSessions()
      } catch (err) {
        const unsupported = isExternalAgentSessionExtensionUnsupportedForMethod(
          err,
          "session/resume"
        )
        if (unsupported) {
          setSessionList((prev) => (prev.length === 0 ? prev : []))
          return
        }
        toast.error(getErrorMessage(err, tManager("resumeSessionFailed")))
      }
    },
    [resumeSession, refreshSessions, sessionList, tManager, getErrorMessage]
  )

  const handleForkSession = useCallback(
    async (sessionId: string) => {
      try {
        const source = sessionList.find((session) => session.sessionId === sessionId)
        const options = source?.cwd
          ? { cwd: source.cwd, additionalDirectories: source.additionalDirectories }
          : undefined
        await forkSession(sessionId, options)
        await refreshSessions()
      } catch (err) {
        const unsupported = isExternalAgentSessionExtensionUnsupportedForMethod(err, "session/fork")
        if (unsupported) {
          setSessionList((prev) => (prev.length === 0 ? prev : []))
          return
        }
        toast.error(getErrorMessage(err, tManager("forkSessionFailed")))
      }
    },
    [forkSession, refreshSessions, sessionList, tManager, getErrorMessage]
  )

  const mapAcpOptions = useCallback((options?: AcpPermissionOption[]) => {
    return options?.map((option) => ({
      optionId: option.optionId,
      name: option.name,
      description: option.description,
      kind: option.kind,
      isDefault: option.isDefault,
    }))
  }, [])

  const buildPermissionResponseRequestId = useCallback(() => {
    if (!pendingPermission) return ""
    return pendingPermission.requestId || pendingPermission.id
  }, [pendingPermission])

  const pickAllowOptionId = useCallback((options?: AcpPermissionOption[]): string | undefined => {
    if (!options?.length) return undefined
    const defaultAllow = options.find(
      (opt) => opt.isDefault && opt.kind.toLowerCase().includes("allow")
    )
    if (defaultAllow) return defaultAllow.optionId
    const allowOnce = options.find((opt) => opt.kind.toLowerCase().includes("allow_once"))
    if (allowOnce) return allowOnce.optionId
    return options.find((opt) => opt.kind.toLowerCase().includes("allow"))?.optionId
  }, [])

  const handlePermissionApprove = useCallback(async () => {
    if (!pendingPermission) return
    const requestId = buildPermissionResponseRequestId()
    await respondToPermission({
      requestId,
      granted: true,
      optionId: pickAllowOptionId(pendingPermission.options),
    })
  }, [pendingPermission, respondToPermission, buildPermissionResponseRequestId, pickAllowOptionId])

  const handlePermissionDeny = useCallback(async () => {
    if (!pendingPermission) return
    const requestId = buildPermissionResponseRequestId()
    await respondToPermission({
      requestId,
      granted: false,
    })
  }, [pendingPermission, respondToPermission, buildPermissionResponseRequestId])

  const handlePermissionSelectOption = useCallback(
    async (_id: string, optionId: string) => {
      if (!pendingPermission) return
      const requestId = buildPermissionResponseRequestId()
      await respondToPermission({
        requestId,
        granted: true,
        optionId,
      })
    },
    [pendingPermission, respondToPermission, buildPermissionResponseRequestId]
  )

  const handlePermissionSubmitAnswers = useCallback(
    async (_id: string, answers: Record<string, string[]>) => {
      if (!pendingPermission) return
      const requestId = buildPermissionResponseRequestId()
      await respondToPermission({
        requestId,
        granted: true,
        answers,
      })
    },
    [pendingPermission, respondToPermission, buildPermissionResponseRequestId]
  )

  // Interactive question payload attached by the Codex app-server adapter
  // (item/tool/requestUserInput) — switches the approval dialog to question mode.
  const pendingUserInput = useMemo(() => {
    const raw = pendingPermission?.metadata?.codexUserInput as
      { questions?: unknown; autoResolutionMs?: unknown } | undefined
    if (!raw || !Array.isArray(raw.questions) || raw.questions.length === 0) return undefined
    const userInput: NonNullable<ToolApprovalRequest["userInput"]> = {
      questions: raw.questions as NonNullable<ToolApprovalRequest["userInput"]>["questions"],
    }
    if (typeof raw.autoResolutionMs === "number") {
      userInput.autoResolutionMs = raw.autoResolutionMs
    }
    return userInput
  }, [pendingPermission])

  useEffect(() => {
    if (!activeAgentId || !canUseSessionActions) {
      // Noop when already empty; otherwise clear stale entries when the
      // active agent becomes ineligible for session listing.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSessionList((prev) => (prev.length === 0 ? prev : []))
      return
    }
    void refreshSessions()
  }, [activeAgentId, canUseSessionActions, refreshSessions])

  return (
    <div className={cn("flex min-h-0 flex-col gap-4", className)}>
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">{t("externalAgents")}</h3>
          <p className="text-sm text-muted-foreground">{tSettings("configuredAgentsDesc")}</p>
        </div>
        <div className="flex gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="icon" onClick={refresh} disabled={isLoading}>
                <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{tManager("refresh")}</TooltipContent>
          </Tooltip>
          <Button onClick={() => setAddDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            {tSettings("addAgent")}
          </Button>
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <div className="flex items-center justify-between rounded-lg border border-destructive bg-destructive/10 p-3">
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
          <Button variant="ghost" size="sm" onClick={clearError}>
            {tCommon("dismiss")}
          </Button>
        </div>
      )}

      <Separator className="shrink-0" />

      {/* Scrollable body — a single internal scroll region so the header stays
          fixed and expanding every collapsible never pushes content off-screen. */}
      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1">
        {/* Agent List */}
        {agents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Settings className="mb-4 h-12 w-12 text-muted-foreground/50" />
            <h4 className="text-lg font-medium">{tManager("noExternalAgents")}</h4>
            <p className="mt-1 text-sm text-muted-foreground">{tSettings("addAgentToStart")}</p>
            <Button className="mt-4" onClick={() => setAddDialogOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              {tSettings("addAgent")}
            </Button>
          </div>
        ) : (
          // Cap the roster's height so a long agent list can never push the
          // sessions / diagnostics / commands panels below the fold.
          <div className="-mx-1 max-h-56 shrink-0 overflow-y-auto px-1">
            <div className="grid gap-2 sm:grid-cols-2">
              {agents.map((agent) => (
                <AgentCard
                  key={agent.config.id}
                  agent={agent}
                  isActive={activeAgentId === agent.config.id}
                  onConnect={() => handleConnect(agent.config.id)}
                  onDisconnect={() => handleDisconnect(agent.config.id)}
                  onRemove={() => setRemoveConfirmId(agent.config.id)}
                  onSelect={() => setActiveAgent(agent.config.id)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Session Management */}
        {activeAgentId && (
          <Collapsible defaultOpen className="rounded-md border">
            <div className="flex items-center justify-between gap-2 px-3 py-2">
              <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium">
                <span className="truncate">{tManager("sessions")}</span>
                {sessionList.length > 0 && (
                  <Badge variant="secondary" className="h-4 shrink-0 px-1.5 text-[10px]">
                    {sessionList.length}
                  </Badge>
                )}
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
              </CollapsibleTrigger>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={refreshSessions}
                disabled={isLoadingSessions || !canUseSessionActions}
              >
                {isLoadingSessions ? tCommon("loading") : tManager("refreshSessions")}
              </Button>
            </div>
            <CollapsibleContent className="px-3 pb-3">
              {!isActiveAgentExecutable ? (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  {activeAgentBlockedReason || tDiag("notExecutable")}
                </p>
              ) : !isActiveAgentConnected ? (
                <p className="text-xs text-muted-foreground">{tDiag("connectAgentToList")}</p>
              ) : listSupport?.state === "unsupported" ? (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  {listSupport.reason || tDiag("sessionListingUnsupported")}
                </p>
              ) : sessionList.length === 0 ? (
                <p className="text-xs text-muted-foreground">{tManager("noResumableSessions")}</p>
              ) : (
                <div className="space-y-2">
                  {sessionList.map((session) => (
                    <div
                      key={session.sessionId}
                      className="flex items-center justify-between rounded border px-2 py-1.5"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium">
                          {session.title || session.sessionId}
                        </p>
                        <p className="truncate text-[11px] text-muted-foreground">
                          {session.sessionId}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleResumeSession(session.sessionId)}
                          disabled={
                            isExecuting ||
                            activeSession?.id === session.sessionId ||
                            !isActiveAgentExecutable ||
                            !isActiveAgentConnected ||
                            resumeSupport?.state === "unsupported"
                          }
                        >
                          {tManager("resume")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleForkSession(session.sessionId)}
                          disabled={
                            isExecuting ||
                            !isActiveAgentExecutable ||
                            !isActiveAgentConnected ||
                            forkSupport?.state === "unsupported"
                          }
                        >
                          {tManager("fork")}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {(resumeSupport?.state === "unsupported" || forkSupport?.state === "unsupported") && (
                <div className="mt-2 space-y-1 text-[11px] text-amber-700 dark:text-amber-400">
                  {resumeSupport?.state === "unsupported" && (
                    <p>
                      {tDiag("resumeUnsupported", {
                        reason: resumeSupport.reason || tDiag("resumeUnsupportedDefault"),
                      })}
                    </p>
                  )}
                  {forkSupport?.state === "unsupported" && (
                    <p>
                      {tDiag("forkUnsupported", {
                        reason: forkSupport.reason || tDiag("forkUnsupportedDefault"),
                      })}
                    </p>
                  )}
                </div>
              )}
            </CollapsibleContent>
          </Collapsible>
        )}

        {/* Runtime Diagnostics */}
        {activeAgent && (
          <CollapsibleSection
            title={tDiag("runtimeDiagnostics")}
            defaultOpen
            dataTestId="external-agent-diagnostics"
          >
            <div className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs text-muted-foreground [&>p]:min-w-0 [&>p]:break-words sm:grid-cols-2">
              <p>
                {tDiag("protocolTransport", {
                  protocol: activeAgent.config.protocol.toUpperCase(),
                  transport: activeAgent.config.transport,
                })}
              </p>
              <p>
                {activeAgentValidity?.blockingReasonCode
                  ? tDiag("executableWithCode", {
                      value: isActiveAgentExecutable ? tDiag("yes") : tDiag("no"),
                      code: activeAgentValidity.blockingReasonCode,
                    })
                  : tDiag("executable", {
                      value: isActiveAgentExecutable ? tDiag("yes") : tDiag("no"),
                    })}
              </p>
              <p>
                {tDiag("health", {
                  value: activeAgentValidity?.healthStatus || tDiag("unknown"),
                })}
              </p>
              <p>
                {tDiag("authRequired", {
                  value: activeAgentValidity?.negotiation?.authRequired
                    ? tDiag("yes")
                    : tDiag("no"),
                })}
              </p>
              <p className="sm:col-span-2">
                {tDiag("authMethods", {
                  methods: activeAgentValidity?.negotiation?.authMethods?.length
                    ? activeAgentValidity.negotiation.authMethods
                        .map((method) => method.id)
                        .join(", ")
                    : tDiag("none"),
                })}
              </p>
              <p>
                {tDiag("sessionSupport", {
                  list: listSupport?.state || tDiag("unknown"),
                  fork: forkSupport?.state || tDiag("unknown"),
                  resume: resumeSupport?.state || tDiag("unknown"),
                })}
              </p>
              {activeEcosystem?.adapterName && (
                <p>{tDiag("adapter", { name: activeEcosystem.adapterName })}</p>
              )}
              {activeEcosystem?.surfaceName && (
                <p>{tDiag("surface", { name: activeEcosystem.surfaceName })}</p>
              )}
              {activeEcosystem?.supportTier && (
                <p>{tDiag("supportTier", { tier: activeEcosystem.supportTier })}</p>
              )}
              {activeEcosystem?.prerequisiteStatus && (
                <p>{tDiag("prerequisiteStatus", { status: activeEcosystem.prerequisiteStatus })}</p>
              )}
              <p>{tDiag("contractVersion", { version: contractVersion })}</p>
              <p>{tDiag("lifecycleStage", { stage: lifecycleStage })}</p>
              {blockedStage && <p>{tDiag("blockedStage", { stage: blockedStage })}</p>}
              <p>{tDiag("branchOutcome", { outcome: branchOutcome })}</p>
              <p className="sm:col-span-2">
                {canonicalReason
                  ? tDiag("canonicalReasonWithText", {
                      code: canonicalReasonCode,
                      reason: canonicalReason,
                    })
                  : tDiag("canonicalReason", { code: canonicalReasonCode })}
              </p>
              {(correlationSessionId || correlationTurnId) && (
                <p className="sm:col-span-2">
                  {tDiag("correlation", {
                    session: correlationSessionId || tDiag("naLabel"),
                    turn: correlationTurnId || tDiag("naLabel"),
                  })}
                </p>
              )}
              {activeLastRunSnapshot && (
                <div className="rounded border p-2 text-foreground sm:col-span-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span>
                      {tDiag("latestRun", { outcome: activeLastRunSnapshot.terminalOutcome })}
                    </span>
                    <Badge variant="outline" className="text-[10px]">
                      {activeLastRunSnapshot.branchReasonCode}
                    </Badge>
                    {lastRunHealthSummary && <TraceHealthBadge summary={lastRunHealthSummary} />}
                  </div>
                  <p className="mt-1 text-muted-foreground">
                    {activeLastRunSnapshot.timestamp.toLocaleString()}
                  </p>
                  {activeLastRunSnapshot.linkedTraceId && (
                    <p className="text-muted-foreground">
                      {tDiag("trace", { trace: activeLastRunSnapshot.linkedTraceId })}
                    </p>
                  )}
                  {activeLastRunSnapshot.diagnosticText && (
                    <p className="text-muted-foreground">{activeLastRunSnapshot.diagnosticText}</p>
                  )}
                  {activeLastRunSnapshot.linkedSessionId && (
                    <p className="text-muted-foreground">
                      {tDiag("session", { session: activeLastRunSnapshot.linkedSessionId })}
                    </p>
                  )}
                </div>
              )}
              {activeAgentBlockedReason && (
                <p className="text-amber-700 sm:col-span-2 dark:text-amber-400">
                  {tDiag("blockingReason", { reason: activeAgentBlockedReason })}
                </p>
              )}
              {recoveryHints.length > 0 && (
                <p className="sm:col-span-2">
                  {tDiag("recoveryHints", { hints: recoveryHints.join(" | ") })}
                </p>
              )}
              {activeEcosystem?.recommendedActions?.length ? (
                <p className="sm:col-span-2">
                  {tDiag("recommendedActions", {
                    actions: activeEcosystem.recommendedActions.join(" | "),
                  })}
                </p>
              ) : null}
            </div>
          </CollapsibleSection>
        )}

        {/* Benchmark Adaptation */}
        {activeAgent && (
          <CollapsibleSection
            title={tDiag("benchmarkAdaptation")}
            count={benchmarkEntries.length}
            dataTestId="external-agent-benchmark-adaptation"
          >
            <div className="text-xs">
              {benchmarkEntries.length === 0 ? (
                <p className="text-muted-foreground">{tDiag("noBenchmarkAdaptation")}</p>
              ) : (
                <div className="space-y-2">
                  {benchmarkEntries.map((entry) => (
                    <div key={entry.id} className="rounded border p-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-medium">{entry.title}</p>
                        <Badge variant="outline" className="text-[11px]">
                          {entry.status}
                        </Badge>
                      </div>
                      <p className="text-muted-foreground">
                        {tDiag("gap", { grade: entry.gapGrade })}
                      </p>
                      <p className="text-muted-foreground">
                        {tDiag("target", { target: entry.adaptationTarget })}
                      </p>
                      {entry.status === "validated" && (
                        <p className="text-muted-foreground">
                          {tDiag("evidence", {
                            evidence:
                              entry.evidence.length > 0
                                ? entry.evidence.map((item) => item.reference).join(", ")
                                : tDiag("evidenceMissing"),
                          })}
                        </p>
                      )}
                      {entry.status === "intentional-deviation" && entry.deviation && (
                        <div className="space-y-1 text-amber-700 dark:text-amber-400">
                          <p>{tDiag("rationale", { rationale: entry.deviation.rationale })}</p>
                          <p>{tDiag("tradeOff", { tradeOff: entry.deviation.tradeOff })}</p>
                          <p>{tDiag("userImpact", { impact: entry.deviation.userImpact })}</p>
                          <p>
                            {entry.deviation.review.reviewLink
                              ? tDiag("reviewWithLink", {
                                  reviewedBy: entry.deviation.review.reviewedBy,
                                  link: entry.deviation.review.reviewLink,
                                })
                              : tDiag("review", {
                                  reviewedBy: entry.deviation.review.reviewedBy,
                                })}
                          </p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CollapsibleSection>
        )}

        {/* Config Options */}
        {configOptions.length > 0 && isActiveAgentConnected && (
          <ExternalAgentConfigOptions
            configOptions={configOptions}
            onSetConfigOption={setConfigOption}
            disabled={commandsDisabled}
            compact
          />
        )}

        {(availableCommands.length > 0 || planEntries.length > 0 || planDocument) &&
          isActiveAgentConnected &&
          isActiveAgentExecutable && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <ExternalAgentCommands
                  commands={availableCommands}
                  onExecute={handleCommandExecute}
                  isExecuting={commandsDisabled}
                />
              </div>
              <ExternalAgentPlan
                entries={planEntries}
                currentStep={planStep ?? undefined}
                document={planDocument}
              />
            </div>
          )}
      </div>

      {/* Add Agent Dialog */}
      <AddAgentDialog open={addDialogOpen} onOpenChange={setAddDialogOpen} onAdd={handleAddAgent} />

      {/* Remove confirmation */}
      <AlertDialog
        open={!!removeConfirmId}
        onOpenChange={(open) => !open && setRemoveConfirmId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tSettings("deleteAgent")}</AlertDialogTitle>
            <AlertDialogDescription>{tManager("removeAgentConfirm")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRemove}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {tCommon("remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ACP Permission Dialog */}
      <ToolApprovalDialog
        request={
          pendingPermission
            ? {
                id: pendingPermission.requestId || pendingPermission.id,
                toolName: pendingPermission.title || pendingPermission.toolInfo.name,
                toolDescription:
                  pendingPermission.reason || pendingPermission.toolInfo.description || "",
                args: pendingPermission.rawInput || {},
                riskLevel:
                  pendingPermission.riskLevel === "critical"
                    ? "high"
                    : pendingPermission.riskLevel || "medium",
                acpOptions: mapAcpOptions(pendingPermission.options),
                userInput: pendingUserInput,
              }
            : null
        }
        open={!!pendingPermission}
        onOpenChange={(open) => {
          if (!open && pendingPermission) {
            void handlePermissionDeny()
          }
        }}
        onApprove={() => {
          void handlePermissionApprove()
        }}
        onDeny={() => {
          void handlePermissionDeny()
        }}
        onSelectOption={(id, optionId) => {
          void handlePermissionSelectOption(id, optionId)
        }}
        onSubmitAnswers={(id, answers) => {
          void handlePermissionSubmitAnswers(id, answers)
        }}
      />
    </div>
  )
}

export default ExternalAgentManager
