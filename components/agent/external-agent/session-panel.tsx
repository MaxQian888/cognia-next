"use client"

/**
 * Session-runtime panel for the active external agent.
 *
 * Renders three pieces of session metadata that ACP agents push during a
 * live session: available slash commands, current execution plan, and
 * session-level config options (mode / model / thought-level).
 *
 * Mounted in `ChatPane` between the header and the message list. Returns
 * `null` when the runtime is not "external" or there is no live data,
 * so the chat surface stays unchanged for built-in runs.
 */

import {
  useRuntimeRefForSession,
  useExternalSessionLinkForSession,
  useAgentRuntimeStore,
} from "@/stores/agent/agent-runtime-store"
import { useExternalAgent } from "@/hooks/agent/use-external-agent"
import { ExternalAgentCommands } from "./commands"
import { ExternalAgentConfigOptions } from "./config-options"
import { ExternalAgentPlan } from "./plan"
import { ExternalAgentSessionOperations } from "./session-operations"
import { ToolApprovalDialog } from "./tool-approval-dialog"
import { ExternalAgentElicitationDialog } from "./elicitation-dialog"
import { approvalInput } from "@/lib/ai/agent/external/session/chat-decision-bridge"
import {
  PluginExtensionSlot,
  usePluginSlotHasExtensions,
} from "@/components/plugins/plugin-extension-slot"
import { useEffect, useMemo, useRef, useState } from "react"
import { useChatStore } from "@/stores/chat/chat-store"
import {
  createRemoteSessionOperationsClient,
  watchRemoteSession,
} from "@/lib/ai/agent/external/runtimes/remote/remote-run-client"
import type { AcpPermissionRequest, AcpPermissionResponse } from "@/types/agent/external-agent"
import type { ExternalSessionLink } from "@/stores/agent/agent-runtime-store"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { GitBranchIcon, Shrink, Undo2 } from "lucide-react"
import { isExternalAgentSessionExtensionUnsupportedForMethod } from "@cognia/agent-runtime-kit/session-extension-errors"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"

interface Props {
  className?: string
  /**
   * The conversation this panel describes. The runtime lane is per session, so
   * without it the panel would answer for whatever lane a DIFFERENT
   * conversation happens to be on.
   */
  sessionId?: string
  externalSession?: { agentId: string; sessionId: string }
  onExecuteCommand?: (command: string) => Promise<void>
}

export function ExternalAgentSessionPanel(props: Props) {
  const runtime = useRuntimeRefForSession(props.sessionId)
  const live = useExternalSessionLinkForSession(props.sessionId)
  if (runtime.kind === "host")
    return live?.host && props.sessionId ? (
      <RemoteSessionPanel
        key={`${live.agentId}:${live.sessionId}`}
        {...props}
        chatSessionId={props.sessionId}
        link={live}
      />
    ) : null
  return <LocalExternalAgentSessionPanel {...props} />
}

