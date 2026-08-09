// The capability snapshot every surface reports (ADR-0090 plan Stage 5).
//
// Desktop settings, the CLI, the headless brain and a companion client must all
// answer "what can this runtime actually do?" with the SAME artifact. They do
// that by building it here from a `ResolvedAgentExecutionSpec` — the frozen
// output of the one resolver — rather than each reading the capability tables
// their own way. Four readers of one table is four chances to read it
// differently; four callers of one function is none.
//
// The snapshot is pure data: no live session, no IPC, no clock. It describes
// what the CONFIGURATION supports, which is why it can be produced before a
// session exists and on a host with no sidecar running. What a live session
// currently reports (MCP status, loaded skills, background tasks) is a
// different question with a different answer, and deliberately not here.
//
// Secrets never appear: the spec carries credentials as references only
// (ADR-0090 constraint 4), and this copies no credential field at all.

import {
  AGENT_CAPABILITY_IDS,
  type AgentCapabilityEvidence,
  type AgentCapabilityId,
  type AgentRuntimeAdapterId,
  type ResolvedAgentExecutionSpec,
} from "@cognia/agent-config-types/agent-execution"
import {
  SESSION_API_CAPABILITIES,
  SESSION_CONTROL_CAPABILITIES,
  type SessionApiMethod,
  type SessionControlMethod,
} from "@cognia/agent-config-types"
import { PINNED_RUNTIME_VERSIONS } from "@cognia/agent-config-types/runtime-versions"

export const CAPABILITY_SNAPSHOT_VERSION = 1

export type CapabilitySupport = AgentCapabilityEvidence["support"]

/**
 * One capability's verdict, plus what it actually unlocks.
 *
 * `controls` / `sessionFunctions` are the point of the row. "`checkpoint`:
 * unsupported" tells a user nothing; "`checkpoint`: unsupported — so
 * rewindFiles, readFile and seedReadState are unavailable" tells them why the
 * button is missing. Both lists are DERIVED from the capability maps, so a
 * method added to the manifest appears here without anyone remembering to.
 */
export interface AgentCapabilityRow {
  id: AgentCapabilityId
  support: CapabilitySupport
  /**
   * The resolver's own reason, present only when the caller asked about this
   * capability (via `requires`/`prefers`) and did not get it. Absent otherwise:
   * a capability nobody asked for has no recorded reason, and synthesising one
   * here would both duplicate the resolver's wording and put a fabricated
   * specificity into an artifact that gets exported. Surfaces supply their own
   * generic wording for the absent case.
   */
  reason?: string
  controls: readonly SessionControlMethod[]
  sessionFunctions: readonly SessionApiMethod[]
}

export interface AgentCapabilitySnapshot {
  snapshotVersion: typeof CAPABILITY_SNAPSHOT_VERSION
  runtimeAdapter: AgentRuntimeAdapterId
  /** The spec's own version — a v1 spec carries no per-capability evidence. */
  specVersion: ResolvedAgentExecutionSpec["specVersion"]
  executionFingerprint: string
  hostRef: string
  /** Pin the snapshot was taken against, so a stale one is recognisable. */
  agentSdkVersion: string
  capabilities: readonly AgentCapabilityRow[]
  counts: Record<CapabilitySupport, number> & { total: number }
}

function methodsFor<M extends string>(
  table: Record<M, AgentCapabilityId>,
  capability: AgentCapabilityId
): readonly M[] {
  return (Object.keys(table) as M[]).filter((m) => table[m] === capability).sort()
}

/**
 * Every capability in the vocabulary, sorted, with the verdict for this spec.
 *
 * The row set is the whole vocabulary rather than just what the spec granted —
 * a surface that only listed what works cannot show a user what does not, and
 * "absent" and "unsupported" would render identically. `AGENT_CAPABILITY_IDS`
 * is the source, so a new capability id shows up as `unsupported` on every
 * existing adapter until someone wires it, which is the honest default.
 */
export function buildCapabilitySnapshot(
  spec: ResolvedAgentExecutionSpec,
  options: { agentSdkVersion?: string } = {}
): AgentCapabilitySnapshot {
  const effective = new Set(spec.capabilities.effective)
  const support = spec.capabilities.support ?? {}

  const capabilities = [...AGENT_CAPABILITY_IDS].sort().map<AgentCapabilityRow>((id) => {
    const evidence = support[id]
    // A v1 spec has no `support` map at all, so fall back to membership in
    // `effective`. Reporting `unsupported` for everything on a v1 spec would
    // be worse than a coarse answer — it would be a wrong one.
    const verdict: CapabilitySupport =
      evidence?.support ?? (effective.has(id) ? "native" : "unsupported")
    return {
      id,
      support: verdict,
      ...(verdict !== "native" && evidence?.reason ? { reason: evidence.reason } : {}),
      controls: methodsFor(SESSION_CONTROL_CAPABILITIES, id),
      sessionFunctions: methodsFor(SESSION_API_CAPABILITIES, id),
    }
  })

  const counts = { native: 0, equivalent: 0, unsupported: 0, total: capabilities.length }
  for (const row of capabilities) counts[row.support] += 1

  return {
    snapshotVersion: CAPABILITY_SNAPSHOT_VERSION,
    runtimeAdapter: spec.runtimeAdapter,
    specVersion: spec.specVersion,
    executionFingerprint: spec.executionFingerprint,
    hostRef: spec.hostRef,
    agentSdkVersion: options.agentSdkVersion ?? PINNED_RUNTIME_VERSIONS.agentSdkVersion,
    capabilities,
    counts,
  }
}

/** Whether a control method is reachable on this snapshot's runtime. */
export function snapshotAllowsControl(
  snapshot: AgentCapabilitySnapshot,
  method: SessionControlMethod
): boolean {
  const needed = SESSION_CONTROL_CAPABILITIES[method]
  return snapshot.capabilities.some((c) => c.id === needed && c.support !== "unsupported")
}

/** Whether a session-level SDK function is reachable on this snapshot's runtime. */
export function snapshotAllowsSessionApi(
  snapshot: AgentCapabilitySnapshot,
  method: SessionApiMethod
): boolean {
  const needed = SESSION_API_CAPABILITIES[method]
  return snapshot.capabilities.some((c) => c.id === needed && c.support !== "unsupported")
}

/**
 * A one-line, surface-independent digest.
 *
 * Exists so the E2E check that "Tauri, the CLI and the headless host produce
 * the same snapshot" compares one string instead of walking two objects — and
 * so a mismatch names the axis that differs rather than dumping a diff. The
 * fingerprint is in it because two snapshots that agree on capabilities but
 * came from different specs are not the same snapshot.
 */
export function capabilitySnapshotDigest(snapshot: AgentCapabilitySnapshot): string {
  const caps = snapshot.capabilities.map((c) => `${c.id}=${c.support}`).join(",")
  return [
    `v${snapshot.snapshotVersion}`,
    snapshot.runtimeAdapter,
    `spec${snapshot.specVersion}`,
    `sdk${snapshot.agentSdkVersion}`,
    snapshot.executionFingerprint,
    caps,
  ].join("|")
}
