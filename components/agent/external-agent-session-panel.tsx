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

interface Props {
  className?: string
}

export function ExternalAgentSessionPanel({ className }: Props) {
  const runtime = useAgentRuntimeStore((s) => s.runtime)
  const {
    isExecuting,
    availableCommands,
    planEntries,
    planStep,
    configOptions,
    setConfigOption,
    execute,
  } = useExternalAgent()

  if (runtime !== "external") return null

  const hasCommands = availableCommands.length > 0
  const hasPlan = planEntries.length > 0
  const hasConfigOptions = configOptions.length > 0

  if (!hasCommands && !hasPlan && !hasConfigOptions) return null

  return (
    <div
      className={[
        "flex shrink-0 flex-col gap-2 border-b bg-background/60 px-3 py-2",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {(hasCommands || hasConfigOptions) && (
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
        </div>
      )}
      {hasPlan && (
        <ExternalAgentPlan entries={planEntries} currentStep={planStep ?? undefined} compact />
      )}
    </div>
  )
}

export default ExternalAgentSessionPanel
