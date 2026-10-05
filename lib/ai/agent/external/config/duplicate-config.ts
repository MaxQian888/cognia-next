/**
 * Duplicate an external-agent configuration.
 *
 * Several configurations of one runtime (a read-only Codex next to a
 * workspace-write one, the same CLI bound to two accounts) are separate configs,
 * so "make another like this one" is a copy of everything the user configured.
 * What describes the copy's own history is left behind:
 *
 *   - identity and timestamps (the store mints new ones);
 *   - the validity snapshot, negotiated capabilities and registry provenance,
 *     which record what was observed for the source, not what was configured;
 *   - lifecycle state, including unsandboxed-launch consent: consent covers one
 *     agent, and the copy has to be approved in its own right.
 *
 * And what would make the copy share something with its source is cut
 * (ADR-0216):
 *
 *   - the env keys the runtime's state-isolation rule owns (`CODEX_HOME`, …):
 *     copied verbatim they point the copy at the source's home, which is
 *     exactly the sharing a duplicate exists to avoid. An `isolated` copy gets
 *     its own root from the spawn backend; a `shared` one uses the runtime's
 *     default home, the same as any other shared configuration;
 *   - a fixed OpenCode `metadata.port`: two `opencode serve` cannot bind one
 *     port, so the copy picks a free one;
 *   - `metadata.serverPassword`: a credential, carried into the copy's own
 *     keyring slot by the caller like every other secret.
 *
 * Credentials are not part of the config (they live in the keyring under the
 * source's id); `ExternalAgentLifecycleService.duplicateConfig` and the Host's
 * `duplicateHostExternalAgentConfig` copy them into the new agent's own slots.
 */

import { agentStateIsolationFor } from "../policy/security-policy"
import type {
  CreateExternalAgentInput,
  ExternalAgentConfig,
  ExternalAgentStateIsolation,
} from "@/types/agent/external-agent"

/** What the person duplicating chose. */
export interface ExternalAgentDuplicateOptions {
  name: string
  /** Defaults to `isolated`: a copy is a separate configuration. */
  stateIsolation?: ExternalAgentStateIsolation
  /**
   * Whether the copy starts enabled. Defaults to the source's state, so
   * duplicating a switched-off configuration never produces a live one. The
   * caller decides whether to connect; a duplicate is never auto-connected.
   */
  enabled?: boolean
}

/** Metadata keys that describe one running instance, never a copy of it. */
const INSTANCE_ONLY_METADATA_KEYS = ["port", "serverPassword", "createdByPluginId"] as const

function copy<T>(value: T): T {
  return value === undefined ? value : structuredClone(value)
}

/**
 * Create input for a copy of `source`. Nested values are deep copies.
 *
 * The second argument may be a bare name for callers that only rename.
 */
export function externalAgentDuplicateInput(
  source: ExternalAgentConfig,
  options: ExternalAgentDuplicateOptions | string
): CreateExternalAgentInput {
  const { name, stateIsolation, enabled } =
    typeof options === "string" ? { name: options } : options
  const input: CreateExternalAgentInput = {
    name,
    protocol: source.protocol,
    transport: source.transport,
    stateIsolation: stateIsolation ?? "isolated",
    enabled: enabled ?? source.enabled,
    duplicatedFromAgentId: source.id,
  }
  const optional = {
    description: source.description,
    cogniaModel: source.cogniaModel,
    subscriptionAccountId: source.subscriptionAccountId,
    process: source.process,
    network: source.network,
    defaultPermissionMode: source.defaultPermissionMode,
    autoApprovePatterns: source.autoApprovePatterns,
    requireApprovalFor: source.requireApprovalFor,
    codexOptions: source.codexOptions,
    timeout: source.timeout,
    retryConfig: source.retryConfig,
    maxConcurrentSessions: source.maxConcurrentSessions,
    sessionIdleTimeout: source.sessionIdleTimeout,
    tags: source.tags,
    metadata: source.metadata,
    declaredCapabilities: source.declaredCapabilities,
  } satisfies Partial<CreateExternalAgentInput>
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined && value !== null) {
      ;(input as unknown as Record<string, unknown>)[key] = copy(value)
    }
  }

  if (input.metadata) {
    for (const key of INSTANCE_ONLY_METADATA_KEYS) delete input.metadata[key]
  }

  if (input.process?.env) {
    const owned = agentStateIsolationFor(input.process.command, input.process.args ?? [])
    if (owned) {
      for (const key of Object.keys(owned.env)) delete input.process.env[key]
    }
  }

  return input
}

/**
 * The env keys a copy dropped because the runtime's isolation rule owns them,
 * so the duplicate dialog can say so instead of changing behavior silently.
 */
export function duplicateDroppedEnvKeys(source: ExternalAgentConfig): string[] {
  const env = source.process?.env
  if (!env) return []
  const owned = agentStateIsolationFor(source.process!.command, source.process!.args ?? [])
  if (!owned) return []
  return Object.keys(env)
    .filter((key) => Object.hasOwn(owned.env, key))
    .sort()
}

/**
 * The first free copy name: "X (copy)", then "X (copy 2)", "X (copy 3)" ….
 *
 * `label` builds the localized name for an index (1 = the bare "(copy)" form).
 * Comparison ignores case and surrounding whitespace, because the runtime
 * picker and the local↔host pairing already treat those as the same name.
 */
export function uniqueDuplicateName(
  existingNames: Iterable<string>,
  label: (index: number) => string
): string {
  const taken = new Set(Array.from(existingNames, (name) => name.trim().toLowerCase()))
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = label(index)
    if (!taken.has(candidate.trim().toLowerCase())) return candidate
  }
  return label(10_000)
}
