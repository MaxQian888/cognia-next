/**
 * Permission gate for the External Bridge MCP server.
 *
 * Every handler call routes through `checkScope` before doing any work; the
 * gate's only inputs are the requested scope + the user's enabled scope
 * whitelist (sourced from `AppSettings.externalBridge.enabledScopes`).
 *
 * The whitelist is the **only** source of truth for "what the bridge can
 * see". Default-OFF is enforced by `DEFAULT_ENABLED_SCOPES` containing only
 * the public-code wiki + RAG; everything that touches user content
 * (skills / characters / twins / plugins / agent-teams) requires an
 * explicit toggle in Settings.
 */

import type { BridgeScope, ExternalBridgeSettings } from "@/types/wiki"
import { RUNTIME_ENTITY_TO_SCOPE, TOOL_TO_SCOPE, type ScopeCheckResult } from "./types"

/**
 * Check whether the caller is allowed to invoke a scope right now.
 *
 * `settings` may be `undefined` when the server is freshly started before
 * the user has visited Settings — treated as "all OFF" so the gate stays
 * deny-by-default.
 */
export function checkScope(
  settings: ExternalBridgeSettings | undefined,
  scope: BridgeScope
): ScopeCheckResult {
  if (!settings) {
    return { allowed: false, reason: "external bridge not configured" }
  }
  if (!settings.enabled) {
    return { allowed: false, reason: "external bridge disabled" }
  }
  if (!settings.enabledScopes.includes(scope)) {
    return {
      allowed: false,
      reason: `scope '${scope}' not enabled — toggle it in Settings → External Bridge`,
    }
  }
  return { allowed: true }
}

/**
 * Resolve the scope a tool requires. Returns `undefined` for tools not
 * registered in `TOOL_TO_SCOPE`; callers must treat that as "unknown tool"
 * and deny.
 */
export function requiredScopeForTool(toolName: string): BridgeScope | undefined {
  return TOOL_TO_SCOPE[toolName]
}

/**
 * Resolve the scope a `runtime_query` call requires based on the
 * `entityType` argument.
 */
export function requiredScopeForRuntimeEntity(entityType: string): BridgeScope | undefined {
  return RUNTIME_ENTITY_TO_SCOPE[entityType]
}

/**
 * Convenience wrapper: check a tool call by name. For `runtime_query`,
 * caller must use `checkRuntimeCall` instead because the scope depends on
 * the entityType arg.
 */
export function checkToolCall(
  settings: ExternalBridgeSettings | undefined,
  toolName: string
): ScopeCheckResult {
  const scope = requiredScopeForTool(toolName)
  if (!scope) {
    return { allowed: false, reason: `unknown tool '${toolName}'` }
  }
  return checkScope(settings, scope)
}

/** Convenience wrapper for `runtime_query` calls. */
export function checkRuntimeCall(
  settings: ExternalBridgeSettings | undefined,
  entityType: string
): ScopeCheckResult {
  const scope = requiredScopeForRuntimeEntity(entityType)
  if (!scope) {
    return { allowed: false, reason: `unknown runtime entity '${entityType}'` }
  }
  return checkScope(settings, scope)
}
