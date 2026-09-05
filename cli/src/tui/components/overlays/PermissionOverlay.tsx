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
import { classifyToolCommand } from "../../../agent/command-approval"
import type { CommandVerdict } from "@/lib/claude/permissions/command-safety"
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

const RISK_BY_NAME: Map<string, BuiltinToolRiskLevel> = new Map(
  listBuiltinTools().map((t) => [t.name, t.riskLevel])
)

const RISK_TOKEN = {
  low: "riskLow",
  medium: "riskMedium",
  high: "riskHigh",
} as const satisfies Record<BuiltinToolRiskLevel, string>

/** Verdict of the command classifier, as a risk level. */
const RISK_BY_VERDICT = {
  allow: "low",
  ask: "medium",
  deny: "high",
} as const satisfies Record<CommandVerdict, BuiltinToolRiskLevel>

/**
 * The risk level to badge this request with.
 *
 * A shell call is rated by its command, not by the fact that it is a shell
 * call. `bash` sits in the catalogue at `high` because `bash` can do anything,
 * which is true and useless: it put the same red badge on `ls` and on
 * `rm -rf /`, and a badge that never varies is one the reader stops seeing.
 * Everything else keeps the catalogue's level, and a tool outside the
 * catalogue (a custom MCP server) still has none.
 */
export function riskLevelFor(toolName: string, input?: unknown): BuiltinToolRiskLevel | undefined {
  const classification = input === undefined ? null : classifyToolCommand(toolName, input)
  if (classification) return RISK_BY_VERDICT[classification.verdict]
  return RISK_BY_NAME.get(prettyToolName(toolName))
}

/**
 * Where the selection starts.
 *
 * On Deny for a command the classifier calls catastrophic, so the dangerous
 * answer is never one blind Enter away. Everything else opens on "Allow once",
 * which is the answer the user wants almost every time they are asked.
 */
export function initialChoiceIndex(
  toolName: string,
  input: unknown,
  choices: readonly PermissionChoice[]
): number {
  if (classifyToolCommand(toolName, input)?.verdict !== "deny") return 0
  const deny = choices.findIndex((c) => c.value === "deny")
  return deny >= 0 ? deny : 0
}

/**
 * The one line that says why this is being asked, when the answer is not
 * already obvious from the command itself. Only the classifier can produce it,
 * so a non-shell tool has none.
 */
export function permissionReason(toolName: string, input: unknown): string | undefined {
  const classification = classifyToolCommand(toolName, input)
  if (!classification || classification.verdict === "allow") return undefined
  return classification.reason
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
  const risk = riskLevelFor(req.toolName, input)
  const reason = permissionReason(req.toolName, input)
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
  const metadataRows =
    1 + (req.description && req.description !== detail ? 1 : 0) + (reason ? 1 : 0)
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
      {/* Why this one is being asked about. Without it the prompt states a fact
          the user can already read (the command) and withholds the only thing
          it knows that they do not: which part of it is the risky part. */}
      {reason ? (
        <Text color={risk ? theme[RISK_TOKEN[risk]] : theme.muted} wrap="truncate-end">
          {reason}
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
