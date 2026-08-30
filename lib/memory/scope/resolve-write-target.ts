/**
 * The one place a memory write decides WHICH namespace it lands in.
 *
 * Before this module there were four independent answers to that question, and
 * they disagreed. `resolveAutomaticMemoryScope` threw its `configured` argument
 * away. `rememberFact` resolved a scope but never the `projectId` that scope
 * requires. `storeMemoryCore` validates a target but never derives one. And
 * `AddMemoryDialog` made the user type a workspace id by hand.
 *
 * The disagreement was not cosmetic. A `workspace`-scoped row written without a
 * `projectId` is invisible forever: `isVisibleToReader` (`lib/db/memories.ts`)
 * requires `memory.projectId === reader.projectId`, so `/remember` reported
 * success for a fact nothing could ever recall.
 *
 * The ladder below is deliberately deterministic, with no scoring and no "best
 * guess". An explicit pick is honoured or refused, never widened. Everything
 * else falls from the configured default, to the session's workspace, to global.
 */

import {
  scopeAllowedByAgentMemoryPolicy,
  type ResolvedAgentMemoryPolicy,
} from "@/lib/memory/agent-policy"
import { appendMemoryAuditEvent } from "@/lib/db/memory-governance"
import { resolveSessionProjectId, resolveScopeProjectId } from "@/lib/db/project-scope"
import type { MemoryScope } from "@/types/memory/memory"

/**
 * Why the write landed where it did. Persisted onto `Memory.scopeRationale`, so
 * the inspector can explain a narrow scope instead of just displaying it.
 */
export type MemoryScopeRationale =
  /** The caller named the scope (the `#` picker, a workflow node, a pinned claim). */
  | "caller_explicit"
  /** The user's `scopeDefault` selected a scope narrower than the fallback would have. */
  | "user_configured_default"
  /** Fell through to the session's workspace. */
  | "session_workspace"
  /** Fell all the way through to global. */
  | "global_fallback"

export type MemoryWriteOperation = "create" | "update"

export interface ResolveMemoryWriteTargetInput {
  /** An explicit pick. Validated against policy, and NEVER widened on refusal. */
  requested?: MemoryScope
  /** `MemoryConfig.scopeDefault`. Consulted first in the fallback ladder. */
  configured?: MemoryScope
  policy: ResolvedAgentMemoryPolicy
  session?: { id?: string; projectId?: string; characterId?: string } | null
  /** Already namespaced by `resolveMemoryAgentNamespace`. Required for `agent`. */
  agentId?: string
  /** Explicit workspace override (a connector inbound that knows its project). */
  projectId?: string
  /** Project claims are workspace-only by construction. */
  pin?: "workspace"
  operation?: MemoryWriteOperation
  /** Test seam. Defaults to `resolveSessionProjectId`. */
  resolveProjectId?: (sessionId?: string, explicit?: string | null) => Promise<string>
}

export interface ResolvedMemoryWriteTarget {
  ok: true
  scope: MemoryScope
  projectId?: string
  characterId?: string
  agentId?: string
  scopeRationale: MemoryScopeRationale
}

export interface RefusedMemoryWriteTarget {
  ok: false
  reason: "scope_denied"
  /** Every scope the ladder tried, in order, for the audit row. */
  attempted: MemoryScope[]
}

export type MemoryWriteTarget = ResolvedMemoryWriteTarget | RefusedMemoryWriteTarget

/** The fallback ladder, used both for the real resolve and for the rationale probe. */
const FALLBACK_LADDER: readonly MemoryScope[] = ["workspace", "global"]

function defaultResolveProjectId(sessionId?: string, explicit?: string | null): Promise<string> {
  return sessionId ? resolveSessionProjectId(sessionId, explicit) : resolveScopeProjectId(explicit)
}

