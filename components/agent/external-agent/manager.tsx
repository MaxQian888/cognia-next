"use client"

import { ExternalAgentAuthentication } from "./authentication"
import { ExternalAgentSessionOperations } from "./session-operations"

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

import { Spinner } from "@/components/ui/spinner"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronDown,
  LayersIcon,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Settings,
  SlidersHorizontal,
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
import { diagnosticCodeForReason } from "@/lib/diagnostics/external-agent-reason"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { toast } from "@/components/ui/sonner"
import { cn } from "@/lib/utils"

import { useExternalAgent } from "@/hooks/agent"
import { useAgentTraceAnalytics } from "@/hooks/agent-trace"
import { ExternalAgentCommands } from "./commands"
import { ExternalAgentPlan } from "./plan"
import { ExternalAgentConfigOptions } from "./config-options"
import { ExternalAgentElicitationDialog } from "./elicitation-dialog"
import { ToolApprovalDialog, type ToolApprovalRequest } from "./tool-approval-dialog"
import { TraceHealthBadge } from "./trace-health-badge"
import { ConnectionStatusBadge } from "./connection-status-badge"
import { AgentFailureNotice } from "./agent-failure-notice"
import { useAgentConnectionStatus } from "@/hooks/agent/use-agent-connection-status"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { sharedStateSiblings } from "@/lib/ai/agent/external/config/instance-family"
import { useUIStore } from "@/stores/ui"
import { AgentCredentialBadge } from "./credential-status-badge"

import type {
  AcpPermissionOption,
  ExternalAgentConfig,
  ExternalAgentConnectionStatus,
  ExternalAgentValiditySnapshot,
} from "@/types/agent/external-agent"
import {
  getExternalAgentEcosystemReadiness,
  getExternalAgentExecutionBlockReason,
} from "@/lib/ai/agent/external/config/config-normalizer"
import type { ExternalAgentFailure } from "@/lib/ai/agent/external/agent-failure"
import { isEnvironmentScopedVerdict } from "@/lib/ai/agent/external/canonical-contract"
import { isExternalAgentSessionExtensionUnsupportedForMethod } from "@cognia/agent-runtime-kit/session-extension-errors"
import { approvalInput } from "@/lib/ai/agent/external/session/chat-decision-bridge"
import { getPresetConfig, getRunnablePresets } from "@/lib/ai/agent/external/config/presets"
import { PROCESS_PLANE_COMMANDS } from "@/lib/ai/agent/external/capability/process-plane"
import { useExternalAgentProcessPlane } from "@/hooks/agent/use-external-agent-process-plane"
import { useInstalledAgentRuntimes } from "@/hooks/agent/use-installed-agent-runtimes"
import { RuntimeDetectionBadge } from "./runtime-detection-badge"
import { ExternalAgentCapabilityMatrix } from "./capability-matrix"
import { useAddAgentForm } from "@/hooks/agent/use-add-agent-form"
import { useAddAgentProblemMessage } from "@/hooks/agent/use-add-agent-problem-message"
import { buildCreateExternalAgentInput } from "@/lib/ai/agent/external/config/add-agent-form"
import { ConnectionFields } from "./add-agent/connection-fields"
import {
  AddAgentCogniaModelField,
  ExecutionTuningFields,
} from "./add-agent/execution-tuning-fields"
import {
  DETECTION_UNAVAILABLE_KEYS,
  PLANE_WARNING_KEYS,
  PresetGuidance,
} from "./add-agent/preset-guidance"

import type { AddAgentFormData } from "@/types/agent/component-types"
import type { SessionObservationSummary } from "@/types/agent/agent-trace"

/**
 * Rows rendered in the Sessions section before the "show all" toggle. A busy
 * agent can carry hundreds of resumable sessions; rendering every row eagerly
 * turned a connected agent into a wall of rows the moment it was selected.
 */
const SESSION_LIST_PREVIEW_COUNT = 20

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
  pending?: boolean
  /** The last failure for THIS agent, drawn in the row the user pressed. */
  failure?: ExternalAgentFailure
  onConnect: () => void
  onDisconnect: () => void
  onRemove: () => void
  onSelect: () => void
  onDismissFailure: () => void
}

