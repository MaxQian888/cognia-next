/**
 * Inline tool-approval prompt. Shows the requested tool + a one-line summary and
 * an allow / allow-always / deny select list. The chosen value becomes a
 * `CapturePermissionDecision` handed back to the paused capture via `onResolve`.
 */
import React from "react"
import { Box, Text } from "ink"

import { SelectList } from "../SelectList"
import { summarizeToolCall } from "../../format/tools"
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
  const summary = summarizeToolCall(req.toolName, (req.input as Record<string, unknown>) ?? {})
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        Allow {req.displayName ?? req.toolName}?
      </Text>
      {summary ? <Text color="gray">{summary}</Text> : null}
      {req.description ? <Text color="gray">{req.description}</Text> : null}
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
