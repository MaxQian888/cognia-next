/**
 * Outbound tool calls a person or a policy allowed, for the deliveries they
 * cause (ADR-0239).
 *
 * An outbound tool such as `im_broadcast` is reviewed at the tool-call
 * chokepoint (`plan-tool-call.ts`), but what it sends goes through the
 * connector delivery chokepoint (`plan-delivery.ts`) afterwards. That second
 * check must not ask again for a recipient the first one already authorized,
 * and must not trust the tool's own word that it was authorized. So the host
 * records the authorization here, in its own memory, before the allow reaches
 * the sidecar:
 *
 * 1. Planning a call that names a `toolUseID` remembers its recipients
 *    ({@link rememberPlannedOutboundToolCall}).
 * 2. Every place that answers the call with an allow promotes it, before
 *    dispatching the answer ({@link authorizeOutboundToolCall}): `approveTool`,
 *    the modal's `recordChatToolApprovalDecision`, and the policy's own
 *    allows in `answerWithOutboundPolicy` and `planOutboundAsk`. A deny drops
 *    it ({@link forgetPlannedOutboundToolCall}).
 * 3. The tool's delivery names its call (`sessionId`, `toolUseId`), and the
 *    gateway looks the call up ({@link authorizedOutboundToolCall}). Plugin
 *    code cannot name a call: `plugin-tool-ipc` marks which plugin a running
 *    call belongs to ({@link beginOutboundToolExecution}), and a plugin's
 *    delivery is matched against its own running calls
 *    ({@link runningAuthorizedToolCallsOf}).
 *
 * Memory only, bounded and expiring: an authorization covers the call it
 * answered, which runs within one turn of one process. After a restart the
 * call is no longer running, and a delivery that still claims it is planned
 * like any other.
 *
 * Leaf module: type imports only, so `lib/claude/ipc.ts`, the chat-tool
 * channel and the gateway can all import it statically.
 */

import type {
  ActionReviewAuthority,
  ActionReviewGrant,
} from "@cognia/agent-config-types/action-review"

/** How long an authorization outlives its answer when the call never reports done. */
export const AUTHORIZED_TOOL_CALL_TTL_MS = 30 * 60_000

/** More calls than one host has in flight at once; the oldest go first. */
export const MAX_TRACKED_TOOL_CALLS = 512

/** A planned outbound tool call, before anyone answered it. */
export interface PlannedOutboundToolCall {
  sessionId: string
  /** The permission request; also the id of the call's chat-tool receipt. */
  requestId: string
  toolUseId: string
  /** The tool's registered name (`normalizeToolId`). */
  toolName: string
  /** `outboundFingerprint` of every planned target. */
  fingerprints: readonly string[]
}

/** A planned call a person or a policy allowed. */
export interface AuthorizedOutboundToolCall extends PlannedOutboundToolCall {
  authority: ActionReviewAuthority
  grant?: ActionReviewGrant
  authorizedAt: number
}

interface PlannedEntry {
  call: PlannedOutboundToolCall
  at: number
}

/** Keyed by session + permission request. */
const planned = new Map<string, PlannedEntry>()
/** Keyed by session + tool use. */
const authorized = new Map<string, AuthorizedOutboundToolCall>()
/** Session + tool use → the owner of the running call, e.g. `plugin:<id>`. */
const running = new Map<string, string>()

const requestKey = (sessionId: string, requestId: string) => `${sessionId}\u0000${requestId}`
const toolUseKey = (sessionId: string, toolUseId: string) => `${sessionId}\u0000${toolUseId}`

function bound<V>(map: Map<string, V>): void {
  while (map.size > MAX_TRACKED_TOOL_CALLS) {
    const oldest = map.keys().next()
    if (oldest.done) break
    map.delete(oldest.value)
  }
}

/** Remember a planned call's recipients until it is answered. */
export function rememberPlannedOutboundToolCall(
  call: PlannedOutboundToolCall,
  now: number = Date.now()
): void {
  const key = requestKey(call.sessionId, call.requestId)
  planned.delete(key)
  planned.set(key, { call: { ...call, fingerprints: [...call.fingerprints] }, at: now })
  bound(planned)
}

/**
 * Record that a planned call was allowed, before the allow is dispatched.
 * `false` when no plan was remembered for it (not an outbound tool, no
 * `toolUseID`, or already answered), which callers may ignore: the call's
 * deliveries are then planned on their own.
 */
export function authorizeOutboundToolCall(
  sessionId: string,
  requestId: string,
  attribution: { authority: ActionReviewAuthority; grant?: ActionReviewGrant },
  now: number = Date.now()
): boolean {
  const key = requestKey(sessionId, requestId)
  const entry = planned.get(key)
  if (!entry || now - entry.at > AUTHORIZED_TOOL_CALL_TTL_MS) {
    planned.delete(key)
    return false
  }
  planned.delete(key)
  const useKey = toolUseKey(sessionId, entry.call.toolUseId)
  authorized.delete(useKey)
  authorized.set(useKey, {
    ...entry.call,
    authority: attribution.authority,
    ...(attribution.grant ? { grant: { ...attribution.grant } } : {}),
    authorizedAt: now,
  })
  bound(authorized)
  return true
}

/** Drop a planned call that was refused. */
export function forgetPlannedOutboundToolCall(sessionId: string, requestId: string): void {
  planned.delete(requestKey(sessionId, requestId))
}

/** The authorization of a call, or `undefined` when there is none or it expired. */
export function authorizedOutboundToolCall(
  sessionId: string,
  toolUseId: string,
  now: number = Date.now()
): AuthorizedOutboundToolCall | undefined {
  const key = toolUseKey(sessionId, toolUseId)
  const entry = authorized.get(key)
  if (!entry) return undefined
  if (now - entry.authorizedAt > AUTHORIZED_TOOL_CALL_TTL_MS) {
    authorized.delete(key)
    return undefined
  }
  return entry
}

/** Mark a tool call as running on behalf of `owner` (`plugin:<id>`, `builtin`, `team`). */
export function beginOutboundToolExecution(
  sessionId: string,
  toolUseId: string,
  owner: string
): void {
  const key = toolUseKey(sessionId, toolUseId)
  running.delete(key)
  running.set(key, owner)
  bound(running)
}

/**
 * The call returned: it delivers nothing more, so its authorization goes with
 * it and a later delivery that claims it is planned on its own.
 */
export function endOutboundToolExecution(sessionId: string, toolUseId: string): void {
  const key = toolUseKey(sessionId, toolUseId)
  running.delete(key)
  authorized.delete(key)
}

/** The authorized calls running on behalf of `owner` right now. */
export function runningAuthorizedToolCallsOf(
  owner: string,
  now: number = Date.now()
): AuthorizedOutboundToolCall[] {
  const calls: AuthorizedOutboundToolCall[] = []
  for (const [key, runningOwner] of running) {
    if (runningOwner !== owner) continue
    const [sessionId, toolUseId] = key.split("\u0000")
    const call = authorizedOutboundToolCall(sessionId, toolUseId, now)
    if (call) calls.push(call)
  }
  return calls
}

export function __resetAuthorizedToolCallsForTesting(): void {
  planned.clear()
  authorized.clear()
  running.clear()
}
