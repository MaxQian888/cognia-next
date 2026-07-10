/**
 * Desktop consent surface for built-in skill writes (W2 dual-channel HITL).
 *
 * IM sessions get the A2UI confirm card + `skill_invoke` callback binding;
 * desktop chat previously had NOTHING (the dispatcher skipped HITL for
 * non-IM contexts). This module fills that hole by reusing the chat pane's
 * existing tool-approval dialog:
 *
 *   - push a synthetic `PendingApproval` (requestId prefixed
 *     `builtin-skill:`) into `useChatStore` — `ToolApprovalDialog` renders
 *     any unknown tool with its generic JSON preview, no UI changes needed;
 *   - suspend on the IM-agnostic `approval-registry` (`awaitApproval`,
 *     10-minute TTL auto-deny) — the sidecar is already awaiting the
 *     `plugin_tool_exec` response, so blocking here suspends the turn
 *     naturally;
 *   - `use-claude-chat.respondToApproval` resolves prefixed requestIds
 *     locally via `resolveApproval` and NEVER forwards them to the sidecar's
 *     `approveTool` (there is no sidecar-side permission waiting).
 */

import type { BuiltInSkill } from "./types"
import {
  awaitApproval,
  DEFAULT_APPROVAL_TTL_MS,
  grantSessionBypass,
  hasSessionBypass,
} from "@/lib/connectors/hitl/approval-registry"

export const BUILTIN_SKILL_APPROVAL_PREFIX = "builtin-skill:"

export function isBuiltInSkillApprovalRequestId(requestId: string): boolean {
  return requestId.startsWith(BUILTIN_SKILL_APPROVAL_PREFIX)
}

export interface DesktopSkillApprovalInput {
  sessionId: string
  skill: Pick<BuiltInSkill, "id" | "mcpToolName" | "label" | "mutation">
  args: unknown
}

export interface DesktopSkillApprovalOutcome {
  approved: boolean
  reason: "user" | "expired" | "session_bypass"
}

/**
 * Ask the desktop user to approve a built-in skill write. Resolves on the
 * dialog button press or the TTL auto-deny. "Allow for session" is honored
 * through the registry's session-bypass map keyed by the skill's tool name.
 */
export async function requestDesktopSkillApproval(
  input: DesktopSkillApprovalInput
): Promise<DesktopSkillApprovalOutcome> {
  if (hasSessionBypass(input.sessionId, input.skill.mcpToolName)) {
    return { approved: true, reason: "session_bypass" }
  }

  const requestId = `${BUILTIN_SKILL_APPROVAL_PREFIX}${input.skill.id}:${crypto.randomUUID()}`

  // Lazy store import (precedent: plugin-tool-ipc → ask-user-store) so pure
  // logic paths / node-env tests never pay for the zustand store unless the
  // dialog is actually needed.
  const { useChatStore } = await import("@/stores/chat/chat-store")
  useChatStore.getState().pushApproval({
    sessionId: input.sessionId,
    requestId,
    toolUseID: requestId,
    toolName: input.skill.mcpToolName,
    input: (input.args ?? {}) as Record<string, unknown>,
    displayName: input.skill.label.en,
    description: `Built-in skill ${input.skill.id} (${input.skill.mutation}) requests confirmation.`,
  })

  const decision = await awaitApproval(input.sessionId, requestId, {
    ttlMs: DEFAULT_APPROVAL_TTL_MS,
  })

  // Whatever the outcome, drop the card — expiry would otherwise leave a
  // zombie dialog the user can still click.
  try {
    useChatStore.getState().clearApproval(requestId, input.sessionId)
  } catch {
    // Store teardown mid-flight (session closed) — nothing to clear.
  }

  if (decision.decision === "allow") {
    return { approved: true, reason: "user" }
  }
  return {
    approved: false,
    reason: decision.message === "approval timed out" ? "expired" : "user",
  }
}

/** "Allow for session": remember the grant, then approve. */
export function grantDesktopSkillSessionBypass(sessionId: string, mcpToolName: string): void {
  grantSessionBypass(sessionId, mcpToolName)
}
