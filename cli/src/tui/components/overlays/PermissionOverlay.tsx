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
import { contentRows } from "../../layout/terminal-layout"

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

/**
 * The line under the title: what this call actually does.
 *
 * Ordered by how concrete it is. The agent's own summary of the arguments wins,
 * then its description of the tool, then the path it named. The last branch is
 * the one that matters most: an approval with nothing to show has to SAY it has
 * nothing to show, because a bare "Allow bash?" reads as a UI that lost the
 * command rather than as an agent that never sent one.
 */
export function permissionDetail(req: PermissionRequestEvent, summary: string): string {
  if (summary) return summary
  if (req.description) return req.description
  if (req.blockedPath) return req.blockedPath
  return "The agent sent no details with this request."
}

export function PermissionOverlay({
  req,
  choices,
  index,
  onMove,
  onResolve,
  maxRows = 18,
}: {
  req: PermissionRequestEvent
  choices: PermissionChoice[]
  index: number
  onMove: (delta: number) => void
  onResolve: (decision: CapturePermissionDecision) => void
  maxRows?: number
}) {
  const theme = useTheme()
  const input = (req.input as Record<string, unknown>) ?? {}
  const summary = summarizeToolCall(req.toolName, input)
  const detail = permissionDetail(req, summary)
  const name = prettyToolName(req.displayName ?? req.toolName)
  const risk = riskLevelFor(req.toolName)
  // For an edit/write request, preview the proposed change inline (capped) so the
  // user approves a concrete diff, not just a tool name + path.
  const bareName = prettyToolName(req.toolName)
  const diff = isDiffTool(bareName) ? formatEditDiff(bareName, input) : []
  const diffLang = diff.length > 0 ? langFromPath(diffFilePath(input) ?? "") : undefined
  const showFrame = maxRows >= 9
  const choiceRows = Math.max(
    1,
    Math.min(choices.length, contentRows(maxRows, (showFrame ? 2 : 0) + 4))
  )
  // The detail line is always rendered now, so it always costs a row.
  const metadataRows = 1 + (req.description && req.description !== detail ? 1 : 0)
  const fixedRows = (showFrame ? 2 : 0) + 4 + metadataRows + choiceRows + (diff.length > 0 ? 1 : 0)
  const diffRows = Math.min(12, contentRows(maxRows, fixedRows))
  return (
    <Box
      flexDirection="column"
      borderStyle={showFrame ? "round" : undefined}
      borderColor={theme.borderWarning}
      paddingX={1}
    >
      <Text bold color={theme.warning}>
        Allow {name}?
        {risk ? (
          <Text color={theme[RISK_TOKEN[risk]]} dimColor>
            {" "}
            [{risk} risk]
          </Text>
        ) : null}
      </Text>
      {/* What is being approved comes BEFORE the answers. The choice list used
          to render first, which put the command, the description and (worst)
          the proposed diff underneath the buttons: Enter landed on "allow"
          without the change ever having been on screen above it. */}
      <Text color={theme.muted} wrap="truncate-end">
        {detail}
      </Text>
      {/* The tool's own description, only when it is not already the detail
          line — an agent that sends both says two different things. */}
      {req.description && req.description !== detail ? (
        <Text color={theme.muted} wrap="truncate-end">
          {req.description}
        </Text>
      ) : null}
      {diff.length > 0 && diffRows > 0 ? (
        <Box marginBottom={1} flexDirection="column">
          <DiffView diff={diff} lang={diffLang} maxLines={diffRows} />
        </Box>
      ) : null}
      <SelectList
        items={choices.map((c) => ({ label: c.label }))}
        index={index}
        maxRows={choiceRows}
        onMove={onMove}
        onSelect={(i) => onResolve(choiceToDecision(choices[i], req.toolName))}
        onCancel={() => onResolve(choiceToDecision({ label: "Deny", value: "deny" }, req.toolName))}
        // The shared hint says "Esc cancel", which is not what Esc does here:
        // it denies this call AND stops the turn. Saying so is the difference
        // between a key that looks like "go back" and one that ends the run.
        footerHint="↑/↓ choose · Enter confirm · Esc deny and stop the turn"
      />
    </Box>
  )
}

export const DEFAULT_PERMISSION_CHOICES: PermissionChoice[] = [
  { label: "Allow once", value: "allow" },
  { label: "Allow always", value: "allow_always" },
  { label: "Deny", value: "deny" },
]
