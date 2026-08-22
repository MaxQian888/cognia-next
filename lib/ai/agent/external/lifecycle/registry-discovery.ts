/**
 * ACP Registry discovery, connected to the lifecycle plane.
 *
 * The registry client has always been careful — exact package versions, https
 * archives, mandatory checksums, traversal refusal, explicit user confirmation.
 * What it lacked was anyone to call it: `createConfirmedRegistryAgentConfig`
 * requires a binary already installed by "the verified native installer", and
 * no installer produced one. Discovery was therefore a dormant capability
 * rather than an operating lifecycle.
 *
 * This is the bridge. A registry entry becomes one of exactly two things:
 *
 *  - **managed** — a binary distribution with an https archive and a SHA-256,
 *    which the binary provider can stage, verify, health-check and activate
 *    into a receipt like any other managed runtime;
 *  - **user-managed** — anything else. `npx`/`uvx` entries name an exact
 *    version but there is no Cognia-approved frozen lock for an arbitrary
 *    registry package, so installing one would mean resolving a dependency
 *    tree at install time. Those are surfaced as discovery with a handoff, not
 *    as something Cognia installs.
 *
 * The split is the whole point. Presenting an unpinnable entry as installable
 * is how a governed installer quietly becomes an ungoverned one.
 *
 * @see ../acp-registry.ts for validation and distribution resolution
 */

import {
  ACP_REGISTRY_URL,
  fetchAcpRegistry,
  resolveAcpRegistryDistribution,
  type AcpRegistryAgent,
} from "../acp-registry"
import type {
  ExternalAgentBinaryDistribution,
  ExternalAgentRuntimeCatalogEntry,
} from "@/types/agent/external-agent-lifecycle"

/** Why a registry entry cannot be Cognia-installed. */
export type RegistryUnmanagedReason =
  "no-approved-lock" | "no-distribution-for-platform" | "invalid-distribution"

/** One registry entry, classified. */
export type RegistryDiscovery =
  | {
      kind: "managed"
      agent: AcpRegistryAgent
      runtimeId: string
      distribution: ExternalAgentBinaryDistribution
    }
  | {
      kind: "user-managed"
      agent: AcpRegistryAgent
      runtimeId: string
      reason: RegistryUnmanagedReason
      /** Non-localized detail for logs; UI text is keyed on `reason`. */
      detail: string
      /** Where the user goes to install it themselves, when the entry says. */
      docsUrl?: string
    }

/** Runtime id for a registry-discovered agent, namespaced so it cannot collide. */
export function registryRuntimeId(agentId: string): string {
  return `registry:${agentId}`
}

/**
 * Classify one registry entry for one platform.
 *
 * Never throws: a malformed entry is a `user-managed` result with a reason, so
 * one bad row in the registry cannot take the whole listing down.
 */
export function classifyRegistryAgent(
  agent: AcpRegistryAgent,
  platformKey: string
): RegistryDiscovery {
  const runtimeId = registryRuntimeId(agent.id)
  const docsUrl = agent.website ?? agent.repository

  let resolved
  try {
    resolved = resolveAcpRegistryDistribution(agent, platformKey)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      kind: "user-managed",
      agent,
      runtimeId,
      reason: detail.includes("no distribution")
        ? "no-distribution-for-platform"
        : "invalid-distribution",
      detail,
      docsUrl,
    }
  }

  if (resolved.kind !== "binary") {
    return {
      kind: "user-managed",
      agent,
      runtimeId,
      reason: "no-approved-lock",
      detail:
        `${agent.id} distributes via ${resolved.kind}, and Cognia has no approved frozen ` +
        `lock for it — installing would resolve a dependency tree at install time`,
      docsUrl,
    }
  }

  return {
    kind: "managed",
    agent,
    runtimeId,
    distribution: {
      provider: "binary",
      version: agent.version,
      args: resolved.args,
      artifacts: [
        {
          platformKey,
          url: resolved.archive,
          integrity: { sha256: resolved.checksum },
          // The registry ships archives; a bare executable would have no
          // `archive` field to resolve in the first place.
          archive: resolved.archive.endsWith(".zip") ? "zip" : "tar.gz",
          entrypoint: resolved.executable,
        },
      ],
    },
  }
}

/**
 * Build a catalog entry for a managed registry discovery.
 *
 * Deliberately carries no `supportedRange` and no `certifiedVersions`: Cognia
 * has certified nothing about a third-party registry entry. Under the version
 * policy that resolves to `supported-uncertified`, so running it takes one
 * explicit consent — which is the honest answer, not a silent pass.
 */
export function registryCatalogEntry(
  discovery: Extract<RegistryDiscovery, { kind: "managed" }>,
  platforms: string[]
): ExternalAgentRuntimeCatalogEntry {
  return {
    runtimeId: discovery.runtimeId,
    presetIds: [],
    displayName: discovery.agent.name,
    ownership: "managed",
    protocol: "acp",
    transport: "stdio",
    platforms,
    versionProbe: { args: ["--version"], parser: "semver-anywhere", timeoutMs: 15000 },
    distributions: [discovery.distribution],
    sandbox: { required: true, windowsExceptionEligible: false },
    docsUrl: discovery.agent.website ?? discovery.agent.repository,
  }
}

export interface RegistryDiscoveryResult {
  /** Source the listing came from, shown alongside the results. */
  sourceUrl: string
  /** Registry catalog version, for provenance. */
  registryVersion: string
  entries: RegistryDiscovery[]
}

/**
 * Fetch and classify the whole registry for this platform.
 *
 * A fetch failure propagates: an empty listing and an unreachable registry look
 * identical to a user, and silently showing "no agents available" for a network
 * error is the kind of quiet degradation that never gets reported.
 */
export async function discoverRegistryAgents(options: {
  platformKey: string
  /** Injected for tests; production uses the module's proxy-aware default. */
  fetcher?: typeof fetch
}): Promise<RegistryDiscoveryResult> {
  const catalog = await fetchAcpRegistry(options.fetcher ? { fetcher: options.fetcher } : {})
  return {
    sourceUrl: ACP_REGISTRY_URL,
    registryVersion: catalog.version,
    entries: catalog.agents.map((agent) => classifyRegistryAgent(agent, options.platformKey)),
  }
}

/** Split a listing into what Cognia can install and what it can only point at. */
export function partitionDiscoveries(entries: readonly RegistryDiscovery[]): {
  managed: Extract<RegistryDiscovery, { kind: "managed" }>[]
  userManaged: Extract<RegistryDiscovery, { kind: "user-managed" }>[]
} {
  const managed: Extract<RegistryDiscovery, { kind: "managed" }>[] = []
  const userManaged: Extract<RegistryDiscovery, { kind: "user-managed" }>[] = []
  for (const entry of entries) {
    if (entry.kind === "managed") managed.push(entry)
    else userManaged.push(entry)
  }
  return { managed, userManaged }
}
