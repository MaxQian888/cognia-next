/**
 * Owner facts for renderer-managed ACP sessions.
 *
 * ACP sessions live in `ExternalAgentManager` (an in-renderer control plane),
 * not in the Rust fleet registry, so the ids an owner ref needs — the
 * manager's `agentId`, the agent's configured display name, and the chat
 * session the run was started from — never appear on a Rust `FleetSession`.
 * The ACP fleet projection records them here as it observes each session.
 *
 * This module is a deliberate leaf: `lib/island/owner.ts` reads it
 * synchronously while folding attention items into fleet rows, and both are
 * exercised in the node-env Jest project. Keep it free of store, manager and
 * adapter imports.
 */

import type { FleetAgent } from "./types"

/** What the island needs to route one ACP session's owner and decisions. */
export interface AcpSessionOwnerFacts {
  /** Fleet identity derived from the agent preset (`devin`, `acp`, …). */
  agent: FleetAgent
  /** `ExternalAgentManager` agent id — the address of every control call. */
  agentId: string
  /** Configured agent name shown when `agent` is the generic `acp` kind. */
  agentLabel?: string
  /** The Cognia chat session this run is bound to, when one exists. */
  chatSessionId?: string
}

const owners = new Map<string, AcpSessionOwnerFacts>()

/** Record or update the facts for one ACP session id. */
export function registerAcpSession(sessionId: string, facts: AcpSessionOwnerFacts): void {
  const existing = owners.get(sessionId)
  owners.set(sessionId, existing ? { ...existing, ...facts } : facts)
}

/** Facts for a session id, or `undefined` when the projection has not seen it. */
export function acpSessionOwnerFacts(
  sessionId: string | null | undefined
): AcpSessionOwnerFacts | undefined {
  return sessionId ? owners.get(sessionId) : undefined
}

/** Drop a session's facts once its row is gone for good. */
export function unregisterAcpSession(sessionId: string): void {
  owners.delete(sessionId)
}

/** Test seam: forget every registered session. */
export function __resetAcpSessionRegistryForTests(): void {
  owners.clear()
}
