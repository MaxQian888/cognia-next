/**
 * Pure, idempotent migration from the pre-Epic-5 Docker-only sandbox
 * connection row to the provider/driver shape.
 *
 * Kept separate from the Dexie upgrade callback so the mapping can be tested
 * without a database, and so re-running it over an already-migrated row is a
 * no-op — the upgrade callback may run again after a downgrade/upgrade cycle,
 * and a second pass must not clobber a `config` the user has since edited.
 *
 * The four legacy fields (`image`/`host`/`port`/`containerId`) are dual-written
 * for one compatibility release: a downgrade to the previous build still finds
 * a working Docker row instead of a connection it cannot read. New code reads
 * `config` only.
 */

import type {
  LegacySandboxConnectionRow,
  SandboxConnectionDriver,
  SandboxConnectionProvider,
  SandboxConnectionRow,
  SandboxLifecycleState,
  SandboxProviderConfig,
} from "@/types/sandbox"
import { defaultSandboxCapabilities } from "./connection-capabilities"

/** Driver every pre-Epic-5 row implicitly used. */
export const LEGACY_SANDBOX_DRIVER: SandboxConnectionDriver = "computer-server"

/** Image a legacy row falls back to when its `image` is missing or blank. */
export const LEGACY_SANDBOX_IMAGE = "ghcr.io/trycua/cua-xfce:latest"

/**
 * A row is already migrated when it carries a `config` discriminated by the
 * same provider. Checking the discriminant (not just presence) means a row
 * half-written by an interrupted upgrade is re-migrated rather than trusted.
 */
export function isMigratedSandboxConnection(
  row: Partial<SandboxConnectionRow>
): row is SandboxConnectionRow {
  const config = row.config as SandboxProviderConfig | undefined
  return (
    !!config &&
    typeof config === "object" &&
    !!row.provider &&
    config.provider === row.provider &&
    !!row.driver &&
    !!row.capabilities &&
    !!row.state
  )
}

/**
 * Infer the lifecycle state of a legacy row from what it recorded. A legacy
 * row has no state field, so it is reconstructed conservatively: a container id
 * plus a healthy probe means `running`; a container id alone means `stopped`;
 * no container id means the machine was never created.
 */
export function inferLegacyLifecycleState(
  row: Pick<LegacySandboxConnectionRow, "containerId" | "lastHealthStatus">
): SandboxLifecycleState {
  if (!row.containerId) return "uninitialized"
  switch (row.lastHealthStatus) {
    case "ok":
      return "running"
    case "starting":
      return "starting"
    case "error":
      return "error"
    // `unreachable` and `unknown` both mean "we cannot claim it is running".
    default:
      return "stopped"
  }
}

/**
 * Map one legacy row onto the new shape. Idempotent: an already-migrated row is
 * returned unchanged, so the upgrade callback is safe to re-run.
 */
export function migrateSandboxConnectionRow(
  row: LegacySandboxConnectionRow | SandboxConnectionRow
): SandboxConnectionRow {
  if (isMigratedSandboxConnection(row)) return normalizeStoredCapabilities(row)

  const legacy = row as LegacySandboxConnectionRow
  const provider: SandboxConnectionProvider = "docker"
  const driver = LEGACY_SANDBOX_DRIVER
  const image = legacy.image?.trim() || LEGACY_SANDBOX_IMAGE
  const host = legacy.host?.trim() || "127.0.0.1"
  const port = typeof legacy.port === "number" ? legacy.port : 0

  const config: SandboxProviderConfig = {
    provider,
    image,
    host,
    port,
    ...(legacy.containerId ? { containerId: legacy.containerId } : {}),
  }

  return {
    id: legacy.id,
    name: legacy.name,
    provider,
    driver,
    config,
    state: inferLegacyLifecycleState(legacy),
    capabilities: defaultSandboxCapabilities(provider, driver),
    lastHealthStatus: legacy.lastHealthStatus ?? "unknown",
    ...(legacy.lastHealthError !== undefined ? { lastHealthError: legacy.lastHealthError } : {}),
    ...(legacy.lastHealthCheckAt !== undefined
      ? { lastHealthCheckAt: legacy.lastHealthCheckAt }
      : {}),
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
    // Dual-write for one compatibility release.
    image,
    host,
    port,
    ...(legacy.containerId ? { containerId: legacy.containerId } : {}),
  }
}

/**
 * Existing rows may persist capabilities from an older optimistic matrix.
 * Reads may only narrow those claims; they never widen an adapter handshake.
 */
function normalizeStoredCapabilities(row: SandboxConnectionRow): SandboxConnectionRow {
  const supported = defaultSandboxCapabilities(row.provider, row.driver)
  const capabilities = Object.freeze(
    Object.fromEntries(
      Object.entries(row.capabilities).map(([operation, enabled]) => [
        operation,
        enabled && supported[operation as keyof typeof supported],
      ])
    )
  ) as SandboxConnectionRow["capabilities"]
  if (
    Object.entries(capabilities).every(
      ([operation, enabled]) => row.capabilities[operation as keyof typeof capabilities] === enabled
    )
  ) {
    return row
  }
  return {
    ...row,
    capabilities,
  }
}

/**
 * Refresh the deprecated mirrors from `config` so a downgrade keeps working
 * after a new-code write. Docker-only: a cloud or Lume row has no meaningful
 * legacy projection, and inventing one would make the old build try to
 * `docker start` a machine that is not a container. Those rows are left
 * without mirrors — the old build ignores providers it does not know.
 */
export function syncLegacySandboxMirrors(row: SandboxConnectionRow): SandboxConnectionRow {
  // Drop every mirror first: spreading `row` would otherwise carry a stale
  // `containerId` forward after the container was removed, and the old build
  // would try to start a container that no longer exists.
  const { image: _i, host: _h, port: _p, containerId: _c, ...rest } = row
  if (rest.config.provider !== "docker") return rest
  return {
    ...rest,
    image: rest.config.image,
    host: rest.config.host,
    port: rest.config.port,
    ...(rest.config.containerId ? { containerId: rest.config.containerId } : {}),
  }
}

/**
 * Migrate a whole table's worth of rows. Returns the migrated rows plus how
 * many actually changed, so the upgrade callback can skip a no-op write.
 */
export function migrateSandboxConnectionRows(
  rows: readonly (LegacySandboxConnectionRow | SandboxConnectionRow)[]
): { rows: SandboxConnectionRow[]; changed: number } {
  let changed = 0
  const migrated = rows.map((row) => {
    const next = migrateSandboxConnectionRow(row)
    if (next !== row) changed++
    return next
  })
  return { rows: migrated, changed }
}
