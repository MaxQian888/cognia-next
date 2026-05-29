import type { ComputerUseTarget } from "@/lib/automation/sandbox-target"

/**
 * Per-session resolved Computer-Use execution target (ADR-0020 remote-target).
 *
 * `resolveSendOptions` resolves the target (session → character → local) at
 * chat-send time and stashes it here keyed by session id; the computer-use
 * plugin's `execute()` callback reads it back via `getActiveComputerUseTarget`
 * to stamp `CallContext.sandboxConnectionId`. Mirrors the
 * `computer-use-active-settings` stash pattern. Module-level Map (renderer is a
 * single process); cleared when Computer Use is disabled for the session.
 */
const active = new Map<string, ComputerUseTarget>()

export function setActiveComputerUseTarget(
  sessionId: string | undefined,
  target: ComputerUseTarget
): void {
  if (sessionId) active.set(sessionId, target)
}

export function getActiveComputerUseTarget(sessionId: string | undefined): ComputerUseTarget {
  return (sessionId ? active.get(sessionId) : undefined) ?? { kind: "local" }
}

export function clearActiveComputerUseTarget(sessionId: string | undefined): void {
  if (sessionId) active.delete(sessionId)
}
