/**
 * Trusted caller identity for memory surfaces.
 *
 * The single rule this type encodes: the identity that authorizes a memory
 * operation comes from the HOST that bound the caller — never from the request
 * payload. A request may carry `projectId` / `characterId` / `agentId`, but
 * those values are NARROWING filters intersected with what the caller is
 * authorized for; they can never grant access to a namespace the caller was
 * not bound to.
 *
 * Each transport constructs its caller at the boundary, from context the
 * client cannot forge:
 *
 *   - plugin:     the plugin id the plugin manager bound (never a payload
 *                 field — `createMemoryAPI(pluginId)` is manager-injected).
 *   - companion:  the `callerDeviceId` the Rust RPC layer injects, which
 *                 overwrites whatever the client sent.
 *   - mcp:        the local bridge process — a fixed principal today.
 *   - local-ui / cli / job: in-process callers acting as the account owner.
 *
 * `namespaces` is the authorization SET, not a filter: when present, a row
 * carrying `projectId` / `characterId` / `agentId` outside the set is not
 * visible to this caller at all. When absent the caller is the account-scope
 * default (today's documented `memory:read` semantic — the user's own data
 * plane); per-principal grants populate the sets as the grant store lands.
 *
 * Pure type module: no I/O, no `@/` imports.
 */

/** Transport the host bound this caller on. */
export type MemoryCallerTransport =
  "local-ui" | "cli" | "mcp" | "plugin" | "companion" | "workflow" | "internal-job"

/** Namespace values a caller is authorized for. An absent key is unconstrained. */
export interface MemoryCallerNamespaces {
  projects?: readonly string[]
  characterIds?: readonly string[]
  agentIds?: readonly string[]
}

export interface TrustedMemoryCaller {
  /**
   * Host-issued principal id. Stable within an account; used as the
   * `operationId` namespace for idempotent mutations and recorded on the
   * operation ledger.
   */
  principalId: string
  transport: MemoryCallerTransport
  /**
   * The character/agent the host bound this caller to act as. Resolves the
   * `memoryPolicy` governing the call — replacing the request-controlled
   * `policyCharacterId` / `sessionId` fields the old surfaces exposed.
   */
  policyCharacterId?: string
  /** Host-bound session, when the caller is bound to one. */
  sessionId?: string
  /**
   * The namespace set this principal may touch. `undefined` = account-scope
   * default (unconstrained); an empty array = that namespace class is closed
   * to this caller entirely.
   */
  namespaces?: MemoryCallerNamespaces
}

/**
 * Whether a row's namespace fields fall inside the caller's authorized set.
 * Rows carrying no value for a field are not constrained by that field's set —
 * a `global`-scoped row has no `projectId` and is not project data.
 */
export function memoryRowWithinNamespaces(
  row: { projectId?: string; characterId?: string; agentId?: string },
  namespaces: MemoryCallerNamespaces | undefined
): boolean {
  if (!namespaces) return true
  if (
    row.projectId !== undefined &&
    namespaces.projects !== undefined &&
    !namespaces.projects.includes(row.projectId)
  ) {
    return false
  }
  if (
    row.characterId !== undefined &&
    namespaces.characterIds !== undefined &&
    !namespaces.characterIds.includes(row.characterId)
  ) {
    return false
  }
  if (
    row.agentId !== undefined &&
    namespaces.agentIds !== undefined &&
    !namespaces.agentIds.includes(row.agentId)
  ) {
    return false
  }
  return true
}

/**
 * Narrow a request-supplied namespace value against the caller's set.
 * Returns the value when it is authorized, `undefined` when the caller did not
 * supply one, and `null` when the request names a namespace outside the
 * caller's set — the caller-facing "not authorized" signal (fail closed).
 */
export function narrowNamespaceValue(
  requested: string | undefined,
  allowed: readonly string[] | undefined
): string | undefined | null {
  if (requested === undefined) return undefined
  if (allowed === undefined || allowed.includes(requested)) return requested
  return null
}
