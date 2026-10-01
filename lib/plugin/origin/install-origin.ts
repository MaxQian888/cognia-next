/**
 * Install origins (ADR-0209): where an installed plugin came from, pinned to
 * what was actually installed.
 *
 * Every install path calls {@link recordInstallOrigin} once the install has
 * committed. The record is what makes a cogset exportable: a reproducible
 * origin becomes a reference in the cogpack, and anything else is embedded.
 *
 * Recording never fails an install. A plugin that is installed but whose
 * origin could not be written still works; it simply exports as embedded,
 * which is safe. The failure is logged so it is not invisible.
 */

import { loggers } from "@cognia/logging"

import { putInstallOrigin } from "@/lib/db/plugin-install-origins"
import { parseReproducibleOrigin } from "@/lib/plugin/cogpack/manifest"
import { isMirroredPluginClient } from "@/lib/plugin/core/mirrored-client"
import {
  LOCAL_INSTALL_VIAS,
  type CogpackProvenance,
  type LocalInstallVia,
  type PluginInstallOrigin,
  type PluginInstallOriginRecord,
  type ReproducibleInstallOrigin,
} from "@/types/plugin/plugin-cogset"

/** Pseudo-path prefix every browser built-in carries. */
export const BUILTIN_PLUGIN_PATH_PREFIX = "builtin://"

/** A full 40-hex commit id. Anything shorter, or a ref name, is not a pin. */
export function isFullCommitSha(value: string | undefined | null): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value)
}

export function isReproducibleOrigin(
  origin: PluginInstallOrigin | undefined
): origin is ReproducibleInstallOrigin {
  return !!origin && origin.kind !== "local"
}

/**
 * The origin an installed plugin exports with. A browser built-in is
 * recognized by its path, because discovery re-creates it on every launch
 * and nothing installs it; everything else reads the recorded origin.
 * `undefined` means unknown, which exports as embedded.
 */
export function resolvePluginOrigin(
  row: { path?: string },
  record: PluginInstallOriginRecord | undefined
): PluginInstallOrigin | undefined {
  if (row.path?.startsWith(BUILTIN_PLUGIN_PATH_PREFIX)) return { kind: "builtin" }
  return record?.origin
}

export interface RecordInstallOriginInput {
  pluginId: string
  version: string
  origin: PluginInstallOrigin
  viaCogpack?: CogpackProvenance
}

export interface RecordInstallOriginDeps {
  put?: (record: PluginInstallOriginRecord) => Promise<void>
  now?: () => number
  /** Defaults to `isMirroredPluginClient`. */
  isMirror?: () => boolean
  /** Hands the record to the host on a mirrored client. */
  forward?: (record: PluginInstallOriginRecord) => Promise<void>
}

async function forwardToHost(record: PluginInstallOriginRecord): Promise<void> {
  const { queueInstallOriginRecord } = await import("@/lib/plugin/cogset/remote")
  await queueInstallOriginRecord(record)
}

/** Record where `pluginId` came from. Never throws. */
export async function recordInstallOrigin(
  input: RecordInstallOriginInput,
  deps: RecordInstallOriginDeps = {}
): Promise<void> {
  const record: PluginInstallOriginRecord = {
    pluginId: input.pluginId,
    version: input.version,
    origin: input.origin,
    ...(input.viaCogpack ? { viaCogpack: input.viaCogpack } : {}),
    recordedAt: (deps.now ?? Date.now)(),
  }
  try {
    // On a mirrored client the install ran on the host; its origin belongs
    // in the host's table, which is the one an export reads.
    if ((deps.isMirror ?? isMirroredPluginClient)()) await (deps.forward ?? forwardToHost)(record)
    else await (deps.put ?? putInstallOrigin)(record)
  } catch (error) {
    loggers.plugin.warn(`[plugin:${input.pluginId}] failed to record install origin`, {
      kind: input.origin.kind,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function isShortString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
}

/**
 * Validate an install-origin record that did not come from an install on this
 * host: one a paired client forwards, or one a backup restores. A later
 * cogpack export pins exactly what the record says, so a reproducible origin
 * gets the same checks a cogpack member source does (https URLs, full commit
 * ids, sha256 pins). Throws on anything else.
 */
export function parseInstallOriginRecord(raw: unknown): PluginInstallOriginRecord {
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const origin = (
    record.origin && typeof record.origin === "object" ? record.origin : {}
  ) as Record<string, unknown>
  if (
    !isShortString(record.pluginId, 128) ||
    !isShortString(record.version, 64) ||
    typeof record.recordedAt !== "number" ||
    !Number.isFinite(record.recordedAt)
  ) {
    throw new Error(
      "Install origin record is invalid: pluginId, version and recordedAt are required"
    )
  }
  let parsed: PluginInstallOrigin
  if (origin.kind === "local") {
    if (!LOCAL_INSTALL_VIAS.includes(origin.via as LocalInstallVia)) {
      throw new Error(`Install origin record is invalid: unknown local via ${String(origin.via)}`)
    }
    parsed = { kind: "local", via: origin.via as LocalInstallVia }
  } else {
    parsed = parseReproducibleOrigin(origin, "origin")
  }
  let viaCogpack: CogpackProvenance | undefined
  if (record.viaCogpack !== undefined) {
    const via = record.viaCogpack as Record<string, unknown> | null
    if (
      !via ||
      !isShortString(via.cogpackId, 128) ||
      !isShortString(via.version, 64) ||
      typeof via.fingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(via.fingerprint)
    ) {
      throw new Error("Install origin record is invalid: viaCogpack is malformed")
    }
    viaCogpack = { cogpackId: via.cogpackId, version: via.version, fingerprint: via.fingerprint }
  }
  return {
    pluginId: record.pluginId,
    version: record.version,
    origin: parsed,
    ...(viaCogpack ? { viaCogpack } : {}),
    recordedAt: record.recordedAt,
  }
}

/**
 * Parse a GitHub install into an origin. Returns `null` when the ref is not a
 * full commit: a branch name is not a pin, and claiming it were would make an
 * export silently install something else later.
 */
export function githubInstallOrigin(input: {
  repo: string
  gitRef?: string | null
  subdir?: string | null
}): Extract<ReproducibleInstallOrigin, { kind: "github" }> | null {
  const [owner, repo, ...rest] = input.repo.split("/")
  if (!owner || !repo || rest.length > 0 || !isFullCommitSha(input.gitRef)) return null
  return {
    kind: "github",
    owner,
    repo,
    ...(input.subdir ? { subdir: input.subdir } : {}),
    commit: input.gitRef.toLowerCase(),
  }
}
