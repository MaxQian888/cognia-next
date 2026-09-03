/**
 * Make this shell's agent manager hold exactly one host-owned configuration.
 *
 * Two callers need the same thing for different reasons, which is why the rule
 * lives here rather than inside either of them:
 *
 *   - **The run service** (`remote-run-service.ts`) mounts an admitted
 *     configuration so `manager.execute` has an agent to run the turn on. It
 *     runs on the machine that owns the process.
 *   - **The model picker** (`hooks/agent/use-external-agent-models.ts`) mounts
 *     the same configuration so it can read the agent's model catalog. On a
 *     browser paired to a headless Host that mount reaches the Host through
 *     the process plane, which is the only reason a tab can offer the picker
 *     at all.
 *
 * When both run in the same process, on a desktop that owns its own
 * host-config store, they share one mount. That is the point: a picker probe
 * must not spawn a rival agent beside the one a turn is running on.
 *
 * The agent id IS the configuration id. That is what makes the mount shared,
 * and it is also what lets a model chosen for a host-owned agent be persisted
 * under the same `externalAgentProviderId` marker the local lane uses.
 */

import type { ExternalAgentConfig } from "@/types/agent/external-agent"

import { getRemoteHostConfig } from "./remote-host-configs"

/** The slice of `ExternalAgentManager` a mount touches. */
export interface HostConfigMountManager {
  getAgent(agentId: string): unknown | undefined
  addAgent(config: ExternalAgentConfig, options?: { connect?: boolean }): Promise<unknown>
  removeAgent(agentId: string): Promise<void>
}

/** configId to the revision currently mounted on the manager. */
const mounted = new Map<string, string>()
/** configId to the mount in flight, so two callers cannot interleave a teardown. */
const mounting = new Map<string, Promise<string>>()

/** Test seam. Forgets every mount. */
export function resetHostConfigMountsForTests(): void {
  mounted.clear()
  mounting.clear()
}

/**
 * Make the manager hold exactly the given revision for this configuration.
 *
 * A revision change tears the agent down first: leaving the old one mounted
 * would run the previous command line under the new configuration's name,
 * which is the failure the revision check exists to prevent.
 *
 * Nothing here installs a runtime or a plugin. A run has already been admitted
 * by the time it calls this. If the adapter is missing at this point that is an
 * error to report, not a gap to fill.
 *
 * Mounts for one configuration are serialized (see {@link mountHostConfigAgent}):
 * the read of `mounted`, the teardown and the re-add are one critical section,
 * so two callers starting at once cannot both pass the `getAgent` check and
 * both call `addAgent`.
 */
async function mountExclusive(
  manager: HostConfigMountManager,
  configId: string,
  revision: string,
  config: ExternalAgentConfig
): Promise<string> {
  const agentId = configId
  const current = mounted.get(configId)
  if (current === revision && manager.getAgent(agentId)) return agentId

  // A revision change still tears the old agent down even when another run is
  // mid-turn on it: leaving it mounted would run the previous command line
  // under the new revision's name, which is the failure the revision check
  // exists to prevent, and losing a turn is the lesser harm. That run settles
  // as `failed` when its `execute` rejects.
  if (manager.getAgent(agentId)) {
    await manager.removeAgent(agentId)
    mounted.delete(configId)
  }
  await manager.addAgent({ ...config, id: agentId }, { connect: true })
  mounted.set(configId, revision)
  return agentId
}

/**
 * Serialize {@link mountExclusive} per configuration.
 *
 * Chained rather than locked so a caller never has to poll: each mount waits
 * for the previous one to finish before it reads `mounted`. A failed mount is
 * swallowed by the chain (`.catch`) so it does not poison the next caller's
 * turn. The failure is still returned to its own caller.
 */
export async function mountHostConfigAgent(
  manager: HostConfigMountManager,
  configId: string,
  revision: string,
  config: ExternalAgentConfig
): Promise<string> {
  const previous = mounting.get(configId)
  const next = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
    mountExclusive(manager, configId, revision, config)
  )
  mounting.set(configId, next)
  try {
    return await next
  } finally {
    // Only the tail clears the slot. A later mount already queued behind this
    // one owns it now.
    if (mounting.get(configId) === next) mounting.delete(configId)
  }
}

/** Injected so the catalog mount is testable without a manager or a host. */
export interface HostConfigCatalogDeps {
  readConfig: typeof getRemoteHostConfig
  getManager: () => Promise<HostConfigMountManager>
}

const defaultDeps: HostConfigCatalogDeps = {
  readConfig: getRemoteHostConfig,
  getManager: async () => {
    const { getExternalAgentManager } = await import("./manager")
    return getExternalAgentManager() as unknown as HostConfigMountManager
  },
}

let deps: HostConfigCatalogDeps = defaultDeps

/** Test seam. Returns a restore function. */
export function __setHostConfigMountDepsForTests(next: Partial<HostConfigCatalogDeps>): () => void {
  const previous = deps
  deps = { ...deps, ...next }
  return () => {
    deps = previous
  }
}

/**
 * Mount a host-owned configuration so its model catalog can be read.
 *
 * Returns the agent id, or `null` when the host has no such configuration.
 * That is an ordinary answer, not an error: a conversation can outlive the
 * configuration it was bound to, and the picker renders it as "nothing to
 * show" rather than as a failure.
 *
 * The revision comes from the host's own record rather than from the runtime
 * ref the conversation is carrying. The ref's stamp is what a RUN is admitted
 * against, deliberately, so an edit between the pick and the send is refused.
 * A catalog read has no such contract, and reading models out of a
 * configuration the host has since edited would list the wrong agent's models.
 */
export async function mountHostConfigForCatalog(configId: string): Promise<string | null> {
  const record = await deps.readConfig(configId)
  if (!record) return null
  const manager = await deps.getManager()
  return mountHostConfigAgent(
    manager,
    record.configId,
    record.revision,
    record.config as unknown as ExternalAgentConfig
  )
}
