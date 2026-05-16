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

import { useAgentRuntimeStore } from "@/stores/agent"
import { useExternalAgent } from "@/hooks/agent/use-external-agent"
import { ExternalAgentCommands } from "./external-agent-commands"
import { ExternalAgentConfigOptions } from "./external-agent-config-options"
import { ExternalAgentPlan } from "./external-agent-plan"
import { Button } from "@/components/ui/button"
import { GitBranchIcon } from "lucide-react"
import { isExternalAgentSessionExtensionUnsupportedForMethod } from "@/lib/ai/agent/external/session-extension-errors"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"

interface Props {
  className?: string
}

export function ExternalAgentSessionPanel({ className }: Props) {
  const runtime = useAgentRuntimeStore((s) => s.runtime)
  const t = useTranslations("chat.header")
  const {
    isExecuting,
    activeSession,
    availableCommands,
    planEntries,
    planStep,
    configOptions,
    setConfigOption,
    execute,
    forkSession,
  } = useExternalAgent()

  if (runtime !== "external") return null

  const hasCommands = availableCommands.length > 0
  const hasPlan = planEntries.length > 0
  const hasConfigOptions = configOptions.length > 0
  const canFork = Boolean(activeSession)

  if (!hasCommands && !hasPlan && !hasConfigOptions && !canFork) return null

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

  return (
    <div
      className={cn("flex shrink-0 flex-col gap-2 border-b bg-background/60 px-3 py-2", className)}
    >
      {(hasCommands || hasConfigOptions || canFork) && (
        <div className="flex flex-wrap items-center gap-2">
          {hasCommands && (
            <ExternalAgentCommands
              commands={availableCommands}
              onExecute={(command, args) => {
                const prompt = args ? `${command} ${args}` : command
                void execute(prompt)
              }}
              isExecuting={isExecuting}
            />
          )}
          {hasConfigOptions && (
            <ExternalAgentConfigOptions
              configOptions={configOptions}
              onSetConfigOption={setConfigOption}
              disabled={isExecuting}
              compact
            />
          )}
          {canFork && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={() => void handleFork()}
              disabled={isExecuting}
              aria-label={t("forkAria")}
              title={t("forkTooltip")}
            >
              <GitBranchIcon className="size-3.5" />
              {t("forkAria")}
            </Button>
          )}
        </div>
      )}
      {hasPlan && (
        <ExternalAgentPlan entries={planEntries} currentStep={planStep ?? undefined} compact />
      )}
    </div>
  )
}

export default ExternalAgentSessionPanel
