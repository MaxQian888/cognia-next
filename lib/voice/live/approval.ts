/**
 * Tool approval for realtime voice sessions.
 *
 * Voice cannot reuse the chat approval path wholesale, for two reasons that
 * both bite silently:
 *
 * 1. **"Always allow" would never take effect.** `respondToApproval` derives a
 *    target-scoped rule via `deriveAllowRuleFromApproval`, which returns `null`
 *    for any tool without `command` / `file_path` / `path` — i.e. for most
 *    plugin tools. It then falls back to `toggleAlwaysAllow(name)`, and that
 *    list is consumed by the **sidecar**, which the realtime path never talks
 *    to. So the grant would be recorded and then ignored, forever. This module
 *    resolves permissions itself and writes a rule the realtime path reads back.
 *
 * 2. **The baked-in default is the wrong default here.** `DEFAULT_RULESET` is
 *    `{"*": "allow"}` because the sidecar has its own coarse allow/deny layer
 *    on top. Voice has neither that layer nor a visible tool stream — the user
 *    is talking, not watching. Inheriting "allow" would run plugin tools with
 *    no trace the user could notice. So only an **explicit** rule (layer > 0)
 *    can auto-allow; an unconfigured tool asks.
 *
 * Everything else is deliberately shared with the desktop skill consent path
 * (`lib/skills/built-in/desktop-hitl.ts`): the same chat approval card, the
 * same TTL registry, the same "prefixed requestIds are resolved in-renderer and
 * never forwarded to `approveTool`" contract.
 */

import {
  awaitApproval,
  DEFAULT_APPROVAL_TTL_MS,
  grantSessionBypass,
  hasSessionBypass,
  resolveApproval,
} from "@/lib/connectors/hitl/approval-registry"
import { resolvePermissionDetailed, type Ruleset } from "@/lib/claude/permissions/ruleset"
import { setToolRule } from "@/lib/claude/permissions/ruleset-edit"

/**
 * Marks a requestId as belonging to a realtime voice session. `respondToApproval`
 * branches on this and resolves locally — there is no sidecar-side waiter, so
 * forwarding one of these to `approveTool` would hang the dialog.
 */
export const REALTIME_TOOL_APPROVAL_PREFIX = "realtime-tool:"

export function isRealtimeToolApprovalRequestId(requestId: string): boolean {
  return requestId.startsWith(REALTIME_TOOL_APPROVAL_PREFIX)
}

/** The permission inputs, read straight off `AppSettings.agentPermissions`. */
export interface RealtimeToolPolicy {
  toolRules?: Ruleset
  alwaysAllowTools?: readonly string[]
}

export type RealtimeToolVerdict = "allow" | "ask" | "deny"

/**
 * Resolve what should happen to a tool call before any UI is shown.
 *
 * Unlike the sidecar resolver, a permissive verdict that came only from the
 * baked-in defaults is escalated to `ask`. See the module header.
 */
export function resolveRealtimeToolVerdict(
  toolName: string,
  policy: RealtimeToolPolicy
): RealtimeToolVerdict {
  // Grants made through the chat dialog land here; honouring them is what
  // keeps voice consistent with what the user already approved elsewhere.
  if (policy.alwaysAllowTools?.includes(toolName)) return "allow"

  const { verdict, layer } = resolvePermissionDetailed(
    toolName,
    undefined,
    policy.toolRules ? [policy.toolRules] : []
  )

  if (verdict === "deny") return "deny"
  if (verdict === "allow" && layer > 0) return "allow"
  return "ask"
}

/**
 * Whether this call would actually put a dialog in front of the user.
 *
 * The tool runtime uses this to decide whether to suspend audio at all: muting
 * the microphone around a tool that auto-allows would cut the user off for no
 * visible reason.
 */
export function realtimeToolWillPrompt(
  sessionId: string,
  toolName: string,
  policy: RealtimeToolPolicy
): boolean {
  if (resolveRealtimeToolVerdict(toolName, policy) !== "ask") return false
  return !hasSessionBypass(sessionId, toolName)
}

