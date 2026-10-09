/**
 * An agent's default runtime (ADR-0220): the stored `Character.runtime`
 * binding, and the one place it becomes a live lane.
 *
 * The binding is the three lanes of `AgentRuntimeRef` without the host
 * admission stamp. A host configuration's revision changes whenever it is
 * edited, and a default that captured one revision would be refused by the
 * host the first time the configuration moved on, so the stamp is read again
 * here, at the moment a conversation starts.
 */

import type { Character, CharacterRuntimeBinding } from "@cognia/agent-config-types"
import type { AgentRuntimeRef } from "@/lib/ai/agent/runtime-catalog/types"
import { BUILTIN_RUNTIME_REF } from "@/lib/ai/agent/runtime-catalog/types"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"

/** The binding a picked lane is stored as. `name` caches the row's label. */
export function runtimeBindingFromRef(
  ref: AgentRuntimeRef,
  name?: string
): CharacterRuntimeBinding {
  switch (ref.kind) {
    case "builtin":
      return { kind: "builtin" }
    case "external":
      return { kind: "external", agentId: ref.agentId, ...(name ? { name } : {}) }
    case "host": {
      const label = name ?? ref.name
      return { kind: "host", configId: ref.configId, ...(label ? { name: label } : {}) }
    }
  }
}

/**
 * The catalog key the binding names, equal to `runtimeRefKey` of the lane it
 * resolves to, so a picker can mark the stored row without resolving it.
 */
export function runtimeBindingKey(binding: CharacterRuntimeBinding | undefined): string {
  if (!binding || binding.kind === "builtin") return "builtin"
  return binding.kind === "external" ? `external:${binding.agentId}` : `host:${binding.configId}`
}

/** True when two bindings name the same lane and target. Labels do not count. */
export function isSameRuntimeBinding(
  a: CharacterRuntimeBinding | undefined,
  b: CharacterRuntimeBinding | undefined
): boolean {
  return runtimeBindingKey(a) === runtimeBindingKey(b)
}

export interface RuntimeBindingDeps {
  /** Whether a locally configured external agent exists and is enabled. */
  hasLocalExternalAgent: (agentId: string) => boolean
  /** The host's current record for a configuration, or null when it has none. */
  getHostConfig: (configId: string) => Promise<ExternalAgentConfigRecord | null>
}

export type RuntimeBindingResolution =
  | { ok: true; ref: AgentRuntimeRef }
  | { ok: false; reason: "missing-external-agent" | "missing-host-config" | "host-unreachable" }

/**
 * The lane a binding runs on right now, or why it cannot. Never substitutes a
 * different agent: a default whose target is gone resolves to a failure the
 * caller reports, and the conversation stays on the app default.
 */
export async function resolveRuntimeBinding(
  binding: CharacterRuntimeBinding,
  deps: RuntimeBindingDeps
): Promise<RuntimeBindingResolution> {
  switch (binding.kind) {
    case "builtin":
      return { ok: true, ref: BUILTIN_RUNTIME_REF }
    case "external":
      return deps.hasLocalExternalAgent(binding.agentId)
        ? { ok: true, ref: { kind: "external", agentId: binding.agentId } }
        : { ok: false, reason: "missing-external-agent" }
    case "host": {
      let record: ExternalAgentConfigRecord | null
      try {
        record = await deps.getHostConfig(binding.configId)
      } catch {
        return { ok: false, reason: "host-unreachable" }
      }
      if (!record || !record.enabled || record.tombstonedAt !== undefined) {
        return { ok: false, reason: "missing-host-config" }
      }
      return {
        ok: true,
        ref: {
          kind: "host",
          configId: record.configId,
          revision: record.revision,
          lifecycleGeneration: record.lifecycleGeneration,
          name: record.config.name || binding.name,
        },
      }
    }
  }
}

export interface ApplyAgentRuntimeDeps extends RuntimeBindingDeps {
  setSessionRuntimeRef: (sessionId: string, ref: AgentRuntimeRef) => void
  /** Mirrors the manager's active agent, as the composer chip does. */
  selectExternalAgent: (agentId: string) => void
}

/**
 * Start `sessionId` on the agent's default runtime. A no-op for an agent with
 * no binding. Resolves the outcome so the caller can say why a default was not
 * honoured instead of silently running somewhere else.
 */
export async function applyAgentRuntimeToSession(
  sessionId: string,
  agent: Pick<Character, "runtime">,
  deps: ApplyAgentRuntimeDeps
): Promise<RuntimeBindingResolution | undefined> {
  if (!agent.runtime) return undefined
  const resolution = await resolveRuntimeBinding(agent.runtime, deps)
  if (!resolution.ok) return resolution
  if (resolution.ref.kind === "external") deps.selectExternalAgent(resolution.ref.agentId)
  deps.setSessionRuntimeRef(sessionId, resolution.ref)
  return resolution
}
