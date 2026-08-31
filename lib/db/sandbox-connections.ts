import { getDb } from "./schema"
import {
  migrateSandboxConnectionRow,
  syncLegacySandboxMirrors,
} from "@/lib/sandbox/connection-migration"
import {
  defaultSandboxCapabilities,
  SANDBOX_CAPABILITY_REVISION,
} from "@/lib/sandbox/connection-capabilities"
import type {
  SandboxConnectionDriver,
  SandboxConnectionProvider,
  SandboxConnectionRow,
  SandboxHealthStatus,
  SandboxLifecycleState,
  SandboxProviderConfig,
} from "@/types/sandbox"

/**
 * Sandbox connection registry (ADR-0020 remote-target, extended by Epic 5).
 *
 * A `sandboxConnection` describes one sandbox machine: a local Docker
 * container, a cua.ai Cloud desktop, or a local Lume VM. Target selectors on
 * `Character` / `ChatSession` / workflow nodes reference a row by `id`.
 *
 * Since v143 the row carries a `provider` × `driver` split with a
 * provider-specific `config` (see `types/sandbox`). Reads run every row
 * through `migrateSandboxConnectionRow` so a database that has not yet taken
 * the v143 upgrade — or a row written by an older build during a downgrade
 * window — still returns the new shape. Writes refresh the deprecated
 * top-level mirrors so that downgrade window keeps working.
 *
 * Credentials are never stored here: `credentialRef` points into the OS
 * keyring. Nothing in this module reads or writes a secret.
 */

export type {
  SandboxConnectionDriver,
  SandboxConnectionProvider,
  SandboxConnectionRow,
  SandboxHealthStatus,
  SandboxLifecycleState,
  SandboxProviderConfig,
}

/**
 * @deprecated Pre-Epic-5 alias — `SandboxProvider` was Docker-only. Use
 * {@link SandboxConnectionProvider}.
 */
export type SandboxProvider = SandboxConnectionProvider

/** Newest-first by `createdAt`, migrated on read. */
export async function listSandboxConnections(): Promise<SandboxConnectionRow[]> {
  const rows = await getDb().sandboxConnections.toArray()
  return rows.map(migrateSandboxConnectionRow).sort((a, b) => b.createdAt - a.createdAt)
}

/** Only the connections for one provider, newest-first. */
export async function listSandboxConnectionsByProvider(
  provider: SandboxConnectionProvider
): Promise<SandboxConnectionRow[]> {
  const rows = await listSandboxConnections()
  return rows.filter((row) => row.provider === provider)
}

export async function getSandboxConnection(id: string): Promise<SandboxConnectionRow | undefined> {
  const row = await getDb().sandboxConnections.get(id)
  return row ? migrateSandboxConnectionRow(row) : undefined
}

/** Upsert, refreshing the deprecated legacy mirrors from `config`. */
export async function putSandboxConnection(row: SandboxConnectionRow): Promise<void> {
  await getDb().sandboxConnections.put(syncLegacySandboxMirrors(row))
}

export async function deleteSandboxConnection(id: string): Promise<void> {
  await getDb().sandboxConnections.delete(id)
}

/**
 * Build a new connection row with the default capability matrix for its
 * provider/driver pair. `state` starts at `"uninitialized"` — nothing has been
 * created on the provider side yet.
 */
export function createSandboxConnectionRow(input: {
  id: string
  name: string
  driver: SandboxConnectionDriver
  config: SandboxProviderConfig
  credentialRef?: SandboxConnectionRow["credentialRef"]
  now: number
}): SandboxConnectionRow {
  const provider = input.config.provider
  return syncLegacySandboxMirrors({
    id: input.id,
    name: input.name,
    provider,
    driver: input.driver,
    config: input.config,
    state: "uninitialized",
    capabilities: defaultSandboxCapabilities(provider, input.driver),
    capabilitiesRevision: SANDBOX_CAPABILITY_REVISION,
    ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
    lastHealthStatus: "unknown",
    createdAt: input.now,
    updatedAt: input.now,
  })
}

/**
 * Patch the lifecycle state (and optionally the config the provider handed
 * back, e.g. an assigned instance id or discovered port). No-op when the row
 * is gone — a connection deleted mid-transition must not be resurrected.
 */
export async function updateSandboxConnectionState(
  id: string,
  patch: {
    state?: SandboxLifecycleState
    config?: SandboxProviderConfig
    capabilities?: SandboxConnectionRow["capabilities"]
    lastHealthStatus?: SandboxHealthStatus
    lastHealthError?: string | null
    lastHealthCheckAt?: number
    now: number
  }
): Promise<SandboxConnectionRow | undefined> {
  const existing = await getSandboxConnection(id)
  if (!existing) return undefined

  const next: SandboxConnectionRow = {
    ...existing,
    ...(patch.state !== undefined ? { state: patch.state } : {}),
    ...(patch.config !== undefined ? { config: patch.config } : {}),
    ...(patch.capabilities !== undefined ? { capabilities: patch.capabilities } : {}),
    ...(patch.lastHealthStatus !== undefined ? { lastHealthStatus: patch.lastHealthStatus } : {}),
    ...(patch.lastHealthCheckAt !== undefined
      ? { lastHealthCheckAt: patch.lastHealthCheckAt }
      : {}),
    updatedAt: patch.now,
  }
  // `null` clears the error; `undefined` leaves it alone.
  if (patch.lastHealthError === null) delete next.lastHealthError
  else if (patch.lastHealthError !== undefined) next.lastHealthError = patch.lastHealthError

  await putSandboxConnection(next)
  return next
}
