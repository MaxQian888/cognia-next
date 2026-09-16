/**
 * Where a run's placement waits for its spawn (ADR-0182).
 *
 * The placement is a property of the *run*: which project, which approval,
 * which resolution. The spawn config is a property of the *agent*, and it is
 * persisted in Dexie. Putting the placement on the config would store a
 * per-run decision as agent configuration, so instead the caller that resolved
 * the environment leaves it here under the agent id it is about to spawn, and
 * `agentInvoke` picks it up on the way past.
 *
 * # Why one registry instead of a parameter on every client
 *
 * Seven code paths build a `spawn_external_agent` payload — ACP, Pi, OpenCode
 * v2, DSH, and three more. Every one of them goes through `agentInvoke`, so
 * one lookup there covers all of them and no runtime can silently lose its
 * placement by being the one that was not updated. Threading an argument
 * through each client instead would have to change a protocol-adapter
 * interface every runtime implements, for a value only the spawn reads.
 *
 * # Current, not one-shot
 *
 * An external agent's process outlives a run: the manager respawns it after a
 * crash, a reconnect, or a retried connect, and none of those resolve the
 * environment again. A placement that was consumed by the first spawn would
 * let every one of those respawns start on the host, unsandboxed, with
 * nothing to say so. So the registry holds the agent's CURRENT placement and
 * every spawn of that agent carries it until {@link registerSpawnPlacement}
 * replaces it or {@link clearSpawnPlacement} removes it. The Host re-admits
 * each spawn against the approval ledger, so a revocation still refuses the
 * next one — which is the authority, and this registry never was.
 *
 * # What each process was actually started with
 *
 * {@link spawnedPlacementDigest} answers whether a running process matches the
 * current resolution, so a caller can restart an agent whose project changed
 * environment under it rather than keep running the old one.
 *
 * # The off path must not be able to notice this exists
 *
 * With nothing ever registered, {@link withSpawnPlacement} returns the
 * caller's own object after one size check — the same reference, so no key is
 * added, no key is reordered, and the payload is byte-for-byte what it was
 * before runtime environments existed (Q39).
 */

import type { SandboxPlacement } from "@/types/sandbox/environment-spec"

/**
 * Current placements by agent id.
 *
 * Module-scoped rather than a class instance because the spawn seam is a free
 * function on both hosts and has no object to hang state from — the same
 * arrangement `spawn-reclaim.ts` uses for in-flight spawn ids.
 */
const current = new Map<string, SandboxPlacement>()

/**
 * The spec digest each process id was last spawned with; `null` for a spawn
 * that carried no placement. Only written once the feature has been used in
 * this realm, so the off path records nothing.
 */
const spawned = new Map<string, string | null>()

/**
 * Set the placement every later spawn of `agentId` carries.
 *
 * Idempotent and last-write-wins: a new run resolves the environment again,
 * and the newer resolution is the one that should run.
 */
export function registerSpawnPlacement(agentId: string, placement: SandboxPlacement): void {
  current.set(agentId, placement)
}

/**
 * Stop placing `agentId`.
 *
 * Called when a resolution does not place — off, fallback or refused — so a
 * later spawn cannot inherit an earlier resolution's authority, possibly one
 * made for a different project.
 */
export function clearSpawnPlacement(agentId: string): void {
  current.delete(agentId)
}

/** The placement a spawn of exactly `agentId` would carry now. */
export function spawnPlacementFor(agentId: string): SandboxPlacement | undefined {
  return current.get(agentId)
}

/**
 * The spec digest the process `processId` was last spawned with.
 *
 * `null`: it was spawned on the host. `undefined`: no spawn of it has passed
 * through since the feature was first used here — which, for a process that is
 * running, also means the host.
 */
export function spawnedPlacementDigest(processId: string): string | null | undefined {
  return spawned.get(processId)
}

/** Agents with a current placement, for tests and diagnostics. */
export function pendingSpawnPlacementIds(): string[] {
  return [...current.keys()]
}

/** Drop every placement and every spawn record. Tests only. */
export function __resetSpawnPlacementsForTests(): void {
  current.clear()
  spawned.clear()
}

/**
 * The placement a session-scoped process runs under.
 *
 * Pi starts one process per session, named `<agentId>:<sessionId>`
 * (`pi-rpc-client.ts`), so no spawn ever carries the bare agent id the run was
 * placed under. Matching on the `<agentId>:` prefix is not a guess about a
 * malformed id — it is that one documented naming rule — and the longest
 * registered prefix wins, so an agent id that itself contains a `:` still
 * resolves to its own placement rather than a shorter neighbour's.
 *
 * Pi's capability probes (`<agentId>:<label>-probe:<ts>`) match too, and
 * should: in a sandbox the Pi that runs is the agent bundle's, so a probe run
 * on the host would describe a Pi the session never uses.
 */
function sessionPlacement(processId: string): SandboxPlacement | undefined {
  let owner: string | undefined
  for (const agentId of current.keys()) {
    if (processId.startsWith(`${agentId}:`) && (!owner || agentId.length > owner.length)) {
      owner = agentId
    }
  }
  return owner === undefined ? undefined : current.get(owner)
}

/**
 * The `spawn_external_agent` arguments with this agent's placement attached.
 *
 * Returns `args` itself when there is nothing to attach, which is what keeps
 * the off path identical: a caller on a deployment with no runtime
 * environments hands the same object to the transport that it built.
 *
 * The process id is read from `args.config.id`, which is where every spawn
 * site puts it; an exact match wins over a session-scoped one. Arguments that
 * do not have that shape are returned untouched — a malformed spawn is the
 * Host's to refuse, and inventing an id here would attach a placement to the
 * wrong run.
 */
export function withSpawnPlacement(args: Record<string, unknown>): Record<string, unknown> {
  if (current.size === 0 && spawned.size === 0) return args
  const config = args.config
  if (typeof config !== "object" || config === null) return args
  const id = (config as { id?: unknown }).id
  if (typeof id !== "string" || id === "") return args
  const placement = current.get(id) ?? sessionPlacement(id)
  spawned.set(id, placement?.spec.specDigest ?? null)
  if (!placement) return args
  return { ...args, config: { ...(config as Record<string, unknown>), sandbox: placement } }
}
