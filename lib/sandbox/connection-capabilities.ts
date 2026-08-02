/**
 * Default capability matrix per provider/driver pair.
 *
 * A capability is a contract, not a hint. `lib/sandbox/lifecycle-contract.ts`
 * refuses an unsupported operation with a typed error instead of letting it
 * fall through to the host — the failure mode this replaces is the worst one
 * available: the model asks for an action "in the sandbox", the sandbox cannot
 * do it, and the action silently runs on the user's real desktop.
 *
 * The matrix is stored on each connection row rather than recomputed at call
 * time so an adapter can narrow it after handshake (e.g. a cua-driver that
 * reports an older protocol loses `gui`), and so the UI can grey out controls
 * without probing.
 */

import type {
  SandboxCapabilities,
  SandboxConnectionDriver,
  SandboxConnectionProvider,
  SandboxLifecycleOperation,
} from "@/types/sandbox"

/** Every operation, in a stable order for iteration and display. */
export const SANDBOX_LIFECYCLE_OPERATIONS: readonly SandboxLifecycleOperation[] = [
  "create",
  "connect",
  "start",
  "suspend",
  "resume",
  "stop",
  "delete",
  "health",
  "gui",
  "workspaceRead",
  "workspaceExec",
]

function caps(overrides: Partial<Record<SandboxLifecycleOperation, boolean>>): SandboxCapabilities {
  const base = {} as Record<SandboxLifecycleOperation, boolean>
  for (const op of SANDBOX_LIFECYCLE_OPERATIONS) base[op] = false
  return Object.freeze({ ...base, ...overrides })
}

/**
 * Provider capabilities before the driver narrows them.
 *
 * - **docker** — local containers start/stop/delete cheaply but have no
 *   suspend/resume: a stopped container is not a suspended machine, and
 *   pretending otherwise would lose the desktop session silently.
 * - **cua-cloud** — full managed lifecycle including suspend/resume, which is
 *   the point of a cloud desktop (you pause it instead of paying for idle).
 * - **lume** — full local VM lifecycle; suspend/resume is a real VM snapshot.
 */
const PROVIDER_CAPABILITIES: Record<SandboxConnectionProvider, SandboxCapabilities> = {
  docker: caps({
    create: true,
    connect: true,
    start: true,
    stop: true,
    delete: true,
    health: true,
    gui: true,
    workspaceRead: true,
    workspaceExec: true,
  }),
  "cua-cloud": caps({
    create: true,
    connect: true,
    start: true,
    suspend: true,
    resume: true,
    stop: true,
    delete: true,
    health: true,
    gui: true,
    workspaceRead: true,
    workspaceExec: true,
  }),
  lume: caps({
    create: true,
    connect: true,
    start: true,
    suspend: true,
    resume: true,
    stop: true,
    delete: true,
    health: true,
    gui: true,
    workspaceRead: true,
    workspaceExec: true,
  }),
}

/**
 * Operations a driver cannot carry, whatever the provider supports. Absent
 * from this map means "carries everything the provider offers".
 *
 * `computer-server` speaks GUI and exec but has no file-read channel of its
 * own — workspace reads go through the exec channel, so it is exposed as
 * `workspaceRead: false` and callers use `workspaceExec`.
 */
const DRIVER_RESTRICTIONS: Partial<
  Record<SandboxConnectionDriver, Partial<Record<SandboxLifecycleOperation, boolean>>>
> = {
  "computer-server": { workspaceRead: false },
}

/**
 * The effective capability set for a provider/driver pair: the provider's
 * matrix, with the driver's restrictions applied. A driver can only ever
 * remove a capability, never add one.
 */
export function defaultSandboxCapabilities(
  provider: SandboxConnectionProvider,
  driver: SandboxConnectionDriver
): SandboxCapabilities {
  const base = PROVIDER_CAPABILITIES[provider]
  const restrictions = DRIVER_RESTRICTIONS[driver]
  if (!restrictions) return base
  const merged = { ...base } as Record<SandboxLifecycleOperation, boolean>
  for (const [op, allowed] of Object.entries(restrictions)) {
    if (allowed === false) merged[op as SandboxLifecycleOperation] = false
  }
  return Object.freeze(merged)
}

/**
 * Narrow an existing capability set — used after a handshake reveals the peer
 * supports less than the defaults promised. Never widens.
 */
export function narrowSandboxCapabilities(
  current: SandboxCapabilities,
  remove: readonly SandboxLifecycleOperation[]
): SandboxCapabilities {
  const next = { ...current } as Record<SandboxLifecycleOperation, boolean>
  for (const op of remove) next[op] = false
  return Object.freeze(next)
}

/** Does this capability set permit `operation`? */
export function supportsSandboxOperation(
  capabilities: SandboxCapabilities,
  operation: SandboxLifecycleOperation
): boolean {
  return capabilities[operation] === true
}
