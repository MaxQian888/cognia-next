/**
 * Project-scoped collection naming for the host-routed vector agent tools
 * (`vector_search` / `vector_add_document` / `vector_delete_document`).
 *
 * The agent never sees or supplies a project id: it names a **logical**
 * collection (`"documents"` by default) and the host maps that onto an
 * internal, project-prefixed **native** collection. This module is the single
 * place that mapping happens, and it is deliberately pure so the isolation
 * property is unit-testable without a store.
 *
 * Isolation rests on two rules, both enforced here:
 *
 *   1. The logical name is validated against a strict charset that cannot
 *      contain the `__` separator, so a crafted logical name (`"a__b"`,
 *      `"../other"`, `"project_p2__documents"`) can never be parsed back as a
 *      different project's namespace.
 *   2. The prefix is built from the context-resolved project id only. There is
 *      no argument on any tool that reaches it.
 *
 * Plugin collections (`plugin_<pluginId>_<name>`, see
 * `lib/plugin/api/vector-api.ts`) live in a disjoint namespace and are left
 * untouched — `project_` and `plugin_` prefixes never collide.
 */

/** Logical collection used when the agent omits `collection`. */
export const DEFAULT_AGENT_VECTOR_COLLECTION = "documents"

/** Namespace prefix for every project-scoped agent collection. */
export const AGENT_COLLECTION_NAMESPACE = "project"

/**
 * Separator between the project id and the logical name. Two underscores —
 * a logical name may contain a single `_` but never `__`, so the boundary is
 * unambiguous no matter what the project id looks like.
 */
export const AGENT_COLLECTION_SEPARATOR = "__"

/** Longest accepted logical collection name. */
export const MAX_LOGICAL_COLLECTION_LENGTH = 64

/**
 * Accepted logical names: ASCII alphanumeric start, then alphanumerics,
 * hyphens and single underscores. `__` is rejected separately so the
 * separator stays reserved.
 */
const LOGICAL_COLLECTION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** Why a logical collection name was refused. */
export type LogicalCollectionRejection =
  "empty" | "too-long" | "invalid-characters" | "reserved-separator"

export type LogicalCollectionCheck =
  { ok: true; name: string } | { ok: false; reason: LogicalCollectionRejection }

/**
 * Validate an agent-supplied logical collection name. Returns the trimmed name
 * on success, or a machine-readable reason the caller turns into a typed tool
 * error.
 */
export function checkLogicalCollection(raw: string | undefined | null): LogicalCollectionCheck {
  const name = typeof raw === "string" ? raw.trim() : ""
  if (!name) return { ok: false, reason: "empty" }
  if (name.length > MAX_LOGICAL_COLLECTION_LENGTH) return { ok: false, reason: "too-long" }
  if (name.includes(AGENT_COLLECTION_SEPARATOR)) {
    return { ok: false, reason: "reserved-separator" }
  }
  if (!LOGICAL_COLLECTION_PATTERN.test(name)) return { ok: false, reason: "invalid-characters" }
  return { ok: true, name }
}

/** Human-readable explanation for a rejection, surfaced to the model. */
export function describeLogicalCollectionRejection(reason: LogicalCollectionRejection): string {
  switch (reason) {
    case "empty":
      return "collection must be a non-empty string"
    case "too-long":
      return `collection must be at most ${MAX_LOGICAL_COLLECTION_LENGTH} characters`
    case "reserved-separator":
      return `collection may not contain "${AGENT_COLLECTION_SEPARATOR}" (reserved separator)`
    case "invalid-characters":
      return "collection must start with a letter or digit and contain only letters, digits, hyphens and underscores"
  }
}

/**
 * The namespace prefix owned by `projectId`. Every native collection the agent
 * can reach for that project starts with this string.
 */
export function agentCollectionPrefix(projectId: string): string {
  return `${AGENT_COLLECTION_NAMESPACE}_${projectId}${AGENT_COLLECTION_SEPARATOR}`
}

/**
 * Map a validated logical name onto the internal native collection for
 * `projectId`. Throws when the logical name did not pass
 * {@link checkLogicalCollection} — call that first and surface the typed error.
 */
export function resolveAgentCollection(projectId: string, logical: string): string {
  const checked = checkLogicalCollection(logical)
  if (!checked.ok) {
    throw new Error(
      `invalid logical collection: ${describeLogicalCollectionRejection(checked.reason)}`
    )
  }
  if (!projectId) throw new Error("resolveAgentCollection requires a project id")
  return `${agentCollectionPrefix(projectId)}${checked.name}`
}

/** Does `nativeName` belong to `projectId`'s namespace? */
export function isAgentCollectionOfProject(projectId: string, nativeName: string): boolean {
  if (!projectId) return false
  return nativeName.startsWith(agentCollectionPrefix(projectId))
}

/**
 * Recover the logical name from a native collection in `projectId`'s
 * namespace, or `undefined` when it belongs to another project (or is not an
 * agent collection at all).
 */
export function logicalNameOf(projectId: string, nativeName: string): string | undefined {
  if (!isAgentCollectionOfProject(projectId, nativeName)) return undefined
  return nativeName.slice(agentCollectionPrefix(projectId).length) || undefined
}
