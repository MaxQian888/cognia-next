/**
 * In-process registry of pending tool-permission approvals (control-plane HITL).
 *
 * When an ask-tier tool fires during an IM auto-mode turn, the connector
 * runtime's `onPermissionRequest` responder (see `tool-approval.ts`) projects
 * an A2UI Allow/Deny card to the conversation and then `await`s a Promise
 * registered here, keyed by `${sessionId}:${requestId}`. The sidecar holds the
 * tool until that Promise resolves — so the turn naturally suspends without any
 * custom suspend/resume machinery. The button-press callback
 * (`bus.dispatchConnectorCallback` → `tool_approve` short-circuit) resolves it.
 *
 * A TTL backstop resolves a stale approval as `deny` so a forgotten card can
 * never wedge a turn open forever. Producer (`onPermissionRequest`) and
 * resolver (callback) run in the same renderer process, so a module-level
 * singleton is the correct shared channel.
 */

import type { CapturePermissionDecision } from "@/lib/claude/run-and-capture"

/** Default time a permission card waits for a button press before auto-denying. */
export const DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1000

interface PendingApproval {
  resolve: (decision: CapturePermissionDecision) => void
  timer: ReturnType<typeof setTimeout> | null
  /** Called when the TTL fires, so callers can audit the expiry. */
  onExpire?: () => void
}

const pending = new Map<string, PendingApproval>()
// sessionId → set of toolNames the user chose to "allow for this session".
const sessionBypass = new Map<string, Set<string>>()

function key(sessionId: string, requestId: string): string {
  return `${sessionId}:${requestId}`
}

/** True when the user previously chose "allow for session" for this tool. */
export function hasSessionBypass(sessionId: string, toolName: string): boolean {
  return sessionBypass.get(sessionId)?.has(toolName) ?? false
}

/** Remember a per-session auto-approve for this tool (from "Allow for session"). */
export function grantSessionBypass(sessionId: string, toolName: string): void {
  let set = sessionBypass.get(sessionId)
  if (!set) {
    set = new Set()
    sessionBypass.set(sessionId, set)
  }
  set.add(toolName)
}

/** Drop a session's bypass set (e.g. when the conversation's session rotates). */
export function clearSessionBypass(sessionId: string): void {
  sessionBypass.delete(sessionId)
}

export interface AwaitApprovalOptions {
  ttlMs?: number
  /** Invoked once if the approval times out (for an `expired` audit). */
  onExpire?: () => void
}

/**
 * Register a pending approval and return a Promise that resolves when the user
 * presses a button (`resolveApproval`) or the TTL elapses (auto-deny). A
 * duplicate request id replaces any prior pending entry (denying the old one).
 */
export function awaitApproval(
  sessionId: string,
  requestId: string,
  opts: AwaitApprovalOptions = {}
): Promise<CapturePermissionDecision> {
  const k = key(sessionId, requestId)
  // Resolve any stale entry for the same key as a deny before replacing it.
  const prior = pending.get(k)
  if (prior) {
    if (prior.timer) clearTimeout(prior.timer)
    prior.resolve({ decision: "deny", message: "superseded by a newer request" })
    pending.delete(k)
  }

  // Clamp to a positive floor: a caller passing `0` (or a negative) used to
  // disable the watchdog entirely, leaving the tool waiting for a button press
  // forever. There must always be a TTL backstop, so fall back to the default.
  const ttlMs = opts.ttlMs !== undefined && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_APPROVAL_TTL_MS
  return new Promise<CapturePermissionDecision>((resolve) => {
    const timer = setTimeout(() => {
      const entry = pending.get(k)
      if (!entry) return
      pending.delete(k)
      entry.onExpire?.()
      resolve({ decision: "deny", message: "approval timed out" })
    }, ttlMs)
    pending.set(k, { resolve, timer, onExpire: opts.onExpire })
  })
}

/**
 * Resolve a pending approval with the user's decision. Returns `true` when a
 * matching pending entry was found and resolved, `false` otherwise (already
 * resolved / expired / unknown).
 */
export function resolveApproval(
  sessionId: string,
  requestId: string,
  decision: CapturePermissionDecision
): boolean {
  const k = key(sessionId, requestId)
  const entry = pending.get(k)
  if (!entry) return false
  if (entry.timer) clearTimeout(entry.timer)
  pending.delete(k)
  entry.resolve(decision)
  return true
}

/** Number of approvals currently awaiting a decision (test/diagnostics). */
export function pendingApprovalCount(): number {
  return pending.size
}

/** Reset all registry state. Test-only. */
export function __resetApprovalRegistryForTesting(): void {
  for (const entry of pending.values()) {
    if (entry.timer) clearTimeout(entry.timer)
  }
  pending.clear()
  sessionBypass.clear()
}
