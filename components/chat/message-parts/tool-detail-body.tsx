"use client"

/**
 * The *body* of a tool call — everything the user sees once a call is expanded,
 * with no card chrome of its own.
 *
 * This is the single place that decides how a tool's input/output is rendered,
 * shared by both display shapes so they can never drift:
 *  - standard / detailed — `message-renderer` wraps it in `<Tool>` + `<ToolHeader>`
 *  - simplified          — `ToolCallRow` nests it under the collapsed row
 *
 * Before this existed the row re-implemented a *subset* of the card's routing
 * (structured MCP card → generic body), which silently dropped the terminal
 * view, the interactive A2UI surface, the parsed error trace and the workbench
 * review affordance (which needs `sessionId`) for every tool in simplified mode.
 *
 * Routing order — first match wins, mirroring the priority the card path has
 * always used:
 *  1. failed call    → parameters + parsed error trace
 *  2. Bash           → live terminal / structured stdout + "run in dock"
 *  3. dedicated card → built-in or plugin-contributed `MCPToolCard`
 *  4. A2UI payload   → interactive surface
 *  5. anything else  → MCP content blocks, or the stringified `ToolBody`
 */

import { useTranslations } from "next-intl"
import type { ToolUIPart } from "ai"

import { ToolInput } from "@/components/ai-elements/tool"
import { ErrorTraceDetails } from "@/components/ai-elements/error-trace"
import { ErrorParsedView } from "@/components/error/error-parsed-view"
import { normalizeErrorText } from "@cognia/error-parsers"
import { A2UIToolOutput, hasA2UIToolOutput } from "@/components/a2ui/a2ui-tool-output"
import {
  MCPToolCard,
  McpToolBodyOrContent,
  isStructuredMcpToolPart,
  toolNameOf,
} from "@/components/chat/message-parts/mcp-tool-card"
import { TerminalToolBody } from "@/components/chat/message-parts/terminal-tool-part"
import { resolveToolPartName } from "@/lib/chat/tool-summary"

/**
 * True for a Bash call under any of its spellings — the flat `tool-Bash` /
 * `tool-bash` the ai-sdk path emits, the namespaced
 * `tool-mcp__cognia-tools__bash` of the Anthropic escape hatch, and the
 * `dynamic-tool` shape an imported transcript carries.
 */
export function isBashToolPart(part: { type?: string; toolName?: string }): boolean {
  return resolveToolPartName(part)?.toLowerCase() === "bash"
}

export interface ToolDetailBodyProps {
  part: ToolUIPart
  /**
   * Owning chat session. Threaded into the structured cards — `EditCard` /
   * `WriteCard` gate their "review in workbench" action on it, so dropping it
   * makes the button vanish rather than fail loudly.
   */
  sessionId?: string
}

export function ToolDetailBody({ part, sessionId }: ToolDetailBodyProps) {
  const t = useTranslations("chat.message")

  if (part.state === "output-error") {
    const rawError = (part as { errorText?: unknown }).errorText
    return (
      <>
        {part.input !== undefined && part.input !== null && <ToolInput input={part.input} />}
        <ErrorTraceDetails
          error={{ message: normalizeErrorText(rawError, t("toolCallFailed")) }}
          title={t("toolCallFailed")}
          className="mt-2"
          body={
            <ErrorParsedView
              rawError={rawError}
              toolType={part.type}
              fallback={t("toolCallFailed")}
            />
          }
        />
      </>
    )
  }

  if (isBashToolPart(part)) {
    return <TerminalToolBody part={part} />
  }

  if (isStructuredMcpToolPart(part)) {
    return <MCPToolCard part={part} sessionId={sessionId} />
  }

  if (hasA2UIToolOutput(part.output)) {
    // A tool whose result embeds an A2UI payload (surface + components) renders
    // as an interactive surface instead of the generic tool body.
    return (
      <A2UIToolOutput
        toolId={part.toolCallId}
        toolName={toolNameOf(part) ?? part.type}
        output={part.output}
      />
    )
  }

  return <McpToolBodyOrContent part={part} />
}
