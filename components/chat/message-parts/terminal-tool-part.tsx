"use client"

/**
 * TerminalToolPart — wraps the generic Tool block but swaps the body of a
 * Bash tool call for a `ai-elements/terminal.tsx` view while the call is in
 * the `input-available` (running) state. Once the result lands, the part
 * falls back to the regular ToolBody so the user sees the structured
 * stdout / errorText section.
 */

import type { ToolUIPart } from "ai"
import { useTranslations } from "next-intl"
import { Tool, ToolBody, ToolContent, ToolHeader, ToolInput } from "@/components/ai-elements/tool"
import { Terminal, TerminalHeader, TerminalStatus } from "@/components/ai-elements/terminal"

interface TerminalToolPartProps {
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

export function TerminalToolPart({ part }: TerminalToolPartProps) {
  const t = useTranslations("chat.terminalTool")
  const running = part.state === "input-available"
  const command = extractCommand(part.input)
  const liveOutput = extractRunningOutput(part.output)

  return (
    <Tool defaultOpen={running} data-testid="terminal-tool-part">
      <ToolHeader type={part.type} state={part.state} />
      <ToolContent>
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
      </ToolContent>
    </Tool>
  )
}

export default TerminalToolPart