function RemoteSessionPanel({
  link,
  chatSessionId,
  className,
  onExecuteCommand,
}: Props & { link: ExternalSessionLink; chatSessionId: string }) {
  const target = useMemo(
    () => ({ stamp: link.host!, chatSessionId, externalSessionId: link.sessionId }),
    [link, chatSessionId]
  )
  const manager = useMemo(() => createRemoteSessionOperationsClient(target), [target])
  const isExecuting = useChatStore((state) =>
    ["streaming", "awaiting_approval"].includes(state.sessions[chatSessionId]?.status ?? "idle")
  )
  const [commands, setCommands] = useState<
    import("@/types/agent/external-agent").AcpAvailableCommand[]
  >([])
  useEffect(() => {
    let disposed = false
    let close: (() => Promise<void>) | undefined
    void manager
      .getSessionOperationCapabilities(link.agentId, link.sessionId)
      .then(async (capabilities) => {
        if (capabilities.commands === "supported") {
          const value = await manager.refreshSessionCommands(link.agentId, link.sessionId)
          if (!disposed) setCommands(value)
        }
        if (disposed) return
        const watcher = await watchRemoteSession(
          target,
          {
            onEvent: (event) => {
              if (!disposed && event.type === "commands_update") setCommands(event.commands)
            },
            onTerminal: (_status, error) => {
              if (!disposed && error) toast.error(error)
            },
          },
          "presentation"
        )
        close = watcher.close
        if (disposed) await close()
      })
      .catch((error) => {
        if (!disposed) toast.error(String(error))
      })
    return () => {
      disposed = true
      void close?.()
    }
  }, [manager, target, link.agentId, link.sessionId])
  const [permission, setPermission] = useState<AcpPermissionRequest>()
  const permissionReply = useRef<((response: AcpPermissionResponse) => void) | undefined>(undefined)
  useEffect(
    () => () => {
      permissionReply.current?.({ requestId: "", granted: false })
    },
    []
  )
  const finishPermission = (granted: boolean, rememberChoice = false) => {
    if (!permission) return
    permissionReply.current?.({
      requestId: permission.requestId ?? permission.id,
      granted,
      rememberChoice,
    })
    permissionReply.current = undefined
    setPermission(undefined)
  }
  const selectSession = (next: { id: string }) => {
    useAgentRuntimeStore
      .getState()
      .setSessionExternalLink(chatSessionId, { ...link, sessionId: next.id })
    return next
  }
  return (
    <div className={className}>
      {commands.length > 0 && (
        <ExternalAgentCommands
          commands={commands}
          isExecuting={isExecuting}
          onExecute={(command, args) => {
            const input = `${command}${args ? ` ${args}` : ""}`
            void (
              isExecuting
                ? manager.executeSessionCommand(link.agentId, link.sessionId, input)
                : onExecuteCommand?.(input)
            )?.catch((error) => toast.error(String(error)))
          }}
        />
      )}
      <ExternalAgentSessionOperations
        manager={manager}
        agentId={link.agentId}
        sessionId={link.sessionId}
        isExecuting={isExecuting}
        onFork={async (options) =>
          selectSession(await manager.forkSession(link.agentId, link.sessionId, options))
        }
        onClone={async () =>
          selectSession(await manager.cloneSession(link.agentId, link.sessionId))
        }
        onShell={(command, options) =>
          manager.executeSessionShell(link.agentId, link.sessionId, command, {
            ...options,
            onPermissionRequest: (request) =>
              new Promise((resolve) => {
                permissionReply.current = resolve
                setPermission(request)
              }),
          })
        }
      />
      <ToolApprovalDialog
        request={
          permission
            ? {
                id: permission.requestId ?? permission.id,
                toolName: permission.title ?? permission.toolInfo.name,
                toolDescription: permission.reason ?? permission.toolInfo.description ?? "",
                args: approvalInput(permission),
                riskLevel:
                  permission.riskLevel === "critical" ? "high" : (permission.riskLevel ?? "medium"),
                acpOptions: permission.options,
              }
            : null
        }
        open={Boolean(permission)}
        onOpenChange={(open) => {
          if (!open) finishPermission(false)
        }}
        onApprove={(_id, always) => finishPermission(true, always)}
        onDeny={() => finishPermission(false)}
        onSelectOption={(_id, optionId) => {
          const option = permission?.options?.find((item) => item.optionId === optionId)
          finishPermission(
            option?.kind === "allow_once" || option?.kind === "allow_always",
            option?.kind === "allow_always"
          )
        }}
      />
    </div>
  )
}

