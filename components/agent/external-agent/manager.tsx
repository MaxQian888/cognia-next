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
 *   - The agent's own session list: open one as a Cognia conversation, fork,
 *     unarchive, delete — gated by extension support.
 *   - Diagnostics and compatibility (benchmark adaptation) tabs.
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
import { useLocale, useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import {
  ArchiveRestore,
  Bot,
  GitBranch,
  LayersIcon,
  MessageSquareShare,
  MousePointerClick,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
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
import { Badge } from "@/components/ui/badge"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
import { ExternalAgentDiagnosticsPanel } from "./diagnostics-panel"
import { ExternalAgentCompatibilityPanel } from "./compatibility-panel"
import { buildSessionHref } from "@/lib/chat/message-permalink"
import {
  createOpenNativeSessionInChatDeps,
  openNativeSessionInChat,
  type NativeSessionEntry,
} from "@/lib/ai/agent/external/session/open-native-session-in-chat"
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

/**
 * One scroll region per tab panel, from `md` up. Below `md` the panes stack
 * and the dialog body scrolls as a whole instead.
 */
const TAB_PANEL_CLASS = "min-h-0 flex-1 px-1 py-4 md:overflow-y-auto md:px-5"

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
    // A flat roster row (name + actions, status badges, endpoint) rather than
    // a card: the selection highlight is the only chrome. The surface name
    // lives in the Diagnostics tab, not here.
    <div
      data-testid={`agent-card-${config.id}`}
      className={cn(
        "min-w-0 cursor-pointer space-y-1 rounded-lg px-2.5 py-2 transition-colors",
        isActive ? "bg-accent" : "hover:bg-muted/50"
      )}
      onClick={onSelect}
    >
      {/* Name and the two actions share the first line; status badges sit on
            the second, so a narrow roster column never squeezes the name down
            to an ellipsis to make room for them. */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className="min-w-0 flex-1 truncate rounded text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-pressed={isActive}
          onClick={(event) => {
            event.stopPropagation()
            onSelect()
          }}
        >
          {config.name}
        </button>
        <div className="-mr-1.5 flex shrink-0 items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="size-7"
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
                  <Spinner className="size-3.5" />
                ) : isConnected ? (
                  <PowerOff className="size-3.5 text-destructive" />
                ) : (
                  <Power className="size-3.5 text-muted-foreground" />
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
                size="icon-xs"
                className="size-7"
                aria-label={tCommon("remove")}
                disabled={isConnecting}
                onClick={(e) => {
                  e.stopPropagation()
                  onRemove()
                }}
              >
                <Trash2 className="size-3.5 text-muted-foreground" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{tCommon("remove")}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <ConnectionStatusBadge
          status={pending ? "connecting" : connectionStatus}
          withIcon
          className="shrink-0"
        />
        {ecosystem?.supportTier && (
          <Badge variant="outline" className="shrink-0 text-[10px]">
            {ecosystem.supportTier}
          </Badge>
        )}
        {/* Connected and signed into nothing is a real state, and it used
              to be visible only in settings. Self-hides for an agent with
              no credential probe. */}
        <AgentCredentialBadge agentId={config.id} className="shrink-0" />
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
      {/* One line here; the detail pane spells the reason out in full. */}
      {executionBlockReason && (
        <p
          className="truncate text-[11px] text-amber-600 dark:text-amber-400"
          title={executionBlockReason}
        >
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
    </div>
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
  /**
   * Called once a native session has been opened as a conversation, right
   * before navigating to it. The hosting dialog closes itself here; the
   * conversation it would otherwise cover is the thing the user asked for.
   */
  onOpenedInChat?: () => void
}

/** "3 min ago" style label for a session row; empty for an unparseable value. */
function relativeTime(value: string | undefined, locale: string): string {
  if (!value) return ""
  const at = new Date(value).getTime()
  if (Number.isNaN(at)) return ""
  const seconds = Math.round((at - Date.now()) / 1000)
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
  const abs = Math.abs(seconds)
  if (abs < 60) return format.format(seconds, "second")
  if (abs < 3600) return format.format(Math.round(seconds / 60), "minute")
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), "hour")
  if (abs < 2_592_000) return format.format(Math.round(seconds / 86_400), "day")
  return new Date(at).toLocaleDateString(locale)
}

export function ExternalAgentManager({
  className,
  headerActions,
  onOpenedInChat,
}: ExternalAgentManagerProps) {
  const t = useTranslations("externalAgent")
  const tSettings = useTranslations("externalAgent.settings")
  const tManager = useTranslations("externalAgent.manager")
  const tDiag = useTranslations("externalAgent.manager.diagnostics")
  const locale = useLocale()
  const router = useRouter()
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
  /** Which detail tab is showing; kept across agent switches. */
  const [detailTab, setDetailTab] = useState("sessions")
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
  const activeEcosystem =
    activeAgentValidity?.ecosystem ??
    (activeAgent ? getExternalAgentEcosystemReadiness(activeAgent.config) : undefined)
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

  /** An archived native session comes back into the list before it can be opened. */
  const handleUnarchiveSession = useCallback(
    async (sessionId: string) => {
      setIsLoadingSessions(true)
      try {
        await unarchiveSession(sessionId)
        await refreshSessions()
      } catch (err) {
        toast.error(getErrorMessage(err, tManager("resumeSessionFailed")))
      } finally {
        setIsLoadingSessions(false)
      }
    },
    [unarchiveSession, refreshSessions, tManager, getErrorMessage]
  )

  const [openingSessionId, setOpeningSessionId] = useState<string | null>(null)
  /**
   * Continue an agent-side session as a Cognia conversation. Resuming it inside
   * this dialog alone changed nothing the user could see; the conversation is
   * where they type the next message.
   */
  const handleOpenInChat = useCallback(
    async (entry: NativeSessionEntry) => {
      if (!activeAgentId) return
      setOpeningSessionId(entry.sessionId)
      try {
        const deps = await createOpenNativeSessionInChatDeps((sessionId, options) =>
          resumeSession(sessionId, options)
        )
        const { chatSessionId } = await openNativeSessionInChat(activeAgentId, entry, deps)
        onOpenedInChat?.()
        // Through the session link, not the store: the link consumer on `/`
        // switches to the chat's workspace before focusing it.
        router.push(`/${buildSessionHref(chatSessionId)}`)
      } catch (err) {
        if (isExternalAgentSessionExtensionUnsupportedForMethod(err, "session/resume")) {
          toast.error(tDiag("resumeUnsupported", { reason: tDiag("resumeUnsupportedDefault") }))
          return
        }
        toast.error(getErrorMessage(err, tManager("openInChatFailed")))
      } finally {
        setOpeningSessionId(null)
      }
    },
    [activeAgentId, resumeSession, onOpenedInChat, router, tDiag, tManager, getErrorMessage]
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

  const sessionActionsBusy = isExecuting || isLoading || isAuthenticating || isDeletingSession
  const sessionsBlockedMessage = !isActiveAgentExecutable
    ? { tone: "warn" as const, text: activeAgentBlockedReason || tDiag("notExecutable") }
    : !isActiveAgentConnected
      ? { tone: "muted" as const, text: tDiag("connectAgentToList") }
      : listSupport?.state === "unsupported"
        ? { tone: "warn" as const, text: listSupport.reason || tDiag("sessionListingUnsupported") }
        : null
  const hasCurrentSessionControls =
    isActiveAgentConnected &&
    ((configOptions.length > 0 && Boolean(activeSession)) ||
      (isActiveAgentExecutable &&
        (availableCommands.length > 0 || planEntries.length > 0 || Boolean(planDocument))) ||
      (Boolean(activeSession) && isActiveAgentExecutable))

  return (
    <div className={cn("flex min-h-0 flex-col gap-4", className)}>
      {/* Header. One button height (sm) throughout, icon-only where the
          action is self-evident, and the host's close control set apart by a
          divider rather than crowding Add Agent. */}
      <div className="flex shrink-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-lg leading-tight font-semibold">{t("externalAgents")}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{tSettings("configuredAgentsDesc")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={tManager("refresh")}
                onClick={refresh}
                disabled={isLoading}
              >
                <RefreshCw className={cn("size-4", isLoading && "animate-spin")} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{tManager("refresh")}</TooltipContent>
          </Tooltip>
          {/* This dialog is the quick view; editing a configuration, its
              instances and its routing lives in Settings. The shell owns the
              navigation (desktop route or mobile push), so ask it. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => requestOpenSettings("agents")}
                aria-label={tManage("manageInSettings")}
                data-testid="external-agent-manage-in-settings"
              >
                <SlidersHorizontal className="size-4" />
                <span className="hidden md:inline">{tManage("manageInSettings")}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent className="md:hidden">{tManage("manageInSettings")}</TooltipContent>
          </Tooltip>
          <Button
            size="sm"
            onClick={() => setAddDialogOpen(true)}
            aria-label={tSettings("addAgent")}
          >
            <Plus className="size-4" />
            <span className="hidden sm:inline">{tSettings("addAgent")}</span>
          </Button>
          {headerActions && (
            <>
              <Separator orientation="vertical" className="mx-1 h-5!" />
              {headerActions}
            </>
          )}
        </div>
      </div>

      {agents.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center py-12 text-center">
          <Bot className="mb-4 size-12 text-muted-foreground/50" />
          <h4 className="text-lg font-medium">{tManager("noExternalAgents")}</h4>
          <p className="mt-1 text-sm text-muted-foreground">{tSettings("addAgentToStart")}</p>
          <Button className="mt-4" onClick={() => setAddDialogOpen(true)}>
            <Plus className="size-4" />
            {tSettings("addAgent")}
          </Button>
        </div>
      ) : (
        // Two panes from `md` up: the roster on the left, the selected agent
        // on the right, each scrolling on its own. The single row is
        // `minmax(0,1fr)`, not the implicit `auto`: an auto row grows to its
        // content, so a long tab pushed the pane past the dialog instead of
        // scrolling inside it. Below `md` they stack and
        // the body scrolls as one, with the roster capped so the detail pane
        // is never pushed out of reach.
        <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1 md:mx-0 md:grid md:grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)] md:gap-0 md:overflow-hidden md:px-0">
          <aside className="flex shrink-0 flex-col gap-2 md:min-h-0 md:pr-3">
            <div className="flex items-center gap-2 px-1">
              <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {tManager("agentsHeading")}
              </span>
              <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                {agents.length}
              </Badge>
            </div>
            <div className="-mx-1 max-h-60 overflow-y-auto px-1 py-0.5 md:max-h-none md:min-h-0 md:flex-1">
              <div className="grid gap-0.5">
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
          </aside>

          <section
            className="flex min-w-0 shrink-0 flex-col border-t md:min-h-0 md:shrink md:overflow-hidden md:border-t-0 md:border-l"
            data-testid="external-agent-detail"
          >
            {!activeAgent || !activeAgentId ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-12 text-center text-sm text-muted-foreground">
                <MousePointerClick className="size-8 text-muted-foreground/50" aria-hidden />
                {tManager("selectAgentHint")}
              </div>
            ) : (
              // The tab strip stays put; only the active tab's content scrolls.
              <Tabs
                value={detailTab}
                onValueChange={setDetailTab}
                className="flex min-h-0 flex-1 flex-col gap-0"
              >
                {/* Sign-in stays mounted above the tabs: an inactive tab panel
                    is unmounted, and a sign-in in flight must survive a tab
                    switch. `empty:hidden` drops the padding when there is
                    nothing to sign in to. */}
                <div className="max-h-56 shrink-0 overflow-y-auto px-1 pt-3 empty:hidden md:px-5">
                  {getAuthMethods &&
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
                </div>
                <div className="shrink-0 border-b px-1 pt-1 md:px-5">
                  <TabsList variant="line" className="h-9! w-full justify-start">
                    <TabsTrigger value="sessions" className="flex-none px-3">
                      {tManager("tabSessions")}
                      {sessionList.length > 0 && (
                        <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                          {sessionList.length}
                        </Badge>
                      )}
                    </TabsTrigger>
                    <TabsTrigger value="diagnostics" className="flex-none px-3">
                      {tManager("tabDiagnostics")}
                    </TabsTrigger>
                    <TabsTrigger value="compatibility" className="flex-none px-3">
                      {tManager("tabCompatibility")}
                      {benchmarkEntries.length > 0 && (
                        <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                          {benchmarkEntries.length}
                        </Badge>
                      )}
                    </TabsTrigger>
                  </TabsList>
                </div>

                <TabsContent value="sessions" className={cn(TAB_PANEL_CLASS, "space-y-3")}>
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-xs text-muted-foreground">{tManager("sessionsHint")}</p>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="-mt-1 shrink-0"
                          aria-label={tManager("refreshSessions")}
                          onClick={refreshSessions}
                          disabled={isLoadingSessions || isAuthenticating || !canUseSessionActions}
                        >
                          <RefreshCw
                            className={cn("size-4", isLoadingSessions && "animate-spin")}
                          />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {isLoadingSessions ? tCommon("loading") : tManager("refreshSessions")}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  {/* Two shared configurations of one runtime read one
                        history file (ADR-0216): say so, or the list looks like
                        it holds another agent's sessions by mistake. */}
                  {sharedStateAgentNames.length > 0 && (
                    <p
                      className="flex items-start gap-1.5 text-xs text-muted-foreground"
                      data-testid="external-agent-shared-history-notice"
                    >
                      <LayersIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      {tManage("sharedHistoryNotice", {
                        names: sharedStateAgentNames.join(", "),
                      })}
                    </p>
                  )}
                  {sessionsBlockedMessage ? (
                    <p
                      className={cn(
                        "px-3 py-10 text-center text-xs",
                        sessionsBlockedMessage.tone === "warn"
                          ? "text-amber-700 dark:text-amber-400"
                          : "text-muted-foreground"
                      )}
                    >
                      {sessionsBlockedMessage.text}
                    </p>
                  ) : sessionList.length === 0 ? (
                    <p className="px-3 py-10 text-center text-xs text-muted-foreground">
                      {isLoadingSessions ? tCommon("loading") : tManager("noResumableSessions")}
                    </p>
                  ) : (
                    <>
                      {/* Bounded scroll region: the list alone can be
                            hundreds of rows. */}
                      <ul
                        className="-mx-2 max-h-80 overflow-y-auto"
                        data-testid="external-agent-session-list"
                      >
                        {visibleSessions.map((session) => {
                          const updated = relativeTime(
                            session.updatedAt ?? session.createdAt,
                            locale
                          )
                          const meta = [
                            updated ? tManager("updatedAt", { time: updated }) : "",
                            session.cwd ?? "",
                          ].filter(Boolean)
                          const isLive = activeSession?.id === session.sessionId
                          const opening = openingSessionId === session.sessionId
                          return (
                            <li
                              key={session.sessionId}
                              className="flex items-center gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-muted/50"
                            >
                              <div className="min-w-0 flex-1" title={session.sessionId}>
                                <p className="flex items-center gap-1.5 text-sm">
                                  <span className="truncate font-medium">
                                    {session.title || tManager("untitledSession")}
                                  </span>
                                  {session.archived && (
                                    <Badge variant="outline" className="shrink-0 text-[10px]">
                                      {tManager("archivedSession")}
                                    </Badge>
                                  )}
                                </p>
                                <p className="truncate text-[11px] text-muted-foreground">
                                  {meta.length > 0 ? (
                                    meta.join(" · ")
                                  ) : (
                                    <span className="font-mono">{session.sessionId}</span>
                                  )}
                                </p>
                              </div>
                              <div className="flex shrink-0 items-center gap-0.5">
                                {session.archived ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => handleUnarchiveSession(session.sessionId)}
                                    disabled={
                                      sessionActionsBusy ||
                                      !isActiveAgentExecutable ||
                                      !isActiveAgentConnected
                                    }
                                  >
                                    <ArchiveRestore className="size-4" />
                                    {t("sessionOperations.unarchive")}
                                  </Button>
                                ) : (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="secondary"
                                        size="sm"
                                        aria-label={tManager("openInChat")}
                                        onClick={() => handleOpenInChat(session)}
                                        disabled={
                                          sessionActionsBusy ||
                                          openingSessionId !== null ||
                                          !isActiveAgentExecutable ||
                                          !isActiveAgentConnected ||
                                          (!isLive && resumeSupport?.state === "unsupported")
                                        }
                                      >
                                        {opening ? (
                                          <Spinner className="size-4" />
                                        ) : (
                                          <MessageSquareShare className="size-4" />
                                        )}
                                        <span className="hidden sm:inline">
                                          {tManager("openInChat")}
                                        </span>
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent className="sm:hidden">
                                      {tManager("openInChat")}
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon-sm"
                                      aria-label={tManager("fork")}
                                      onClick={() => handleForkSession(session.sessionId)}
                                      disabled={
                                        sessionActionsBusy ||
                                        !isActiveAgentExecutable ||
                                        !isActiveAgentConnected ||
                                        session.archived ||
                                        forkSupport?.state === "unsupported"
                                      }
                                    >
                                      <GitBranch className="size-4" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>{tManager("fork")}</TooltipContent>
                                </Tooltip>
                                {canDeleteNativeSession && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label={tManager("deleteNativeSession")}
                                        onClick={() =>
                                          setDeleteSessionTarget({
                                            agentId: activeAgentId,
                                            sessionId: session.sessionId,
                                          })
                                        }
                                        disabled={
                                          sessionActionsBusy ||
                                          !isActiveAgentExecutable ||
                                          !isActiveAgentConnected
                                        }
                                      >
                                        <Trash2 className="size-4 text-muted-foreground" />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      {tManager("deleteNativeSession")}
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                              </div>
                            </li>
                          )
                        })}
                      </ul>
                      {sessionList.length > SESSION_LIST_PREVIEW_COUNT && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="w-full text-xs text-muted-foreground"
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
                    <div className="space-y-1 text-[11px] text-amber-700 dark:text-amber-400">
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

                  {/* The session this dialog's agent is currently attached
                        to: its mode/model options, slash commands, plan and
                        session operations. */}
                  {hasCurrentSessionControls && (
                    <div className="space-y-3 border-t pt-3">
                      <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                        {tManager("currentSession")}
                      </h4>
                      {configOptions.length > 0 && (
                        <ExternalAgentConfigOptions
                          configOptions={configOptions}
                          onSetConfigOption={setConfigOption}
                          disabled={commandsDisabled}
                          compact
                        />
                      )}
                      {(availableCommands.length > 0 || planEntries.length > 0 || planDocument) &&
                        isActiveAgentExecutable && (
                          <div className="flex flex-col gap-3">
                            <div className="flex items-center gap-2">
                              <ExternalAgentCommands
                                commands={availableCommands}
                                onExecute={handleCommandExecute}
                                isExecuting={commandsDisabled}
                                disabled={!isActiveAgentExecutable || !activeSession}
                              />
                            </div>
                            <ExternalAgentPlan
                              entries={planEntries}
                              currentStep={planStep ?? undefined}
                              document={planDocument}
                            />
                          </div>
                        )}
                      {activeSession && isActiveAgentExecutable && (
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
                  )}
                </TabsContent>

                <TabsContent value="diagnostics" className={TAB_PANEL_CLASS}>
                  <ExternalAgentDiagnosticsPanel
                    config={activeAgent.config}
                    capabilityProfile={activeAgent.capabilityProfile}
                    validity={activeAgentValidity ?? undefined}
                    executable={isActiveAgentExecutable}
                    blockedReason={activeAgentBlockedReason}
                    ecosystem={activeEcosystem}
                    activity={{
                      richContentBlocks: richContentBlocks.length,
                      compactionUpdates: compactionUpdates.length,
                      nesSuggestions: nesSuggestions.length,
                    }}
                    lastRun={activeLastRunSnapshot}
                    lastRunHealth={lastRunHealthSummary}
                  />
                </TabsContent>

                <TabsContent value="compatibility" className={TAB_PANEL_CLASS}>
                  <ExternalAgentCompatibilityPanel entries={benchmarkEntries} />
                </TabsContent>
              </Tabs>
            )}
          </section>
        </div>
      )}

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
