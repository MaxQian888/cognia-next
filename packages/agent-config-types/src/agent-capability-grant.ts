// Per-invocation capability grants.
//
// An agent profile (`Character`) says what an agent is. A grant says what ONE
// run of it may additionally use, or must do without, because the feature that
// launched the run knows something the profile does not: a scheduled task needs
// its report skill, a workflow node wants a single MCP server, a plugin wants a
// prompt fragment and a tighter permission mode.
//
// Before this contract every non-composer caller patched `SendOptions` after
// `resolveSendOptions` returned. That skipped the tool filter, Restricted Mode,
// the parent permission ceiling and the tool-surface finalizer, so an
// "injection" could quietly widen a run. A grant is instead an INPUT to the
// resolver, applied at the same stage as the profile field it extends, so every
// clamp that governs the profile governs the grant too:
//
//   - additions (skills, tools, MCP servers, knowledge bases, instructions) join
//     the candidate sets before the filter, the ceiling and the finalizer run;
//   - removals and denials only ever narrow, and a later grant cannot re-admit
//     a tool an earlier one denied;
//   - `permissionMode` is narrow-only: the run gets the less privileged of the
//     grant's mode and the one the profile/session chain resolved.

import type { ValidationResult } from "./agent-execution"
import { AUTHORITY_RANK, narrowAuthority } from "./agent-composition"
import type { AgentPermissionMode, SendOptions } from "./index"

/** Wire-format version of {@link AgentCapabilityGrantV1}. */
export const AGENT_CAPABILITY_GRANT_SCHEMA_VERSION = 1

/** The feature that issued a grant. Diagnostic only; it never changes resolution. */
export type CapabilityGrantSourceKind =
  | "scheduler"
  | "workflow"
  | "plugin"
  | "bot"
  | "connector"
  | "agent-team"
  | "subagent"
  | "goal"
  | "issue"
  | "cli"
  | "automation"

export const CAPABILITY_GRANT_SOURCE_KINDS: readonly CapabilityGrantSourceKind[] = [
  "scheduler",
  "workflow",
  "plugin",
  "bot",
  "connector",
  "agent-team",
  "subagent",
  "goal",
  "issue",
  "cli",
  "automation",
]

/** Additive/subtractive change to an id set. `remove` beats `add` for the same id. */
export interface CapabilityIdDelta {
  add?: string[]
  remove?: string[]
}

export interface AgentCapabilityGrantV1 {
  schemaVersion: typeof AGENT_CAPABILITY_GRANT_SCHEMA_VERSION
  source: { kind: CapabilityGrantSourceKind; id?: string }
  /**
   * Model target for this run: a concrete id, an alias, or `auto`. Heads the
   * model chain, so it beats session, mode and profile choices, and still goes
   * through the routing planner like every other source.
   */
  model?: string
  /** Provider for this run. Heads the provider chain, like {@link model}. */
  provider?: string
  effort?: SendOptions["effort"]
  /** Agentic-turn ceiling for this run, 1 through 100. */
  maxTurns?: number
  /** Prompt fragments appended after the agent's own prompt. Never replace it. */
  instructions?: string[]
  /** Host and plugin skill ids. Added skills contribute their declared tools. */
  skills?: CapabilityIdDelta
  /**
   * MCP servers, by id, drawn from the servers enabled in the run's workspace.
   * `only` intersects the profile's subset; `add` / `remove` then adjust it.
   * An id that is not enabled is ignored, never auto-enabled.
   */
  mcpServers?: CapabilityIdDelta & { only?: string[] }
  tools?: {
    /** Joins the allow list the same way a skill's declared tools do. */
    add?: string[]
    /** Joins the deny list. Deny always wins, including over later grants. */
    deny?: string[]
    /** Intersects the resolved allow list. */
    restrictTo?: string[]
  }
  /** Knowledge bases queried for this run on top of the profile's own. */
  knowledgeBases?: { add?: string[] }
  /** Narrow-only permission cap. It can lower the resolved mode, never raise it. */
  permissionMode?: AgentPermissionMode
}

const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"]

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function checkIdList(value: unknown, path: string, errors: string[]): void {
  if (value === undefined) return
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id.trim())) {
    errors.push(`${path} must be an array of non-empty strings`)
  }
}

