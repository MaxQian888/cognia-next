/**
 * Approval routing for dispatched subagents.
 *
 * A dispatched subagent runs on an EPHEMERAL sidecar session no pane ever
 * opens, so its `permission_request` events used to hit the renderer's
 * "session not open" branch and silently auto-deny. This registry maps the
 * child's ephemeral session id → the PARENT chat session (plus display
 * metadata), letting the permission listener re-bucket the ask into the
 * session the user is actually looking at (Claude Code v2.1.186 semantics:
 * background subagent prompts surface in the main session, naming the asker;
 * denying one call never kills the run).
 *
 * In-memory and renderer-local, mirroring `dispatch-context-registry` — the
 * route is registered by the executor right before the run starts and cleared
 * in its `finally`.
 */

import type { PluginDispatchApprovalRoute } from "@/types/plugin/plugin-agent-sdk"

export type SubagentApprovalRoute = PluginDispatchApprovalRoute

const routes = new Map<string, SubagentApprovalRoute>()

/** Register the route for a child's ephemeral session (executor start). */
export function registerSubagentApprovalRoute(
  ephemeralSessionId: string,
  route: SubagentApprovalRoute
): void {
  routes.set(ephemeralSessionId, route)
}

/** Resolve the route for an ephemeral session id (permission listener). */
export function getSubagentApprovalRoute(
  ephemeralSessionId: string
): SubagentApprovalRoute | undefined {
  return routes.get(ephemeralSessionId)
}

/** Clear the route (executor `finally`). */
export function clearSubagentApprovalRoute(ephemeralSessionId: string): void {
  routes.delete(ephemeralSessionId)
}

export function __clearAllSubagentApprovalRoutesForTesting(): void {
  routes.clear()
}