function AgentCard({
  agent,
  isActive,
  pending,
  failure,
  onConnect,
  onDisconnect,
  onRemove,
  onSelect,
  onDismissFailure,
}: AgentCardProps) {
  const t = useTranslations("externalAgent")
  const tSettings = useTranslations("externalAgent.settings")
  const tManager = useTranslations("externalAgent.manager")
  const tCommon = useTranslations("common")
  const { config, validity } = agent
  // Read from the shared map rather than from the instance this component was
  // handed. That instance is rebuilt asynchronously per hook, so it lagged
  // behind every other surface for as long as the rebuild took.
  const connectionStatus = useAgentConnectionStatus(config.id, agent.connectionStatus)
  const isConnected = connectionStatus === "connected"
  const isConnecting =
    pending || connectionStatus === "connecting" || connectionStatus === "reconnecting"
  // Subscribed, not read once. A Host still reporting its features blocks this
  // agent and then stops blocking it a moment later, and the block disables
  // the Connect button, which is the only other thing that could have brought
  // this card back. Read from render alone the row stayed dead behind copy
  // saying the state would clear on its own.
  const processPlane = useExternalAgentProcessPlane(PROCESS_PLANE_COMMANDS.spawn)
  const effectiveValidity = validity && !isEnvironmentScopedVerdict(validity) ? validity : undefined
  const executionBlockReason =
    (effectiveValidity?.executable === false ? effectiveValidity.blockingReason : null) ??
    getExternalAgentExecutionBlockReason(config, processPlane)
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
        "cursor-pointer gap-0 rounded-xl border-0 py-3 shadow-none transition-colors hover:bg-muted/60",
        isActive ? "bg-muted/60" : "bg-muted/25"
      )}
      onClick={onSelect}
    >
      <CardContent className="px-3">
        {/* One flex line for name, badges, and actions — nesting the badges in
            the title line and the buttons in a sibling column centered them
            against different heights, so the status pill floated a half-line
            above the buttons. */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="min-w-0 truncate rounded text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-pressed={isActive}
            onClick={(event) => {
              event.stopPropagation()
              onSelect()
            }}
          >
            {config.name}
          </button>
          {ecosystem?.supportTier && (
            <Badge variant="outline" className="shrink-0 text-[10px]">
              {ecosystem.supportTier}
            </Badge>
          )}
          <ConnectionStatusBadge
            status={pending ? "connecting" : connectionStatus}
            withIcon
            className="ml-auto shrink-0"
          />
          {/* Connected and signed into nothing is a real state, and it used
              to be visible only in settings. Self-hides for an agent with
              no credential probe. */}
          <AgentCredentialBadge agentId={config.id} className="shrink-0" />
          <div className="flex shrink-0 items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (connectDisabled || isConnecting) return
                    if (isConnected) {
                      onDisconnect()
                    } else {
                      onConnect()
                    }
                  }}
                  disabled={connectDisabled || isConnecting}
                  aria-label={
                    isConnecting
                      ? t("statusConnecting")
                      : isConnected
                        ? tSettings("disconnect")
                        : tSettings("connect")
                  }
                >
                  {isConnecting ? (
                    <Spinner className="size-4 " />
                  ) : isConnected ? (
                    <PowerOff className="h-4 w-4 text-destructive" />
                  ) : (
                    <Power className="h-4 w-4 text-muted-foreground" />
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
                  aria-label={tCommon("remove")}
                  disabled={isConnecting}
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
        <p className="truncate text-[11px] text-muted-foreground">
          {tManager("protocolViaTransport", {
            protocol: config.protocol.toUpperCase(),
            transport: config.transport,
          })}
          {" · "}
          {config.process?.command || config.network?.endpoint || tManager("noEndpoint")}
        </p>
        {isConnecting && (
          <p role="status" className="mt-2 text-xs text-muted-foreground">
            {tManager("connectingHint")}
          </p>
        )}
        {executionBlockReason && (
          <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
            {executionBlockReason}
          </p>
        )}
        {/* A block reason says the attempt cannot be made. A failure says one
            was made and what came back. Both can be present, and they are not
            the same sentence. */}
        {failure && (
          <AgentFailureNotice
            failure={failure}
            retrying={isConnecting}
            onRetry={connectDisabled ? undefined : onConnect}
            onDismiss={onDismissFailure}
          />
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
    <Collapsible
      defaultOpen={defaultOpen}
      className="rounded-xl bg-muted/20"
      data-testid={dataTestId}
    >
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

// The reason-code tables moved with the preset guidance they label. Re-exported
// so existing importers (and the parity test) keep their path.
export { DETECTION_UNAVAILABLE_KEYS, PLANE_WARNING_KEYS }

interface AddAgentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdd: (data: AddAgentFormData) => Promise<void> | void
}

function AddAgentDialog({ open, onOpenChange, onAdd }: AddAgentDialogProps) {
  const tSettings = useTranslations("externalAgent.settings")
  const tManager = useTranslations("externalAgent.manager")
  const tCommon = useTranslations("common")
  // Where the child would actually start. Not `isTauri()`: a browser paired to
  // a Host runs stdio agents perfectly well, and telling that user to install
  // the desktop app is advice about the wrong machine. Subscribed rather than
  // sampled, because the mid-handshake answer says it will clear once the Host
  // connects and there is no retry control on this banner to force the point.
  const processPlane = useExternalAgentProcessPlane(PROCESS_PLANE_COMMANDS.spawn)
  const planeWarning = processPlane.ok
    ? null
    : tManager(`processPlaneWarning.${PLANE_WARNING_KEYS[processPlane.reason]}`)
  // Only while the dialog is open: detection spawns `--version` reads on the
  // host, and a closed dialog has nothing to render them into.
  const detection = useInstalledAgentRuntimes(open)
  const form = useAddAgentForm()
  const problemMessage = useAddAgentProblemMessage()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const { presetId, data, setField, applyPreset, shape } = form

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const prepared = form.prepare()
    if (!prepared.ok) {
      toast.error(problemMessage(prepared.problem))
      return
    }
    setIsSubmitting(true)
    try {
      await onAdd(prepared.data)
      form.reset()
      onOpenChange(false)
    } catch (error) {
      const message =
        error instanceof Error && error.message ? error.message : tManager("addAgentFailed")
      toast.error(message)
    } finally {
      setIsSubmitting(false)
    }
  }

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
              <Select value={presetId} onValueChange={applyPreset}>
                <SelectTrigger>
                  <SelectValue placeholder={tManager("selectPresetOrConfigureManually")} />
                </SelectTrigger>
                <SelectContent>
                  {getRunnablePresets().map((runnableId) => {
                    // Route through `getPresetConfig` so plugin-contributed
                    // presets (registered via the §A-3 dynamic overlay)
                    // resolve identically to the four builtin entries.
                    const preset = getPresetConfig(runnableId)
                    if (!preset) return null
                    return (
                      <SelectItem key={runnableId} value={runnableId}>
                        <div className="flex items-center gap-2">
                          <span>{preset.name}</span>
                          <span className="text-xs text-muted-foreground">
                            ({preset.tags.join(", ")})
                          </span>
                          <RuntimeDetectionBadge detection={detection.forPreset(runnableId)} />
                        </div>
                      </SelectItem>
                    )
                  })}
                  <SelectItem value="custom">{tManager("customConfiguration")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {shape.preset && (
              <PresetGuidance presetId={presetId} preset={shape.preset} detection={detection} />
            )}

            <Separator />

            <div className="grid gap-2">
              <Label htmlFor="name">{tManager("name")}</Label>
              <Input
                id="name"
                value={data.name}
                onChange={(e) => setField("name", e.target.value)}
                // i18n-exempt: example agent name (brand), not UI prose
                placeholder="Claude Code"
                required
              />
            </div>
            <ConnectionFields form={form} planeWarning={planeWarning} />
            <ExecutionTuningFields form={form} />
            <AddAgentCogniaModelField form={form} />
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
  /**
   * Chrome the hosting dialog wants inside the body's header row — e.g. the
   * host's `DialogClose` button. The body renders it after its own actions so
   * the control sits with Refresh / Add Agent instead of floating at the
   * dialog corner, and it stays a prop (not a `DialogClose` rendered here)
   * because this body is also mounted outside a Dialog in tests.
   */
  headerActions?: React.ReactNode
}

export function ExternalAgentManager({ className, headerActions }: ExternalAgentManagerProps) {
  const t = useTranslations("externalAgent")
  const tSettings = useTranslations("externalAgent.settings")
  const tManager = useTranslations("externalAgent.manager")
  const tDiag = useTranslations("externalAgent.manager.diagnostics")
  const tDiagnostics = useTranslations("diagnostics")
  /**
   * Branch reason codes are machine identifiers (`ecosystem_prerequisite_missing`).
   * This panel used to print them verbatim, which is the only place in the app
   * that showed a user a raw snake_case token. Resolve them through the shared
   * diagnostic vocabulary; fall back to the raw code so a reason code from a
   * newer agent host degrades to today's behaviour rather than to blank.
   */
  const reasonLabel = useCallback(
    (reasonCode: string): string => {
      const code = diagnosticCodeForReason(reasonCode)
      if (!code) return reasonCode
      const key = `code.${code}.label`
      return tDiagnostics.has(key) ? tDiagnostics(key) : reasonCode
    },
    [tDiagnostics]
  )
  const tCommon = useTranslations("common")
  const refreshSessionsFailedMessage = tManager("refreshSessionsFailed")
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  /** Agent queued for removal; drives the confirmation AlertDialog. */
  const [removeConfirmId, setRemoveConfirmId] = useState<string | null>(null)
  const [deleteSessionTarget, setDeleteSessionTarget] = useState<{
    agentId: string
    sessionId: string
  } | null>(null)
  const [isDeletingSession, setIsDeletingSession] = useState(false)
  const [isAuthenticating, setIsAuthenticating] = useState(false)
  const sessionListRequest = useRef(0)
  const [sessionList, setSessionList] = useState<
    Array<{
      sessionId: string
      cwd?: string
      additionalDirectories?: string[]
      title?: string
      createdAt?: string
      updatedAt?: string
      archived?: boolean
    }>
  >([])
  const [isLoadingSessions, setIsLoadingSessions] = useState(false)
  /**
   * Which agent's session list is fully expanded — keyed by id so selecting a
   * different agent re-collapses to the preview instead of inheriting a wall.
   */
  const [sessionsExpandedFor, setSessionsExpandedFor] = useState<string | null>(null)
  const connectingIds = useRef(new Set<string>())
  const [pendingConnections, setPendingConnections] = useState<Set<string>>(new Set())

  const {
    agents,
    activeAgentId,
    activeSession,
    activeAgentValidity,
    activeLastRunSnapshot,
    activeBenchmarkCapabilities,
    isExecuting,
    isCompacting,
    isProviderUndoing,
    isLoading,
    pendingPermission,
    pendingElicitation,
    availableCommands,
    planEntries,
    planStep,
    planDocument,
    configOptions,
    richContentBlocks = [],
    compactionUpdates = [],
    nesSuggestions = [],
    addAgent,
    removeAgent,
    connect,
    disconnect,
    execute,
    executeSessionCommand,
    executeSessionShell,
    cloneSession,
    setActiveAgent,
    respondToPermission,
    respondToElicitation,
    setConfigOption,
    listSessions,
    forkSession,
    resumeSession,
    unarchiveSession,
    deleteSession,
    getAuthMethods,
    authenticate,
    getTerminalAuthState,
    cancelTerminalAuthentication,
    logout,
    refresh,
  } = useExternalAgent()
  const selectedAgentRef = useRef(activeAgentId)
  useEffect(() => {
    selectedAgentRef.current = activeAgentId
  }, [activeAgentId])

  // Read straight from the store rather than through the hook: the runtime
  // selector connects the same agents, and a failure recorded there has to
  // show here too. A copy held in this component would miss it.
  const agentFailures = useExternalAgentStore((state) => state.agentFailures)
  const clearAgentFailure = useExternalAgentStore((state) => state.clearAgentFailure)
  const connectionStatuses = useExternalAgentStore((state) => state.connectionStatus)
  const requestOpenSettings = useUIStore((state) => state.requestOpenSettings)
  const tManage = useTranslations("externalAgentManage.manager")
  const storedAgents = useExternalAgentStore((state) => state.agents)
  // Configurations that share the active one's CLI login (ADR-0216). Read from
  // the store, which holds every configuration, connected or not.
  const sharedStateAgentNames = useMemo(() => {
    if (!activeAgentId) return []
    const all = Object.values(storedAgents)
    const active = all.find((agent) => agent.id === activeAgentId)
    return active ? sharedStateSiblings(active, all).map((agent) => agent.name) : []
  }, [activeAgentId, storedAgents])
  // Same subscription the cards take: the session actions below are gated on
  // this verdict, so a Host that finishes handshaking has to reach them too.
  const panelProcessPlane = useExternalAgentProcessPlane(PROCESS_PLANE_COMMANDS.spawn)

  const handleAddAgent = useCallback(
    async (data: AddAgentFormData) => {
      const config = buildCreateExternalAgentInput(data)
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
      if (connectingIds.current.has(agentId)) return
      connectingIds.current.add(agentId)
      setPendingConnections(new Set(connectingIds.current))
      try {
        await connect(agentId)
        toast.success(tSettings("connected"))
      } catch {
        // Deliberately silent. The failure is recorded against this agent and
        // drawn in its row, and a toast saying the same thing in a corner was
        // the copy that vanished first while the row it belonged to stayed.
      } finally {
        connectingIds.current.delete(agentId)
        setPendingConnections(new Set(connectingIds.current))
      }
    },
    [connect, tSettings]
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
      try {
        if (isExecuting) await executeSessionCommand(prompt)
        else await execute(prompt)
      } catch (error) {
        if (isExecuting) toast.error(String(error))
        // `execute` records the failure against the agent before it rethrows,
        // so the report is already on screen in that agent's row. Swallowing
        // here is only about the rejection itself: `onExecute` is typed
        // `=> void` and called fire-and-forget, so letting it escape makes an
        // unhandled rejection out of a failure the user can already see.
      }
    },
    [execute, executeSessionCommand, isExecuting]
  )

  const activeAgent = activeAgentId
    ? agents.find((agent) => agent.config.id === activeAgentId) || null
    : null
  const effectiveActiveAgentValidity =
    activeAgentValidity && !isEnvironmentScopedVerdict(activeAgentValidity)
      ? activeAgentValidity
      : undefined
  const activeAgentBlockedReason =
    effectiveActiveAgentValidity?.blockingReason ??
    (activeAgent
      ? getExternalAgentExecutionBlockReason(activeAgent.config, panelProcessPlane)
      : null)
  const isActiveAgentExecutable =
    effectiveActiveAgentValidity?.executable ?? (activeAgentBlockedReason ? false : true)
  // Same map, same reason: the session actions must not stay disabled because
  // this panel's copy of the agent has not caught up yet.
  const isActiveAgentConnected =
    ((activeAgentId ? connectionStatuses[activeAgentId] : undefined) ??
      activeAgent?.connectionStatus) === "connected"
  const negotiatedCapabilities = (activeAgentValidity ?? activeAgent?.validity)?.negotiation
    ?.agentCapabilities
  const canDeleteNativeSession = Boolean(negotiatedCapabilities?.sessionCapabilities?.delete)
  const listSupport = activeAgentValidity?.sessionExtensions["session/list"]
  const forkSupport = activeAgentValidity?.sessionExtensions["session/fork"]
  const resumeSupport = activeAgentValidity?.sessionExtensions["session/resume"]
  const canUseSessionActions =
    !!activeAgentId &&
    isActiveAgentConnected &&
    isActiveAgentExecutable &&
    listSupport?.state !== "unsupported"
  const sessionsExpanded = sessionsExpandedFor === activeAgentId
  const visibleSessions = sessionsExpanded
    ? sessionList
    : sessionList.slice(0, SESSION_LIST_PREVIEW_COUNT)
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
  // `recoveryHints` are i18n key ids (see `canonical-contract.ts`), not prose.
  const recoveryHints = (activeAgentValidity?.recoveryHints || []).map((id) =>
    tDiagnostics.has(`recoveryHint.${id}`) ? tDiagnostics(`recoveryHint.${id}`) : id
  )
  const activeEcosystem =
    activeAgentValidity?.ecosystem ??
    (activeAgent ? getExternalAgentEcosystemReadiness(activeAgent.config) : undefined)
  // Entries are either a `{ id, params }` message reference this app generated
  // or prose persisted before that shape existed / supplied by a third-party
  // preset. Prose is shown as-is: there is no key to translate it by, and
  // dropping it would lose the only advice such a preset offers.
  const activeRecommendedActions = (activeEcosystem?.recommendedActions ?? []).map((action) => {
    if (typeof action === "string") return action
    const key = `recommendedAction.${action.id}`
    return tDiagnostics.has(key) ? tDiagnostics(key, action.params ?? {}) : action.id
  })
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

  const configuredCwd = String(activeAgent?.config.process?.cwd ?? "")
  const refreshSessions = useCallback(async () => {
    const request = ++sessionListRequest.current
    const isCurrent = () =>
      selectedAgentRef.current === activeAgentId && sessionListRequest.current === request
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
      const sessions = await listSessions(
        activeAgentId,
        configuredCwd ? { cwd: configuredCwd } : undefined
      )
      if (isCurrent()) setSessionList(sessions)
    } catch (err) {
      if (!isCurrent()) return
      const unsupported = isExternalAgentSessionExtensionUnsupportedForMethod(err, "session/list")
      clearSessionListIfNeeded()
      if (!unsupported) {
        toast.error(getErrorMessage(err, refreshSessionsFailedMessage))
      }
    } finally {
      if (isCurrent()) setIsLoadingSessions(false)
    }
  }, [
    activeAgentId,
    configuredCwd,
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
        if (source?.archived) {
          setIsLoadingSessions(true)
          await unarchiveSession(sessionId)
        } else await resumeSession(sessionId, options)
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
      } finally {
        setIsLoadingSessions(false)
      }
    },
    [resumeSession, unarchiveSession, refreshSessions, sessionList, tManager, getErrorMessage]
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

  const handleDeleteSession = async () => {
    if (
      !deleteSessionTarget ||
      deleteSessionTarget.agentId !== activeAgentId ||
      !canDeleteNativeSession
    )
      return
    setIsDeletingSession(true)
    try {
      const targetAgentId = deleteSessionTarget.agentId
      await deleteSession(deleteSessionTarget.sessionId)
      if (selectedAgentRef.current !== targetAgentId) return
      setSessionList((current) =>
        current.filter((entry) => entry.sessionId !== deleteSessionTarget.sessionId)
      )
      setDeleteSessionTarget(null)
      toast.success(tManager("deleteNativeSessionSuccess"))
      await refreshSessions()
    } catch (err) {
      toast.error(getErrorMessage(err, tManager("deleteNativeSessionFailed")))
    } finally {
      setIsDeletingSession(false)
    }
  }

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
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">{t("externalAgents")}</h3>
          <p className="text-sm text-muted-foreground">{tSettings("configuredAgentsDesc")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* This dialog is the quick view; editing a configuration, its
              instances and its routing lives in Settings. The shell owns the
              navigation (desktop route or mobile push), so ask it. */}
          <Button
            variant="outline"
            onClick={() => requestOpenSettings("agents")}
            data-testid="external-agent-manage-in-settings"
          >
            <SlidersHorizontal className="mr-2 h-4 w-4" />
            {tManage("manageInSettings")}
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={tManager("refresh")}
                onClick={refresh}
                disabled={isLoading}
              >
                <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{tManager("refresh")}</TooltipContent>
          </Tooltip>
          <Button onClick={() => setAddDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            {tSettings("addAgent")}
          </Button>
          {headerActions}
        </div>
      </div>

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
            <div className="grid gap-2">
              {agents.map((agent) => (
                <AgentCard
                  key={agent.config.id}
                  agent={agent}
                  isActive={activeAgentId === agent.config.id}
                  pending={pendingConnections.has(agent.config.id)}
                  failure={agentFailures[agent.config.id]}
                  onConnect={() => handleConnect(agent.config.id)}
                  onDisconnect={() => handleDisconnect(agent.config.id)}
                  onRemove={() => setRemoveConfirmId(agent.config.id)}
                  onSelect={() => setActiveAgent(agent.config.id)}
                  onDismissFailure={() => clearAgentFailure(agent.config.id)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Session Management */}
        {activeAgentId && (
          <>
            {activeAgentId &&
              getAuthMethods &&
              authenticate &&
              getTerminalAuthState &&
              cancelTerminalAuthentication &&
              logout && (
                <ExternalAgentAuthentication
                  key={activeAgentId}
                  agentId={activeAgentId}
                  methods={getAuthMethods()}
                  connected={isActiveAgentConnected}
                  busy={
                    isExecuting ||
                    isCompacting ||
                    isProviderUndoing ||
                    isLoading ||
                    isDeletingSession
                  }
                  onBusyChange={setIsAuthenticating}
                  supportsLogout={Boolean(negotiatedCapabilities?.auth?.logout)}
                  sharedStateAgentNames={sharedStateAgentNames}
                  authenticate={authenticate}
                  getTerminalAuthState={getTerminalAuthState}
                  cancelTerminalAuthentication={cancelTerminalAuthentication}
                  logout={logout}
                />
              )}
            <Collapsible defaultOpen className="rounded-xl bg-muted/20">
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
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  onClick={refreshSessions}
                  disabled={isLoadingSessions || isAuthenticating || !canUseSessionActions}
                >
                  {isLoadingSessions ? tCommon("loading") : tManager("refreshSessions")}
                </Button>
              </div>
              <CollapsibleContent className="px-3 pb-3">
                {/* Two shared configurations of one runtime read one history
                    file (ADR-0216): say so, or the list looks like it holds
                    another agent's sessions by mistake. */}
                {sharedStateAgentNames.length > 0 && (
                  <p
                    className="mb-2 flex items-start gap-1.5 text-xs text-muted-foreground"
                    data-testid="external-agent-shared-history-notice"
                  >
                    <LayersIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    {tManage("sharedHistoryNotice", {
                      names: sharedStateAgentNames.join(", "),
                    })}
                  </p>
                )}
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
                  <>
                    {/* Bounded scroll region: the list alone can be hundreds of
                      rows, and without a cap it swallows the whole dialog. */}
                    <div
                      className="max-h-72 space-y-2 overflow-y-auto"
                      data-testid="external-agent-session-list"
                    >
                      {visibleSessions.map((session) => (
                        <div
                          key={session.sessionId}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-background/50 px-2 py-2"
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
                                isLoading ||
                                isAuthenticating ||
                                isDeletingSession ||
                                (!session.archived && activeSession?.id === session.sessionId) ||
                                !isActiveAgentExecutable ||
                                !isActiveAgentConnected ||
                                (!session.archived && resumeSupport?.state === "unsupported")
                              }
                            >
                              {session.archived
                                ? t("sessionOperations.unarchive")
                                : tManager("resume")}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleForkSession(session.sessionId)}
                              disabled={
                                isExecuting ||
                                isLoading ||
                                isAuthenticating ||
                                isDeletingSession ||
                                !isActiveAgentExecutable ||
                                !isActiveAgentConnected ||
                                session.archived ||
                                forkSupport?.state === "unsupported"
                              }
                            >
                              {tManager("fork")}
                            </Button>
                            {canDeleteNativeSession && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  activeAgentId &&
                                  setDeleteSessionTarget({
                                    agentId: activeAgentId,
                                    sessionId: session.sessionId,
                                  })
                                }
                                disabled={
                                  isExecuting ||
                                  isLoading ||
                                  isDeletingSession ||
                                  isAuthenticating ||
                                  !isActiveAgentExecutable ||
                                  !isActiveAgentConnected
                                }
                              >
                                {tManager("deleteNativeSession")}
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                    {sessionList.length > SESSION_LIST_PREVIEW_COUNT && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="mt-2 w-full text-xs text-muted-foreground"
                        onClick={() =>
                          setSessionsExpandedFor(sessionsExpanded ? null : activeAgentId)
                        }
                      >
                        {sessionsExpanded
                          ? tManager("showFewerSessions")
                          : tManager("showAllSessions", { count: sessionList.length })}
                      </Button>
                    )}
                  </>
                )}
                {(resumeSupport?.state === "unsupported" ||
                  forkSupport?.state === "unsupported") && (
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
          </>
        )}

        {/* Runtime Diagnostics */}
        {activeAgent && (
          <CollapsibleSection
            title={tDiag("runtimeDiagnostics")}
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
              <p>{tDiag("richContentBlocks", { count: richContentBlocks.length })}</p>
              <p>{tDiag("compactionUpdates", { count: compactionUpdates.length })}</p>
              <p>{tDiag("nesSuggestions", { count: nesSuggestions.length })}</p>
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
                      code: reasonLabel(canonicalReasonCode),
                      reason: canonicalReason,
                    })
                  : tDiag("canonicalReason", { code: reasonLabel(canonicalReasonCode) })}
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
                      {reasonLabel(activeLastRunSnapshot.branchReasonCode)}
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
              {activeRecommendedActions.length > 0 ? (
                <p className="sm:col-span-2">
                  {tDiag("recommendedActions", { actions: activeRecommendedActions.join(" | ") })}
                </p>
              ) : null}
              {/* The merged capability answer, so a user whose /compact does
                  nothing has somewhere to look. Same artifact the CLI and the
                  execution resolver read — not a fourth reading of the preset. */}
              <div className="sm:col-span-2">
                <ExternalAgentCapabilityMatrix profile={activeAgent?.capabilityProfile} />
              </div>
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
                  disabled={!isActiveAgentConnected || !isActiveAgentExecutable || !activeSession}
                />
              </div>
              <ExternalAgentPlan
                entries={planEntries}
                currentStep={planStep ?? undefined}
                document={planDocument}
              />
            </div>
          )}
        {activeAgentId && activeSession && isActiveAgentConnected && isActiveAgentExecutable && (
          <ExternalAgentSessionOperations
            key={`${activeAgentId}:${activeSession.id}`}
            agentId={activeAgentId}
            sessionId={activeSession.id}
            isExecuting={isExecuting || isCompacting || isProviderUndoing}
            onFork={(options) => forkSession(activeSession.id, options)}
            onClone={() => cloneSession(activeSession.id)}
            onShell={executeSessionShell}
          />
        )}
      </div>

      {/* Add Agent Dialog */}
      <AddAgentDialog open={addDialogOpen} onOpenChange={setAddDialogOpen} onAdd={handleAddAgent} />

      <AlertDialog
        open={deleteSessionTarget !== null && deleteSessionTarget.agentId === activeAgentId}
        onOpenChange={(open) => {
          if (!open && !isDeletingSession) setDeleteSessionTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tManager("deleteNativeSession")}</AlertDialogTitle>
            <AlertDialogDescription>
              {tManager("deleteNativeSessionConfirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingSession}>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={
                isExecuting ||
                isLoading ||
                isDeletingSession ||
                isAuthenticating ||
                !isActiveAgentConnected ||
                !canDeleteNativeSession
              }
              onClick={(event) => {
                event.preventDefault()
                void handleDeleteSession()
              }}
            >
              {isDeletingSession ? tCommon("loading") : tManager("deleteNativeSession")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
                // Kimi Code sends no `rawInput` until after the answer; show the
                // arguments recovered from its stream, as the chat surface does.
                args: approvalInput(pendingPermission),
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

      {/* Blocking questions that are NOT tool approvals: Pi's confirm/select/
          input/editor dialogs and ACP's elicitation/create. Before this the
          canonical `elicitation_request` reached the renderer and was dropped,
          leaving the agent blocked for the rest of the turn. */}
      <ExternalAgentElicitationDialog
        request={pendingElicitation}
        onRespond={(response) => {
          void respondToElicitation(response)
        }}
      />
    </div>
  )
}

export default ExternalAgentManager
