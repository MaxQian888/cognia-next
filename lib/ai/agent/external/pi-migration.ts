/**
 * Migration between the legacy `pi-acp` bridge and the native `pi-rpc` adapter
 * (ADR-0119).
 *
 * Two properties drive every decision here:
 *
 *   - **The agent id must survive.** Teams, the scheduler and any live runtime
 *     reference an agent by id, so migration rewrites the config IN PLACE
 *     rather than creating a replacement and deleting the original. A
 *     create-then-delete would silently orphan every one of those references.
 *   - **It must be reversible.** The pre-migration protocol/process/preset is
 *     captured in a versioned `metadata.piMigration` snapshot so a rollback
 *     restores exactly what was there, not a reconstruction from defaults.
 *
 * Rollback deliberately restores ONLY the adapter config. Pi session files and
 * any Cognia transcripts produced while running natively are left alone —
 * they are user data, and deleting them to "undo" a config change would be a
 * far worse surprise than an unused session.
 */

import type { ExternalAgentConfig } from "@/types/agent/external-agent"

import { EXTERNAL_AGENT_PRESETS } from "./presets"

/** Current shape of the `metadata.piMigration` snapshot. */
export const PI_MIGRATION_SNAPSHOT_VERSION = 1

export interface PiMigrationSnapshot {
  version: number
  /** ISO timestamp, supplied by the caller so this module stays pure. */
  migratedAt: string
  from: {
    protocol: string
    preset?: string
    process?: { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
    ecosystemAdapterId?: string
    ecosystemSurfaceId?: string
    ecosystemSupportTier?: string
    ecosystemDocsUrl?: string
  }
}

/**
 * Is this config the legacy community ACP bridge?
 *
 * All three conditions are required. Any one alone produces false positives
 * that would rewrite a config the user meant to keep:
 *
 *   - `metadata.preset === "pi"` alone also matches a config someone re-pointed
 *     at a different command while keeping the preset label;
 *   - `protocol === "acp"` alone matches every other ACP agent;
 *   - the `pi-acp` argv alone matches a hand-built custom agent that the user
 *     may have deliberately configured outside the preset system.
 */
export function isLegacyPiAcpAgent(config: ExternalAgentConfig): boolean {
  if (config.metadata?.preset !== "pi") return false
  if (config.protocol !== "acp") return false

  const command = config.process?.command?.trim().toLowerCase()
  if (command !== "npx") return false

  // `npx -y pi-acp` — find the first non-flag argument, exactly as the spawn
  // allowlist does, so detection and execution agree on what "the package" is.
  const pkg = (config.process?.args ?? []).find((arg) => !arg.startsWith("-"))
  return pkg === "pi-acp"
}

/** Has this config already been migrated (and can therefore be rolled back)? */
export function isMigratedPiAgent(config: ExternalAgentConfig): boolean {
  return readMigrationSnapshot(config) !== null
}

/** Read and validate the rollback snapshot, or null when there is none. */
export function readMigrationSnapshot(config: ExternalAgentConfig): PiMigrationSnapshot | null {
  const raw = config.metadata?.piMigration
  if (!raw || typeof raw !== "object") return null
  const snapshot = raw as Partial<PiMigrationSnapshot>
  // An unknown future version is not rolled back by guesswork — a snapshot we
  // cannot read is worse than no rollback offer at all.
  if (snapshot.version !== PI_MIGRATION_SNAPSHOT_VERSION) return null
  if (!snapshot.from || typeof snapshot.from.protocol !== "string") return null
  return snapshot as PiMigrationSnapshot
}

export interface PiMigrationResult {
  config: ExternalAgentConfig
  snapshot: PiMigrationSnapshot
}

/**
 * Rewrite a legacy `pi-acp` config onto the native adapter, in place.
 *
 * Everything the user chose that is not protocol-specific — name, enabled
 * state, permission mode, timeout, retry policy, tags, description — is
 * carried over untouched. Only the transport-shaped fields change.
 */
export function migrateToPiRpc(
  config: ExternalAgentConfig,
  options: { now?: () => Date } = {}
): PiMigrationResult {
  if (!isLegacyPiAcpAgent(config)) {
    throw new Error(`Agent ${config.id} is not a legacy pi-acp configuration`)
  }

  const preset = EXTERNAL_AGENT_PRESETS["pi-rpc"]
  if (!preset) throw new Error("The pi-rpc preset is unavailable")

  const metadata = config.metadata ?? {}
  const snapshot: PiMigrationSnapshot = {
    version: PI_MIGRATION_SNAPSHOT_VERSION,
    migratedAt: (options.now?.() ?? new Date()).toISOString(),
    from: {
      protocol: config.protocol,
      preset: typeof metadata.preset === "string" ? metadata.preset : undefined,
      ...(config.process ? { process: { ...config.process } } : {}),
      ...pickEcosystem(metadata),
    },
  }

  return {
    snapshot,
    config: {
      ...config,
      protocol: "pi-rpc",
      transport: preset.transport,
      process: {
        ...config.process,
        command: preset.process?.command ?? "pi",
        args: [...(preset.process?.args ?? [])],
      },
      metadata: {
        ...metadata,
        preset: "pi-rpc",
        ecosystemAdapterId: preset.adapterId,
        ecosystemSurfaceId: preset.surfaceId,
        ecosystemSupportTier: preset.supportTier,
        ecosystemDocsUrl: preset.docsUrl,
        piMigration: snapshot,
      },
    },
  }
}

/**
 * Restore the pre-migration adapter config.
 *
 * Returns null when there is nothing to roll back, so callers can hide the
 * control rather than offering an action that would do nothing.
 */
export function rollbackPiRpcMigration(config: ExternalAgentConfig): ExternalAgentConfig | null {
  const snapshot = readMigrationSnapshot(config)
  if (!snapshot) return null

  const metadata = { ...(config.metadata ?? {}) }
  delete metadata.piMigration

  return {
    ...config,
    protocol: snapshot.from.protocol as ExternalAgentConfig["protocol"],
    transport: "stdio",
    ...(snapshot.from.process ? { process: { ...snapshot.from.process } } : {}),
    metadata: {
      ...metadata,
      ...(snapshot.from.preset ? { preset: snapshot.from.preset } : {}),
      ecosystemAdapterId: snapshot.from.ecosystemAdapterId,
      ecosystemSurfaceId: snapshot.from.ecosystemSurfaceId,
      ecosystemSupportTier: snapshot.from.ecosystemSupportTier,
      ecosystemDocsUrl: snapshot.from.ecosystemDocsUrl,
    },
  }
}

function pickEcosystem(metadata: Record<string, unknown>) {
  const str = (key: string) => (typeof metadata[key] === "string" ? metadata[key] : undefined)
  return {
    ecosystemAdapterId: str("ecosystemAdapterId"),
    ecosystemSurfaceId: str("ecosystemSurfaceId"),
    ecosystemSupportTier: str("ecosystemSupportTier"),
    ecosystemDocsUrl: str("ecosystemDocsUrl"),
  }
}

// ============================================================================
// Readiness
// ============================================================================

export type PiMigrationBlocker =
  "runtime_version_unsupported" | "sandbox_unavailable" | "command_missing"

export interface PiMigrationReadiness {
  ready: boolean
  blockers: PiMigrationBlocker[]
}

/**
 * Decide whether migrating this host would produce a working agent.
 *
 * Checked BEFORE rewriting the config: migrating first and discovering the
 * binary is missing leaves the user with an agent that no longer runs and a
 * rollback they have to find. All inputs are supplied by the caller so this
 * stays pure and testable.
 */
export function evaluatePiMigrationReadiness(input: {
  commandAvailable: boolean
  versionStatus?: "certified" | "unverified" | "unsupported"
  sandboxReady: boolean
}): PiMigrationReadiness {
  const blockers: PiMigrationBlocker[] = []
  if (!input.commandAvailable) blockers.push("command_missing")
  // `unverified` is explicitly NOT a blocker — a newer Pi runs, with a warning.
  if (input.versionStatus === "unsupported") blockers.push("runtime_version_unsupported")
  if (!input.sandboxReady) blockers.push("sandbox_unavailable")
  return { ready: blockers.length === 0, blockers }
}
