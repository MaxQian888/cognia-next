/**
 * Discover the running desktop's loopback bridge.
 *
 * The desktop writes `<config_dir>/cognia/cli-endpoint.json` on launch
 * (`src-tauri/src/cli_bridge/mod.rs`), where `config_dir` matches the Rust
 * `directories` crate:
 *   - Windows → %APPDATA%            (…/AppData/Roaming)
 *   - macOS   → ~/Library/Application Support
 *   - Linux   → $XDG_CONFIG_HOME or ~/.config
 * `$COGNIA_CLI_ENDPOINT_FILE` overrides the path (used in tests + custom setups).
 *
 * Pure resolution + parse; the actual file read is injected so this unit-tests
 * without touching disk.
 */

import path from "node:path"

export const ENDPOINT_FILE_REL = path.join("cognia", "cli-endpoint.json")

export interface BridgeEndpoint {
  baseUrl: string
  devToken: string
}

/** Resolve the OS config dir the desktop writes the endpoint file under. */
export function configDir(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  homedir: string
): string {
  if (platform === "win32") {
    return env.APPDATA ?? path.join(homedir, "AppData", "Roaming")
  }
  if (platform === "darwin") {
    return path.join(homedir, "Library", "Application Support")
  }
  return env.XDG_CONFIG_HOME ?? path.join(homedir, ".config")
}

/** Absolute path to `cli-endpoint.json` (honouring the env override). */
export function endpointFilePath(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  homedir: string
): string {
  const override = env.COGNIA_CLI_ENDPOINT_FILE?.trim()
  if (override) return override
  return path.join(configDir(platform, env, homedir), ENDPOINT_FILE_REL)
}

/** Parse the endpoint file contents; returns null when missing/invalid. */
export function parseEndpoint(raw: string | null): BridgeEndpoint | null {
  if (raw === null) return null
  try {
    const json = JSON.parse(raw) as { baseUrl?: unknown; devToken?: unknown }
    if (typeof json.baseUrl === "string" && typeof json.devToken === "string") {
      return { baseUrl: json.baseUrl, devToken: json.devToken }
    }
  } catch {
    // fall through
  }
  return null
}