export interface RealtimeToolApprovalRequest {
  sessionId: string
  /** The provider's `callId`, so the card maps to one function call. */
  callId: string
  toolName: string
  args: Record<string, unknown>
  policy: RealtimeToolPolicy
  /** Defaults to the registry's 10-minute auto-deny. */
  ttlMs?: number
}

/** Cancel a pending card immediately when its voice session is no longer valid. */
export function cancelRealtimeToolApproval(sessionId: string, callId: string): void {
  const requestId = `${REALTIME_TOOL_APPROVAL_PREFIX}${callId}`
  resolveApproval(sessionId, requestId, {
    decision: "deny",
    message: "voice session ended",
  })
  void import("@/stores/chat/chat-store").then(({ useChatStore }) => {
    try {
      useChatStore.getState().clearApproval(requestId, sessionId)
    } catch {
      // The chat session may already have been removed.
    }
  })
}

export type RealtimeApprovalReason =
  "rule" | "always-allowed" | "session-bypass" | "user" | "expired" | "denied-by-rule"

export interface RealtimeToolApprovalOutcome {
  approved: boolean
  reason: RealtimeApprovalReason
}

/**
 * Decide whether a realtime tool call may run, asking the user when the policy
 * does not already settle it. Resolves on the button press or the TTL auto-deny.
 */
export async function requestRealtimeToolApproval(
  request: RealtimeToolApprovalRequest
): Promise<RealtimeToolApprovalOutcome> {
  const verdict = resolveRealtimeToolVerdict(request.toolName, request.policy)
  if (verdict === "deny") return { approved: false, reason: "denied-by-rule" }
  if (verdict === "allow") {
    return {
      approved: true,
      reason: request.policy.alwaysAllowTools?.includes(request.toolName)
        ? "always-allowed"
        : "rule",
    }
  }

  // "Allow for this session", chosen on an earlier call in the same session.
  if (hasSessionBypass(request.sessionId, request.toolName)) {
    return { approved: true, reason: "session-bypass" }
  }

  const requestId = `${REALTIME_TOOL_APPROVAL_PREFIX}${request.callId}`

  // Lazy store import so node-env callers and pure resolution paths never pay
  // for zustand (precedent: desktop-hitl.ts).
  const { useChatStore } = await import("@/stores/chat/chat-store")
  useChatStore.getState().pushApproval({
    sessionId: request.sessionId,
    requestId,
    toolUseID: requestId,
    toolName: request.toolName,
    input: request.args,
    displayName: request.toolName,
    description: `Voice session requests permission to run ${request.toolName}.`,
  })

  const decision = await awaitApproval(request.sessionId, requestId, {
    ttlMs: request.ttlMs ?? DEFAULT_APPROVAL_TTL_MS,
  })

  // Drop the card whatever happened — a timeout would otherwise leave a
  // clickable dialog wired to a promise nobody is holding.
  try {
    useChatStore.getState().clearApproval(requestId, request.sessionId)
  } catch {
    // Session closed mid-flight; there is no card left to clear.
  }

  if (decision.decision === "allow") return { approved: true, reason: "user" }
  return {
    approved: false,
    reason: decision.message === "approval timed out" ? "expired" : "user",
  }
}

/**
 * Persist an "always allow" chosen from a voice approval card.
 *
 * Writes an explicit `toolRules` entry rather than appending to
 * `alwaysAllowTools`: the rule is read by both the sidecar resolver and
 * {@link resolveRealtimeToolVerdict}, whereas the bare list is only honoured by
 * the sidecar and would leave the voice path still asking every time. The
 * session bypass is granted too so the *current* session stops asking
 * immediately, without waiting on the settings round-trip.
 */
export function grantRealtimeToolAlwaysAllow(
  sessionId: string,
  toolName: string,
  currentRules: Ruleset | undefined
): Ruleset {
  grantSessionBypass(sessionId, toolName)
  // `*` because realtime tool calls carry no path/command target to scope to.
  return setToolRule(currentRules, toolName, "*", "allow")
}