function LocalExternalAgentSessionPanel({
  className,
  sessionId,
  externalSession,
  onExecuteCommand,
}: Props) {
  const liveSessionLink = useExternalSessionLinkForSession(sessionId)
  const sessionLink = liveSessionLink ?? externalSession
  const [focusOpen, setFocusOpen] = useState(false)
  const [focus, setFocus] = useState("")
  const [providerUndoWarningOpen, setProviderUndoWarningOpen] = useState(false)
  const runtime = useRuntimeRefForSession(sessionId).kind === "builtin" ? "claude-sdk" : "external"
  const t = useTranslations("chat.header")
  const {
    isExecuting,
    activeSession,
    activeAgentId,
    cloneSession,
    executeSessionCommand,
    executeSessionShell,
    pendingPermission,
    pendingElicitation,
    respondToPermission,
    respondToElicitation,
    availableCommands,
    planEntries,
    planStep,
    planDocument,
    configOptions,
    setConfigOption,
    execute,
    forkSession,
    compactSession,
    supportsCompaction,
    supportsCompactionFocus,
    isCompacting,
    undoLastProviderChange,
    providerUndoCapability,
    providerUndoAcknowledged,
    acknowledgeProviderUndoWarning,
    isProviderUndoing,
  } = useExternalAgent(sessionLink)

  const hasPluginToolbar = usePluginSlotHasExtensions("agent.external-session.toolbar")

  if (runtime !== "external") return null
  if (
    sessionId &&
    (!sessionLink ||
      sessionLink.agentId !== activeAgentId ||
      sessionLink.sessionId !== activeSession?.id)
  )
    return null

  const hasCommands = availableCommands.length > 0
  const hasPlan = planEntries.length > 0 || Boolean(planDocument)
  const hasConfigOptions = configOptions.length > 0
  const canFork = Boolean(activeSession)
  const sessionBusy = isExecuting || isCompacting || isProviderUndoing
  const supportsProviderUndo = providerUndoCapability?.status === "supported"

  // Render when there is native session data OR a plugin contributes a toolbar
  // control — otherwise the panel chrome would show empty.
  if (!hasCommands && !hasPlan && !hasConfigOptions && !canFork && !hasPluginToolbar) return null

  const selectSession = (next: { id: string }) => {
    if (sessionId && activeAgentId)
      useAgentRuntimeStore
        .getState()
        .setSessionExternalLink(sessionId, { agentId: activeAgentId, sessionId: next.id })
    return next
  }

  const handleFork = async () => {
    if (!activeSession) return
    try {
      selectSession(await forkSession(activeSession.id))
      toast.success(t("forkSuccess"))
    } catch (err) {
      if (isExternalAgentSessionExtensionUnsupportedForMethod(err, "session/fork")) {
        toast.error(t("forkUnsupported"))
        return
      }
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleCompact = async () => {
    if (!activeSession) return
    const toastId = toast.loading(t("compactProgress"))
    try {
      await compactSession(activeSession.id)
      toast.success(t("compactSuccess"), { id: toastId })
    } catch (err) {
      toast.error(
        t("compactFailure", { error: err instanceof Error ? err.message : String(err) }),
        {
          id: toastId,
        }
      )
    }
  }

  const handleFocusedCompact = async () => {
    if (!activeSession || !focus.trim()) return
    const toastId = toast.loading(t("compactProgress"))
    try {
      await compactSession(activeSession.id, { focus: focus.trim() })
      setFocusOpen(false)
      setFocus("")
      toast.success(t("compactSuccess"), { id: toastId })
    } catch (err) {
      toast.error(
        t("compactFailure", { error: err instanceof Error ? err.message : String(err) }),
        {
          id: toastId,
        }
      )
    }
  }

  const executeProviderUndo = async () => {
    if (!activeSession) return
    const toastId = toast.loading(t("providerUndoProgress"))
    try {
      await undoLastProviderChange(activeSession.id)
      toast.success(t("providerUndoSuccess"), { id: toastId })
    } catch (err) {
      toast.error(
        t("providerUndoFailure", { error: err instanceof Error ? err.message : String(err) }),
        { id: toastId }
      )
    }
  }

  const handleProviderUndo = () => {
    if (providerUndoAcknowledged) {
      void executeProviderUndo()
      return
    }
    setProviderUndoWarningOpen(true)
  }

  return (
    <div
      className={cn("flex shrink-0 flex-col gap-2 border-b bg-background/60 px-3 py-2", className)}
    >
      {(hasCommands || hasConfigOptions || canFork || hasPluginToolbar) && (
        <div className="flex flex-wrap items-center gap-2">
          {hasCommands && (
            <ExternalAgentCommands
              commands={availableCommands}
              onExecute={(command, args) => {
                const prompt = args ? `${command} ${args}` : command
                void (
                  isExecuting
                    ? executeSessionCommand(prompt)
                    : onExecuteCommand
                      ? onExecuteCommand(prompt)
                      : execute(prompt)
                ).catch((err: unknown) => toast.error(String(err)))
              }}
              isExecuting={isExecuting}
              disabled={isCompacting || isProviderUndoing}
            />
          )}
          {hasConfigOptions && (
            <ExternalAgentConfigOptions
              configOptions={configOptions}
              onSetConfigOption={setConfigOption}
              disabled={sessionBusy}
              compact
            />
          )}
          {canFork && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={() => void handleFork()}
              disabled={sessionBusy}
              aria-label={t("forkAria")}
              title={t("forkTooltip")}
            >
              <GitBranchIcon className="size-3.5" />
              {t("forkAria")}
            </Button>
          )}
          {Boolean(activeSession) && supportsCompaction && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={() => void handleCompact()}
              disabled={sessionBusy}
              aria-label={t("compactAria")}
              title={t("compactTooltip")}
              data-testid="session-compact-button"
            >
              <Shrink className="size-3.5" />
              {isCompacting ? t("compactProgress") : t("compactAria")}
            </Button>
          )}
          {Boolean(activeSession) && supportsCompaction && supportsCompactionFocus && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setFocusOpen(true)}
              disabled={sessionBusy}
              aria-label={t("compactFocusAria")}
              title={t("compactFocusTooltip")}
              data-testid="session-compact-focus-button"
            >
              {t("compactFocusAria")}
            </Button>
          )}
          {Boolean(activeSession) && supportsProviderUndo && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={handleProviderUndo}
              disabled={sessionBusy}
              aria-label={t("providerUndoAria")}
              title={t("providerUndoTooltip")}
              data-testid="provider-undo-button"
            >
              <Undo2 className="size-3.5" />
              {isProviderUndoing ? t("providerUndoProgress") : t("providerUndoAria")}
            </Button>
          )}
          {/* Plugin-contributed external-session controls. */}
          <PluginExtensionSlot
            point="agent.external-session.toolbar"
            className="flex items-center gap-1 empty:hidden"
            context={{
              sessionId: activeSession?.id,
              isExecuting,
              hasPlan,
              hasCommands,
            }}
          />
        </div>
      )}
      {activeAgentId && activeSession && (
        <ExternalAgentSessionOperations
          key={`${activeAgentId}:${activeSession.id}`}
          agentId={activeAgentId}
          sessionId={activeSession.id}
          isExecuting={sessionBusy}
          onFork={async (options) => selectSession(await forkSession(activeSession.id, options))}
          onClone={async () => selectSession(await cloneSession(activeSession.id))}
          onShell={executeSessionShell}
        />
      )}
      <ToolApprovalDialog
        request={
          pendingPermission
            ? {
                id: pendingPermission.requestId || pendingPermission.id,
                toolName: pendingPermission.title || pendingPermission.toolInfo.name,
                toolDescription:
                  pendingPermission.reason || pendingPermission.toolInfo.description || "",
                args: approvalInput(pendingPermission),
                riskLevel:
                  pendingPermission.riskLevel === "critical"
                    ? "high"
                    : pendingPermission.riskLevel || "medium",
                acpOptions: pendingPermission.options,
              }
            : null
        }
        open={Boolean(pendingPermission)}
        onOpenChange={(open) => {
          if (!open && pendingPermission)
            void respondToPermission({
              requestId: pendingPermission.requestId || pendingPermission.id,
              granted: false,
            })
        }}
        onApprove={() => {
          if (pendingPermission)
            void respondToPermission({
              requestId: pendingPermission.requestId || pendingPermission.id,
              granted: true,
            })
        }}
        onDeny={() => {
          if (pendingPermission)
            void respondToPermission({
              requestId: pendingPermission.requestId || pendingPermission.id,
              granted: false,
            })
        }}
        onSelectOption={(requestId, optionId) => {
          const option = pendingPermission?.options?.find((item) => item.optionId === optionId)
          void respondToPermission({
            requestId,
            optionId,
            granted: Boolean(option?.kind.startsWith("allow")),
          })
        }}
      />
      <ExternalAgentElicitationDialog
        request={pendingElicitation ?? null}
        onRespond={(response) => {
          void respondToElicitation(response)
        }}
      />
      {hasPlan && (
        <ExternalAgentPlan
          entries={planEntries}
          currentStep={planStep ?? undefined}
          document={planDocument}
          compact
        />
      )}
      <Dialog open={focusOpen} onOpenChange={setFocusOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("compactFocusTitle")}</DialogTitle>
            <DialogDescription>{t("compactFocusDescription")}</DialogDescription>
          </DialogHeader>
          <Textarea
            value={focus}
            onChange={(event) => setFocus(event.target.value)}
            placeholder={t("compactFocusPlaceholder")}
            aria-label={t("compactFocusInputAria")}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setFocusOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              onClick={() => void handleFocusedCompact()}
              disabled={!focus.trim() || sessionBusy}
            >
              {t("compactAria")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={providerUndoWarningOpen} onOpenChange={setProviderUndoWarningOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("providerUndoWarningTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("providerUndoWarningDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                acknowledgeProviderUndoWarning()
                void executeProviderUndo()
              }}
            >
              {t("providerUndoConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default ExternalAgentSessionPanel
