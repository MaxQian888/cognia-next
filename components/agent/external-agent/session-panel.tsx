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

import { useRuntimeRefForSession } from "@/stores/agent/agent-runtime-store"
import { useExternalAgent } from "@/hooks/agent/use-external-agent"
import { ExternalAgentCommands } from "./commands"
import { ExternalAgentConfigOptions } from "./config-options"
import { ExternalAgentPlan } from "./plan"
import {
  PluginExtensionSlot,
  usePluginSlotHasExtensions,
} from "@/components/plugins/plugin-extension-slot"
import { useState } from "react"
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
import { isExternalAgentSessionExtensionUnsupportedForMethod } from "@/lib/ai/agent/external/session-extension-errors"
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
}

export function ExternalAgentSessionPanel({ className, sessionId }: Props) {
  const [focusOpen, setFocusOpen] = useState(false)
  const [focus, setFocus] = useState("")
  const [providerUndoWarningOpen, setProviderUndoWarningOpen] = useState(false)
  const runtime = useRuntimeRefForSession(sessionId).kind === "builtin" ? "claude-sdk" : "external"
  const t = useTranslations("chat.header")
  const {
    isExecuting,
    activeSession,
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
  } = useExternalAgent()

  const hasPluginToolbar = usePluginSlotHasExtensions("agent.external-session.toolbar")

  if (runtime !== "external") return null

  const hasCommands = availableCommands.length > 0
  const hasPlan = planEntries.length > 0 || Boolean(planDocument)
  const hasConfigOptions = configOptions.length > 0
  const canFork = Boolean(activeSession)
  const sessionBusy = isExecuting || isCompacting || isProviderUndoing
  const supportsProviderUndo = providerUndoCapability?.status === "supported"

  // Render when there is native session data OR a plugin contributes a toolbar
  // control — otherwise the panel chrome would show empty.
  if (!hasCommands && !hasPlan && !hasConfigOptions && !canFork && !hasPluginToolbar) return null

  const handleFork = async () => {
    if (!activeSession) return
    try {
      await forkSession(activeSession.id)
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
                void execute(prompt)
              }}
              isExecuting={sessionBusy}
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