/** Dedupe while preserving order, because the ladder's order IS the precedence. */
function candidateScopes(input: ResolveMemoryWriteTargetInput): MemoryScope[] {
  if (input.pin) return [input.pin]
  if (input.requested) return [input.requested]
  const ladder = input.configured ? [input.configured, ...FALLBACK_LADDER] : [...FALLBACK_LADDER]
  return [...new Set(ladder)]
}

/**
 * Walk a candidate list and return the first scope that policy allows AND whose
 * required namespace id can be resolved. `resolveProject` is memoised by the
 * caller so the rationale probe costs no extra Dexie work.
 */
async function firstSatisfiable(
  candidates: readonly MemoryScope[],
  input: ResolveMemoryWriteTargetInput,
  resolveProject: () => Promise<string>
): Promise<{ scope: MemoryScope; projectId?: string } | undefined> {
  const operation = input.operation ?? "create"
  for (const scope of candidates) {
    if (!scopeAllowedByAgentMemoryPolicy(input.policy, operation, scope)) continue
    if (scope === "workspace") {
      // Never null: explicit, then the session's project, then the active
      // project, then an auto-created Default. This single line is the fix for
      // the invisible-row bug.
      return { scope, projectId: await resolveProject() }
    }
    if (scope === "character") {
      if (!input.session?.characterId) continue
      return { scope }
    }
    if (scope === "agent") {
      if (!input.agentId) continue
      return { scope }
    }
    return { scope }
  }
  return undefined
}

export async function resolveMemoryWriteTarget(
  input: ResolveMemoryWriteTargetInput
): Promise<MemoryWriteTarget> {
  const resolveProjectId = input.resolveProjectId ?? defaultResolveProjectId
  let memoisedProjectId: string | undefined
  const resolveProject = async () => {
    memoisedProjectId ??= await resolveProjectId(
      input.session?.id,
      input.projectId ?? input.session?.projectId ?? null
    )
    return memoisedProjectId
  }

  const candidates = candidateScopes(input)
  const winner = await firstSatisfiable(candidates, input, resolveProject)
  if (!winner) return { ok: false, reason: "scope_denied", attempted: candidates }

  return {
    ok: true,
    scope: winner.scope,
    ...(winner.projectId ? { projectId: winner.projectId } : {}),
    ...(winner.scope === "character" && input.session?.characterId
      ? { characterId: input.session.characterId }
      : {}),
    ...(winner.scope === "agent" && input.agentId ? { agentId: input.agentId } : {}),
    scopeRationale: await rationaleFor(winner.scope, input, resolveProject),
  }
}

/**
 * Answering "did the user's setting matter?" honestly requires running the
 * ladder a second time WITHOUT `configured`. If the two winners differ, the
 * setting is what selected the narrower scope. The second pass shares the
 * memoised project id, so it costs no extra I/O.
 */
async function rationaleFor(
  scope: MemoryScope,
  input: ResolveMemoryWriteTargetInput,
  resolveProject: () => Promise<string>
): Promise<MemoryScopeRationale> {
  if (input.pin || input.requested) return "caller_explicit"
  if (input.configured) {
    const withoutConfigured = await firstSatisfiable(FALLBACK_LADDER, input, resolveProject)
    if (withoutConfigured?.scope !== scope) return "user_configured_default"
  }
  return scope === "workspace" ? "session_workspace" : "global_fallback"
}

/**
 * The single refusal audit row. Every surface that gets `{ok: false}` calls
 * this, so a policy-denied write is always explainable from the ledger rather
 * than only from a toast the user already dismissed.
 */
export async function auditMemoryScopeRefusal(input: {
  sessionId?: string
  attempted: readonly MemoryScope[]
  /** Which entry point was refused: `remember`, `composer`, `cli`, `turn`. */
  surface: string
}): Promise<void> {
  await appendMemoryAuditEvent({
    action: "learn-denied",
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    reason: "agent_scope_policy",
    // `metadata` takes primitives only, so the list is joined rather than nested.
    metadata: { attempted: input.attempted.join(","), surface: input.surface },
  }).catch(() => undefined)
}
