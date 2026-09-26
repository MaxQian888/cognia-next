/**
 * Where the companion's Rust sources live, for the gates and generators that
 * read them (ADR-0196 P4).
 *
 * The companion is being split out of `src-tauri/src/companion_api` into
 * `crates/cognia-companion*`. A script that spells one of these paths itself
 * goes stale on the first move, and not always loudly: one that reads the file
 * crashes, but one that globs a directory scans nothing and passes. So each
 * file is named once, here; a move updates this map in the same commit; and
 * {@link requireCompanionSources} turns an entry that no longer exists into a
 * failure that says where to look.
 *
 * Paths are repo-relative, with forward slashes.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"

export const COMPANION_API_DIR = "src-tauri/src/companion_api"
/** `cognia-companion-bus`: the event bus, channel catalog, store bridges. */
export const COMPANION_BUS_DIR = "crates/cognia-companion-bus/src"
/** `cognia-companion-contract`: the generated command table and settings allowlist. */
export const COMPANION_CONTRACT_DIR = "crates/cognia-companion-contract/src"

export const COMPANION_SOURCES = Object.freeze({
  /** The RPC router: `KNOWN_COMMANDS`, `SERVICE_ONLY_COMMANDS`, the core arms. */
  rpcRouter: `${COMPANION_API_DIR}/rpc.rs`,
  /** The per-family dispatch files, `<dir>/<family>.rs`; see {@link rpcFamilyFile}. */
  rpcFamilyDir: `${COMPANION_API_DIR}/rpc`,
  /** Keys its arms on the same command literals as the RPC families. */
  browserGateway: `${COMPANION_API_DIR}/browser_gateway.rs`,
  eventChannels: `${COMPANION_BUS_DIR}/event_channels.rs`,
  /** The listener: route mounts and `DEFAULT_PORT`. */
  server: `${COMPANION_API_DIR}/server.rs`,
  api: `${COMPANION_API_DIR}/api.rs`,
  larkEntry: `${COMPANION_API_DIR}/lark_entry.rs`,
  /** Written by `gen-settings-sync.mjs`. */
  settingsSyncGenerated: `${COMPANION_CONTRACT_DIR}/settings_sync_generated.rs`,
  /** Written by `gen-companion-api.mjs`. */
  knownCommands: `${COMPANION_CONTRACT_DIR}/generated/known_commands.rs`,
  acpHandler: `${COMPANION_API_DIR}/acp/handler.rs`,
  syncRegistry: `${COMPANION_BUS_DIR}/sync_registry.rs`,
  /**
   * Not under `companion_api`: `rpc/sftp.rs` hands off to this service, which
   * the desktop's own `#[tauri::command]` wrappers share, so the SFTP arms
   * live here.
   */
  sftpService: "src-tauri/src/sftp_service.rs",
})

/** The dispatch file of one RPC family, e.g. `rpcFamilyFile("chat")`. */
export function rpcFamilyFile(family) {
  return `${COMPANION_SOURCES.rpcFamilyDir}/${family}.rs`
}

/** Whether `path` is the RPC router or one of the RPC family files. */
export function isRpcSource(path) {
  return (
    path === COMPANION_SOURCES.rpcRouter ||
    (path.startsWith(`${COMPANION_SOURCES.rpcFamilyDir}/`) && path.endsWith(".rs"))
  )
}

/**
 * Return `paths` if every one exists under `root`; throw otherwise.
 *
 * An empty list throws too: a scan over nothing proves nothing, and it is
 * what a directory glob returns after the directory moved.
 *
 * @param {string[]} paths repo-relative
 * @param {string} root the repository root
 * @param {(absolute: string) => boolean} [exists] injectable for tests
 * @returns {string[]}
 */
export function requireCompanionSources(paths, root, exists = existsSync) {
  if (paths.length === 0) {
    throw new Error(
      "companion source list is empty — if these files moved, update " +
        "scripts/gates/lib/companion-source-paths.mjs"
    )
  }
  const missing = paths.filter((path) => !exists(join(root, path)))
  if (missing.length > 0) {
    throw new Error(
      `companion sources not found: ${missing.join(", ")} — if they moved, ` +
        "update scripts/gates/lib/companion-source-paths.mjs"
    )
  }
  return paths
}
