/**
 * Inline tool-approval prompt. Shows the requested tool + a one-line summary and
 * an allow / allow-always / deny select list. The chosen value becomes a
 * `CapturePermissionDecision` handed back to the paused capture via `onResolve`.
 */
import React from "react"
import { Box, Text } from "ink"

import { SelectList } from "../SelectList"
import { DiffView } from "../DiffView"
import { useTheme } from "../../theme/context"
import { summarizeToolCall, isDiffTool } from "../../format/tools"
import { diffFilePath, formatEditDiff } from "../../markdown/diff"
import { langFromPath } from "../../markdown/highlight"
import { listBuiltinTools, type BuiltinToolRiskLevel } from "@/lib/settings/builtin-tools"
import type { CapturePermissionDecision } from "@/lib/claude/run-and-capture"
import type { PermissionChoice, PermissionRequestEvent } from "../../state/types"

export function choiceToDecision(
  choice: PermissionChoice,
  toolName: string
): CapturePermissionDecision {
  if (choice.value === "deny") {
    return { decision: "deny", message: `Denied "${toolName}".` }
  }
  return { decision: choice.value }
}

/** Strip the MCP namespace (`mcp__<server>__<tool>` → `<tool>`) for display so
 * the prompt reads "Allow bash?" not "Allow mcp__cognia-tools__bash?". */
export function prettyToolName(name: string): string {
  const parts = name.split("__")
  return parts.length >= 3 && parts[0] === "mcp" ? parts.slice(2).join("__") : name
}

const RISK_BY_BARE_NAME: Map<string, BuiltinToolRiskLevel> = new Map(
  listBuiltinTools().map((t) => [t.name, t.riskLevel])
)

const RISK_TOKEN = {
  low: "riskLow",
  medium: "riskMedium",
  high: "riskHigh",
} as const satisfies Record<BuiltinToolRiskLevel, string>

/** The shared risk model's level for a (possibly namespaced) tool, or undefined
 * for tools outside the built-in catalogue (custom MCP servers). */
export function riskLevelFor(toolName: string): BuiltinToolRiskLevel | undefined {
  return RISK_BY_BARE_NAME.get(prettyToolName(toolName))
}

export function PermissionOverlay({
  req,
  choices,
  index,
  onMove,
  onResolve,
}: {
  req: PermissionRequestEvent
  choices: PermissionChoice[]
  index: number
  onMove: (delta: number) => void
  onResolve: (decision: CapturePermissionDecision) => void
}) {
  const theme = useTheme()
  const input = (req.input as Record<string, unknown>) ?? {}
  const summary = summarizeToolCall(req.toolName, input)
  const name = prettyToolName(req.displayName ?? req.toolName)
  const risk = riskLevelFor(req.toolName)
  // For an edit/write request, preview the proposed change inline (capped) so the
  // user approves a concrete diff, not just a tool name + path.
  const bareName = prettyToolName(req.toolName)
  const diff = isDiffTool(bareName) ? formatEditDiff(bareName, input) : []
  const diffLang = diff.length > 0 ? langFromPath(diffFilePath(input) ?? "") : undefined
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.borderWarning} paddingX={1}>
      <Text bold color={theme.warning}>
        Allow {name}?
        {risk ? (
          <Text color={theme[RISK_TOKEN[risk]]} dimColor>
            {" "}
            [{risk} risk]
          </Text>
        ) : null}
      </Text>
      {summary ? <Text color={theme.muted}>{summary}</Text> : null}
      {req.description ? <Text color={theme.muted}>{req.description}</Text> : null}
      {diff.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <DiffView diff={diff} lang={diffLang} maxLines={12} />
        </Box>
      ) : null}
      <SelectList
        items={choices.map((c) => ({ label: c.label }))}
        index={index}
        onMove={onMove}
        onSelect={(i) => onResolve(choiceToDecision(choices[i], req.toolName))}
        onCancel={() => onResolve(choiceToDecision({ label: "Deny", value: "deny" }, req.toolName))}
      />
    </Box>
  )
}

export const DEFAULT_PERMISSION_CHOICES: PermissionChoice[] = [
  { label: "Allow once", value: "allow" },
  { label: "Allow always", value: "allow_always" },
  { label: "Deny", value: "deny" },
]
