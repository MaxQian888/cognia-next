/**
 * Duplicate an external-agent configuration.
 *
 * Several configurations of one runtime (a read-only Codex next to a
 * workspace-write one, the same CLI bound to two models) are separate configs,
 * so "make another like this one" is a copy of everything the user configured.
 * What describes the copy's own history is left behind:
 *
 *   - identity and timestamps (the store mints new ones);
 *   - the validity snapshot, negotiated capabilities and registry provenance,
 *     which record what was observed for the source, not what was configured;
 *   - lifecycle state, including unsandboxed-launch consent: consent covers one
 *     agent, and the copy has to be approved in its own right.
 *
 * Credentials are not part of the config (they live in the keyring under the
 * source's id); `ExternalAgentLifecycleService.duplicateConfig` copies them
 * into the new agent's own keyring slots.
 */

import type { CreateExternalAgentInput, ExternalAgentConfig } from "@/types/agent/external-agent"

function copy<T>(value: T): T {
  return value === undefined ? value : structuredClone(value)
}

/** Create input for a copy of `source` named `name`. Nested values are deep copies. */
export function externalAgentDuplicateInput(
  source: ExternalAgentConfig,
  name: string
): CreateExternalAgentInput {
  const input: CreateExternalAgentInput = {
    name,
    protocol: source.protocol,
    transport: source.transport,
  }
  const optional = {
    description: source.description,
    cogniaModel: source.cogniaModel,
    process: source.process,
    network: source.network,
    defaultPermissionMode: source.defaultPermissionMode,
    autoApprovePatterns: source.autoApprovePatterns,
    requireApprovalFor: source.requireApprovalFor,
    codexOptions: source.codexOptions,
    timeout: source.timeout,
    retryConfig: source.retryConfig,
    tags: source.tags,
    metadata: source.metadata,
    declaredCapabilities: source.declaredCapabilities,
  } satisfies Partial<CreateExternalAgentInput>
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) (input as unknown as Record<string, unknown>)[key] = copy(value)
  }
  return input
}