function checkDelta(value: unknown, path: string, keys: readonly string[], errors: string[]): void {
  if (value === undefined) return
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`)
    return
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) errors.push(`${path}.${key} is not a recognised field`)
  }
  for (const key of keys) checkIdList(value[key], `${path}.${key}`, errors)
}

/** Structural validation for grants that cross a trust boundary (plugins, IPC, stored rows). */
export function validateAgentCapabilityGrant(v: unknown): ValidationResult<AgentCapabilityGrantV1> {
  const errors: string[] = []
  if (!isRecord(v)) return { ok: false, errors: ["grant must be an object"] }
  if (v.schemaVersion !== AGENT_CAPABILITY_GRANT_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${AGENT_CAPABILITY_GRANT_SCHEMA_VERSION}`)
  }
  if (
    !isRecord(v.source) ||
    !CAPABILITY_GRANT_SOURCE_KINDS.includes(v.source.kind as CapabilityGrantSourceKind)
  ) {
    errors.push(`source.kind must be one of ${CAPABILITY_GRANT_SOURCE_KINDS.join("|")}`)
  } else if (v.source.id !== undefined && typeof v.source.id !== "string") {
    errors.push("source.id must be a string")
  }
  for (const key of ["model", "provider"] as const) {
    if (v[key] !== undefined && (typeof v[key] !== "string" || !(v[key] as string).trim())) {
      errors.push(`${key} must be a non-empty string`)
    }
  }
  if (v.effort !== undefined && !EFFORTS.includes(v.effort as string)) {
    errors.push(`effort must be one of ${EFFORTS.join("|")}`)
  }
  if (
    v.maxTurns !== undefined &&
    (!Number.isInteger(v.maxTurns) || (v.maxTurns as number) < 1 || (v.maxTurns as number) > 100)
  ) {
    errors.push("maxTurns must be an integer between 1 and 100")
  }
  checkIdList(v.instructions, "instructions", errors)
  checkDelta(v.skills, "skills", ["add", "remove"], errors)
  checkDelta(v.mcpServers, "mcpServers", ["add", "remove", "only"], errors)
  checkDelta(v.tools, "tools", ["add", "deny", "restrictTo"], errors)
  checkDelta(v.knowledgeBases, "knowledgeBases", ["add"], errors)
  if (
    v.permissionMode !== undefined &&
    !Object.prototype.hasOwnProperty.call(AUTHORITY_RANK, v.permissionMode as string)
  ) {
    errors.push("permissionMode must be a known permission mode")
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: v as unknown as AgentCapabilityGrantV1 }
}

function uniq(values: Iterable<string>): string[] {
  return [...new Set(values)]
}

function nonEmpty(values: string[]): string[] | undefined {
  return values.length > 0 ? values : undefined
}

/**
 * Apply an id delta to a base set. `remove` wins over `add` for the same id so
 * a grant that both adds and removes something fails toward less capability.
 */
export function applyCapabilityIdDelta(
  base: readonly string[],
  delta: CapabilityIdDelta | undefined
): string[] {
  if (!delta) return uniq(base)
  const removed = new Set(delta.remove ?? [])
  return uniq([...base, ...(delta.add ?? [])]).filter((id) => !removed.has(id))
}

function mergeDelta(
  outer: CapabilityIdDelta | undefined,
  inner: CapabilityIdDelta | undefined
): CapabilityIdDelta | undefined {
  if (!outer) return inner
  if (!inner) return outer
  const innerAdd = new Set(inner.add ?? [])
  const innerRemove = new Set(inner.remove ?? [])
  const add = uniq([...(outer.add ?? []).filter((id) => !innerRemove.has(id)), ...innerAdd])
  const remove = uniq([...(outer.remove ?? []).filter((id) => !innerAdd.has(id)), ...innerRemove])
  const merged: CapabilityIdDelta = {}
  if (add.length > 0) merged.add = add
  if (remove.length > 0) merged.remove = remove
  return merged
}

function intersectOptional(
  outer: readonly string[] | undefined,
  inner: readonly string[] | undefined
): string[] | undefined {
  if (!outer) return inner ? [...inner] : undefined
  if (!inner) return [...outer]
  const keep = new Set(inner)
  return outer.filter((id) => keep.has(id))
}

