/**
 * Renderer-side wrappers around the `resolve_cli_home` / `write_cli_home_file`
 * Tauri commands (see `src-tauri/src/cli_bridge/mod.rs`).
 *
 * These back the desktop→CLI push: the desktop resolves the cognia CLI home
 * (`$COGNIA_HOME` or `~/.cognia`) and writes config / credentials / history
 * files there so the standalone `cognia-agent` CLI sees the same setup without
 * a second login. Both no-op gracefully outside Tauri.
 */

import { invoke } from "@tauri-apps/api/core"

import { loggers } from "@cognia/logging"
import { isTauri } from "@/lib/tauri"

const log = loggers.tray // shared "desktop tooling" channel — same as cli-bridge/status

/**
 * Resolve the absolute cognia CLI home directory, or `null` when running
 * outside Tauri or when the OS home dir is unresolvable. The CLI reads its
 * config/credentials/history from this directory.
 */
export async function resolveCliHome(): Promise<string | null> {
  if (!isTauri()) return null
  try {
    const home = await invoke<string | null>("resolve_cli_home")
    return typeof home === "string" && home.length > 0 ? home : null
  } catch (err) {
    log.warn("resolve_cli_home failed", { error: String(err) })
    return null
  }
}

/**
 * Write `content` to `<cli-home>/<fileName>`, creating the home dir if absent.
 * `fileName` must be a bare filename (the Rust side rejects separators / `..`).
 * When `secret` is true the file is given owner-only (0600) perms on unix —
 * use it for `credentials.json`. Throws on failure so callers can report it.
 */
export async function writeCliHomeFile(
  fileName: string,
  content: string,
  secret: boolean
): Promise<void> {
  await invoke("write_cli_home_file", { fileName, content, secret })
}
