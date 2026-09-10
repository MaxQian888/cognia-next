/**
 * What a room member is doing right now, as one short string (ADR-0177,
 * batch 2, the Slack-style status string).
 *
 * `MemberStatus` says only that a member is thinking. Its tool parts say
 * more: `Read · runner.ts`, `Bash · pnpm test`, `Search · roster`. The
 * string is derived from the member's own slice of the transcript, the same
 * parts the tool rows render, so it needs no extra event and it clears by
 * itself when the tool's result lands (the part's state leaves the running
 * set). A safety timeout in the runner covers a tool whose result never
 * arrives.
 *
 * Pure: no store, no React.
 */

import { resolveToolDisplayTitle, type ToolPartLike } from "@/lib/chat/tool-summary"

/** The tool-part states that mean "still running". */
const RUNNING_STATES = new Set(["input-streaming", "input-available", "approval-requested"])

interface MessageLike {
  role?: string
  parts?: readonly unknown[]
}

function isRunningToolPart(part: unknown): part is ToolPartLike {
  if (!part || typeof part !== "object") return false
  const { type, state } = part as { type?: unknown; state?: unknown }
  if (typeof type !== "string") return false
  if (type !== "dynamic-tool" && !type.startsWith("tool-")) return false
  return typeof state === "string" && RUNNING_STATES.has(state)
}

/**
 * The display title of the newest tool still running in `messages`, or
 * `null` when nothing is. Reads assistant turns only, newest part first, so
 * a member that chains tools reports the one it is on.
 */
export function deriveMemberActivity(messages: readonly MessageLike[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || message.role !== "assistant") continue
    const parts = message.parts ?? []
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]
      if (isRunningToolPart(part)) return resolveToolDisplayTitle(part)
    }
  }
  return null
}
