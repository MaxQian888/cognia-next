/**
 * Where the CLI looks for an external-agent binary — the Node counterpart of the
 * Rust `command_resolver::search_dirs` (`crates/cognia-external-agent`).
 *
 * The interactive TUI hosts external agents through the *Node* backend
 * (`node-backend.ts`), not the Rust process manager, so it never inherited the
 * Rust resolver's fix for the same problem the Rust module documents: a bare
 * `process.env.PATH` misses every CLI installed by Homebrew, npm/pnpm/bun,
 * `cargo install`, or a vendor's native installer whenever the launching
 * environment is not a full login shell (a macOS app bundle started from
 * Finder/Dock inherits launchd's `/usr/bin:/bin:/usr/sbin:/sbin`; a stripped
 * service manager or a CI runner is no better). The readiness probe then reports
 * "not installed / not on PATH" for an agent that is plainly installed.
 *
 * This module restores TS↔Rust parity: it appends the same well-known per-user
 * and system install roots after the real `PATH`, probing directories directly
 * rather than shelling out to a login shell — which keeps resolution synchronous,
 * side-effect free, and unit-testable. Everything is derived from the injected
 * {@link AgentPathRuntime} so tests never touch the real environment.
 */
import path from "node:path"
import os from "node:os"

export interface AgentPathRuntime {
  platform: NodeJS.Platform
  /** The user's home directory, or `undefined` when it cannot be determined. */
  home: string | undefined
  /** Env vars this reads (PATH, PATHEXT, and the package-manager roots). A plain
   * read-only bag rather than `NodeJS.ProcessEnv` so a test can pass a partial. */
  env: Record<string, string | undefined>
}

/** The real host runtime. A function (not a const) so it re-reads `process.env`
 * on every call — the ambient PATH can change between a readiness probe and a
 * later spawn. */
export function defaultAgentPathRuntime(): AgentPathRuntime {
  let home: string | undefined
  try {
    home = os.homedir()
  } catch {
    home = process.env.HOME || process.env.USERPROFILE || undefined
  }
  return { platform: process.platform, home, env: process.env }
}

/**
 * Per-user / package-manager install roots that a Finder-launched macOS app (or
 * any minimal-environment host) never sees. Ordered most-specific first —
 * explicit env-var roots ahead of the guessed home-relative ones — mirroring the
 * Rust `fallback_install_dirs`. Non-existent entries are harmless: the caller
 * only probes them for a concrete file.
 */
export function fallbackInstallDirs(runtime: AgentPathRuntime): string[] {
  const { platform, home, env } = runtime
  const dirs: string[] = []
  const pushEnv = (key: string, suffix?: string): void => {
    const value = env[key]
    if (!value) return
    dirs.push(suffix ? path.join(value, suffix) : value)
  }
  // Explicit package-manager roots win over the guessed home-relative ones.
  pushEnv("PNPM_HOME")
  pushEnv("BUN_INSTALL", "bin")
  pushEnv("VOLTA_HOME", "bin")
  pushEnv("NVM_BIN")
  pushEnv("CARGO_HOME", "bin")

  if (home) {
    for (const relative of [
      ".local/bin",
      ".bun/bin",
      ".cargo/bin",
      ".volta/bin",
      ".npm-global/bin",
      ".deno/bin",
      "Library/pnpm",
      ".nix-profile/bin",
    ]) {
      dirs.push(path.join(home, ...relative.split("/")))
    }
  }

  // System-wide roots that launchd omits from a GUI app's PATH. Posix-only —
  // external-agent hosting is gated to macOS/Linux, and these paths are
  // meaningless on Windows.
  if (platform !== "win32") {
    for (const absolute of ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"]) {
      dirs.push(absolute)
    }
  }
  return dirs
}

/**
 * Every directory to search for an agent binary: the process `PATH`, then the
 * {@link fallbackInstallDirs}. Duplicates are dropped so the `PATH` ordering
 * always wins — a real-world PATH repeats entries (shell profiles re-exporting
 * Homebrew, …), and the fallback roots frequently overlap it.
 */
export function agentSearchDirs(runtime: AgentPathRuntime): string[] {
  const pathDirs = (runtime.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  const seen = new Set<string>()
  const out: string[] = []
  for (const dir of [...pathDirs, ...fallbackInstallDirs(runtime)]) {
    if (seen.has(dir)) continue
    seen.add(dir)
    out.push(dir)
  }
  return out
}

/**
 * The enriched `PATH` string to hand a spawned launcher child, so the binary the
 * readiness probe located with {@link agentSearchDirs} is also the one the child
 * (and, through it, the sandboxed exec) can resolve — readiness and spawnability
 * can never disagree.
 */
export function resolveAgentSearchPath(
  runtime: AgentPathRuntime = defaultAgentPathRuntime()
): string {
  return agentSearchDirs(runtime).join(path.delimiter)
}