/**
 * Fold two grants, `inner` layered on `outer` (for example a bot's definition
 * grant, then the run request's). Scalars take the inner value; id deltas
 * compose in order; narrowing fields only ever narrow further:
 *
 *   - `tools.deny` is a union, so a later layer cannot re-admit a denied tool;
 *   - `tools.restrictTo` and `mcpServers.only` intersect;
 *   - `permissionMode` keeps the less privileged of the two.
 *
 * The result carries the inner grant's `source`.
 */
export function mergeCapabilityGrants(
  outer: AgentCapabilityGrantV1,
  inner: AgentCapabilityGrantV1
): AgentCapabilityGrantV1 {
  const merged: AgentCapabilityGrantV1 = {
    schemaVersion: AGENT_CAPABILITY_GRANT_SCHEMA_VERSION,
    source: inner.source,
  }
  const model = inner.model ?? outer.model
  if (model) merged.model = model
  const provider = inner.provider ?? outer.provider
  if (provider) merged.provider = provider
  const effort = inner.effort ?? outer.effort
  if (effort) merged.effort = effort
  const maxTurns = inner.maxTurns ?? outer.maxTurns
  if (maxTurns !== undefined) merged.maxTurns = maxTurns

  const instructions = [...(outer.instructions ?? []), ...(inner.instructions ?? [])]
  if (instructions.length > 0) merged.instructions = instructions

  const skills = mergeDelta(outer.skills, inner.skills)
  if (skills && (skills.add || skills.remove)) merged.skills = skills

  const mcpDelta = mergeDelta(outer.mcpServers, inner.mcpServers)
  const only = intersectOptional(outer.mcpServers?.only, inner.mcpServers?.only)
  if ((mcpDelta && (mcpDelta.add || mcpDelta.remove)) || only) {
    merged.mcpServers = { ...(mcpDelta ?? {}), ...(only ? { only } : {}) }
  }

  const deny = uniq([...(outer.tools?.deny ?? []), ...(inner.tools?.deny ?? [])])
  const denied = new Set(deny)
  const add = uniq([...(outer.tools?.add ?? []), ...(inner.tools?.add ?? [])]).filter(
    (tool) => !denied.has(tool)
  )
  const restrictTo = intersectOptional(outer.tools?.restrictTo, inner.tools?.restrictTo)
  if (add.length > 0 || deny.length > 0 || restrictTo) {
    merged.tools = {
      ...(nonEmpty(add) ? { add } : {}),
      ...(nonEmpty(deny) ? { deny } : {}),
      ...(restrictTo ? { restrictTo } : {}),
    }
  }

  const kb = uniq([...(outer.knowledgeBases?.add ?? []), ...(inner.knowledgeBases?.add ?? [])])
  if (kb.length > 0) merged.knowledgeBases = { add: kb }

  if (outer.permissionMode && inner.permissionMode) {
    merged.permissionMode = narrowAuthority(outer.permissionMode, inner.permissionMode)
  } else if (outer.permissionMode ?? inner.permissionMode) {
    merged.permissionMode = outer.permissionMode ?? inner.permissionMode
  }
  return merged
}

/** Fold an ordered list of grants, outermost first. `undefined` when the list is empty. */
export function foldCapabilityGrants(
  grants: readonly (AgentCapabilityGrantV1 | null | undefined)[] | undefined
): AgentCapabilityGrantV1 | undefined {
  let folded: AgentCapabilityGrantV1 | undefined
  for (const grant of grants ?? []) {
    if (!grant) continue
    folded = folded ? mergeCapabilityGrants(folded, grant) : grant
  }
  return folded
}

/**
 * The permission mode a run gets under a grant's cap. A grant with no cap, or a
 * run with no resolved mode, leaves the resolved value alone: a cap is only ever
 * a ceiling over something the profile chain chose.
 */
export function capPermissionModeByGrant(
  resolved: AgentPermissionMode | undefined,
  grant: Pick<AgentCapabilityGrantV1, "permissionMode"> | undefined
): AgentPermissionMode | undefined {
  const cap = grant?.permissionMode
  if (!cap) return resolved
  // No resolved mode means the SDK default, which is `default`.
  return narrowAuthority(cap, resolved ?? "default")
}
