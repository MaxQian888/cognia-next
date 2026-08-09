"use client"

/**
 * TerminalToolPart — wraps the generic Tool block but swaps the body of a
 * Bash tool call for a `ai-elements/terminal.tsx` view while the call is in
 * the `input-available` (running) state. Once the result lands, the part
 * falls back to the regular ToolBody so the user sees the structured
 * stdout / errorText section.
 *
 * Wave 3D: adds a "Run in dock" affordance that lets the user send the
 * same command into a selected dock tab. The tab picker is anchored
 * inside this part so the action lives next to the command preview.
 *
 * The body is exported separately as {@link TerminalToolBody} so the simplified
 * display mode's `ToolCallRow` can expand into the *same* terminal view instead
 * of a stringified fallback — the card chrome is the only thing that differs
 * between the two modes.
 */

import { memo, useCallback, useMemo, useState } from "react"
import type { ToolUIPart } from "ai"
import { useTranslations } from "next-intl"
import { TerminalSquareIcon } from "lucide-react"

import { Tool, ToolBody, ToolContent, ToolHeader, ToolInput } from "@/components/ai-elements/tool"
import { Terminal, TerminalHeader, TerminalStatus } from "@/components/ai-elements/terminal"
import { Button } from "@/components/ui/button"
import {
  TerminalTabPicker,
  type TerminalTabPickerProps,
} from "@/components/chat/terminal-tab-picker"
import { runInDockTab } from "@/lib/terminal/run-in-dock"
import { resolveDefaultShell } from "@/lib/terminal/shell-detect"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"
import { useChatStore } from "@/stores/chat/chat-store"
import { resolveToolDisplayTitle } from "@/lib/chat/tool-summary"

interface TerminalToolPartProps {
  part: ToolUIPart
  /**
   * Overrides the "open while running" default. Set by the activity group's
   * expand-all / collapse-all and by `detailed` mode, which force every card in
   * a run open regardless of its state.
   */
  defaultOpen?: boolean
}

interface TerminalToolBodyProps {
  part: ToolUIPart
}

function extractCommand(input: unknown): string | undefined {
  if (input && typeof input === "object" && "command" in input) {
    const cmd = (input as { command?: unknown }).command
    if (typeof cmd === "string") return cmd
  }
  return undefined
}

function extractRunningOutput(output: unknown): string | undefined {
  if (typeof output === "string") return output
  if (output && typeof output === "object") {
    const obj = output as { stdout?: unknown; stderr?: unknown }
    const parts: string[] = []
    if (typeof obj.stdout === "string") parts.push(obj.stdout)
    if (typeof obj.stderr === "string") parts.push(obj.stderr)
    if (parts.length > 0) return parts.join("\n")
  }
  return undefined
}

export const TerminalToolBody = memo(function TerminalToolBody({ part }: TerminalToolBodyProps) {
  const t = useTranslations("chat.terminalTool")
  const running = part.state === "input-available"
  const command = useMemo(() => extractCommand(part.input), [part.input])
  const liveOutput = useMemo(() => extractRunningOutput(part.output), [part.output])
  const chatSessionId = useChatStore((s) =>
    typeof (s as { activeSessionId?: string }).activeSessionId === "string"
      ? (s as { activeSessionId: string }).activeSessionId
      : ""
  )
  const project = useProjectStore((s) =>
    s.activeProjectId ? (s.projects.find((p) => p.id === s.activeProjectId) ?? null) : null
  )
  const settingsShell = useSettingsStore(
    (s) => (s.settings?.terminal as { defaultShell?: string } | undefined)?.defaultShell
  )

  const [busy, setBusy] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)

  const canRun = !!command && command.length > 0 && !!chatSessionId

  // Stable handler so the picker isn't handed a fresh async closure on every
  // streaming re-render while the Bash call is in flight.
  const handlePick = useCallback(
    async (choice: Parameters<TerminalTabPickerProps["onPick"]>[0]) => {
      if (!command || !chatSessionId) return
      setBusy(true)
      try {
        if (choice.kind === "existing") {
          await runInDockTab({
            chatSessionId,
            tabId: choice.row.id,
            command,
          })
        } else {
          await runInDockTab({
            chatSessionId,
            newTab: {
              req: {
                shell: resolveDefaultShell({
                  projectShell: project?.terminalConfig?.shell,
                  settingShell: settingsShell,
                }),
                cwd: project?.terminalConfig?.cwd?.trim() || project?.rootDir?.trim() || undefined,
                env: project?.terminalConfig?.env,
                projectId: project?.id,
                rows: 24,
                cols: 80,
              },
            },
            command,
          })
        }
      } finally {
        setBusy(false)
      }
    },
    [command, chatSessionId, project, settingsShell]
  )

  return (
    <>
      {running ? (
        <div className="space-y-2" data-testid="terminal-tool-running">
          {command && <ToolInput input={{ command }} />}
          <div className="h-40 w-full">
            <Terminal isStreaming output={liveOutput ?? ""}>
              <TerminalHeader>
                <span>{t("bashLabel")}</span>
                <TerminalStatus status="running">{t("runningStatus")}</TerminalStatus>
              </TerminalHeader>
            </Terminal>
          </div>
        </div>
      ) : (
        <ToolBody part={part} />
      )}
      {canRun ? (
        <div className="mt-2 flex justify-end">
          <TerminalTabPicker open={pickerOpen} onOpenChange={setPickerOpen} onPick={handlePick}>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 text-xs"
              disabled={busy}
              data-testid="terminal-tool-part-run-in-dock"
            >
              <TerminalSquareIcon className="h-3 w-3" />
              {t("runInDock.label")}
            </Button>
          </TerminalTabPicker>
        </div>
      ) : null}
    </>
  )
})

export const TerminalToolPart = memo(function TerminalToolPart({
  part,
  defaultOpen,
}: TerminalToolPartProps) {
  const readOnlyHint = (
    part as ToolUIPart & {
      toolMetadata?: { readOnlyHint?: boolean | null }
    }
  ).toolMetadata?.readOnlyHint
  const presentation = part as ToolUIPart & { toolName?: unknown }
  const isDynamicTool = (part as { type: string }).type === "dynamic-tool"
  const dynamicToolName =
    typeof presentation.toolName === "string" && presentation.toolName.trim()
      ? presentation.toolName
      : "tool"
  const displayTitle = resolveToolDisplayTitle(part)

  return (
    <Tool
      defaultOpen={defaultOpen ?? part.state === "input-available"}
      data-testid="terminal-tool-part"
    >
      {isDynamicTool ? (
        <ToolHeader
          type="dynamic-tool"
          toolName={dynamicToolName}
          state={part.state}
          title={displayTitle}
          readOnlyHint={readOnlyHint}
        />
      ) : (
        <ToolHeader
          type={part.type}
          state={part.state}
          title={displayTitle}
          readOnlyHint={readOnlyHint}
        />
      )}
      <ToolContent>
        <TerminalToolBody part={part} />
      </ToolContent>
    </Tool>
  )
})

export default TerminalToolPart
