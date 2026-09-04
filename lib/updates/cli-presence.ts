"use client"

/**
 * Where the installed `cognia-agent` came from.
 *
 * The install path is the only reliable signal about which package manager
 * owns a global binary, and it is a heuristic, not a fact. When it does not
 * clearly say, the Update Center offers every command rather than guessing and
 * printing one that quietly does nothing.
 *
 * Three installs are deliberately never offered an upgrade command:
 *  - a development checkout, where the binary is a symlink into a repo,
 *  - an `npx` style temporary invocation, which has nothing to upgrade,
 *  - the sidecar the desktop app bundles, which ships with the app.
 */

import { detectCli } from "@/lib/cli-bridge/detect-cli"

import type { CliPackageManager } from "./adapters/cli-adapter"

export const CLI_BINARY_NAME = "cognia-agent"

export interface CliPresence {
  available: boolean
  version: string | null
  path: string | null
  manager: CliPackageManager
  /** True when this install must not be upgraded by a package manager. */
  selfManaged: boolean
}

/** Extract the first `x.y.z` from a `--version` line. */
export function parseCliVersion(raw: string | null): string | null {
  if (!raw) return null
  const match = raw.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)
  return match ? match[0] : null
}

/** Guess the owning package manager from an install path. */
export function packageManagerFromPath(path: string | null): CliPackageManager {
  if (!path) return "unknown"
  const p = path.replace(/\\/g, "/").toLowerCase()
  if (p.includes("/.bun/") || p.includes("/bun/")) return "bun"
  if (p.includes("/pnpm/") || p.includes("/.pnpm")) return "pnpm"
  if (p.includes("/yarn/") || p.includes("/.yarn/")) return "yarn"
  if (
    p.includes("/node_modules/.bin/") ||
    p.includes("/npm/") ||
    p.includes("/lib/node_modules/")
  ) {
    return "npm"
  }
  return "unknown"
}

/** True for installs Cognia must not tell a package manager to touch. */
export function isSelfManagedInstall(path: string | null): boolean {
  if (!path) return false
  const p = path.replace(/\\/g, "/").toLowerCase()
  return (
    p.includes("/_npx/") ||
    p.includes("/.npm/_npx") ||
    p.includes("/cognia.app/") ||
    p.includes("/resources/sidecar/") ||
    p.includes("/cli/dist/")
  )
}

export async function detectInstalledCli(
  detect: typeof detectCli = detectCli
): Promise<CliPresence> {
  const result = await detect(CLI_BINARY_NAME)
  if (!result.available) {
    return { available: false, version: null, path: null, manager: "unknown", selfManaged: false }
  }
  const selfManaged = isSelfManagedInstall(result.path)
  return {
    available: true,
    version: parseCliVersion(result.version),
    path: result.path,
    manager: selfManaged ? "unknown" : packageManagerFromPath(result.path),
    selfManaged,
  }
}
