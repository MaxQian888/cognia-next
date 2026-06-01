"use client"

/**
 * Default-shell suggestion for the integrated terminal.
 *
 * The renderer can't probe the filesystem to know if `/bin/zsh` exists,
 * so we return a best-guess based on platform. The user can override via
 * settings (`useSettingsStore`) or per-project (`Project.terminalConfig`)
 * — those overrides take precedence over the value returned here.
 *
 * Detection sources, in priority order:
 *   1. Per-project override (`Project.terminalConfig.shell`).
 *   2. User setting (`settings.terminalDefaultShell`).
 *   3. `navigator.userAgent` platform sniff.
 *
 * The Rust side validates the shell binary exists at spawn time; an
 * invalid path surfaces as a `spawn_command failed` error which the dock
 * presents to the user.
 */

export type ShellPlatform = "windows" | "macos" | "linux" | "other"

/**
 * Shell family. Renderer-side mirror of the Rust `ShellKind`
 * (`src-tauri/src/terminal/integration.rs`) — kept aligned so shell-aware
 * features (OSC 633 integration, AI completion syntax hints) agree on both
 * sides. A superset: `sh` is recognised here for completion purposes even
 * though the Rust integration layer treats a bare `sh` as `unknown`.
 */
export type ShellKind =
  | "bash"
  | "zsh"
  | "sh"
  | "pwsh"
  | "powershell"
  | "cmd"
  | "fish"
  | "nu"
  | "unknown"

/**
 * Classify a shell binary path into a `ShellKind`. Mirrors the Rust
 * `ShellKind::from_shell_path`: take the file stem, drop a trailing
 * `.exe`, lowercase, and pattern-match. Unknown shells fall back to
 * `"unknown"` (still spawnable — this only drives shell-aware hints).
 */
export function detectShellKind(shellPath: string): ShellKind {
  const base = (shellPath.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "")
  switch (base) {
    case "bash":
      return "bash"
    case "zsh":
      return "zsh"
    case "sh":
    case "dash":
      return "sh"
    case "pwsh":
      return "pwsh"
    case "powershell":
      return "powershell"
    case "cmd":
      return "cmd"
    case "fish":
      return "fish"
    case "nu":
    case "nushell":
      return "nu"
    default:
      return "unknown"
  }
}

export function detectPlatform(ua?: string): ShellPlatform {
  const haystack = (
    ua ?? (typeof navigator !== "undefined" ? navigator.userAgent : "")
  ).toLowerCase()
  if (haystack.includes("windows")) return "windows"
  if (haystack.includes("mac os") || haystack.includes("macintosh")) return "macos"
  if (haystack.includes("linux") || haystack.includes("x11")) return "linux"
  return "other"
}

/**
 * Best-guess default shell by platform. Use as a fallback when no
 * project override and no user setting are set.
 */
export function platformDefaultShell(platform: ShellPlatform): string {
  switch (platform) {
    case "windows":
      // pwsh.exe is on PATH when PowerShell 7+ is installed; the Rust
      // side falls back gracefully to a non-existent-binary error if
      // it's not, and the user can swap to `powershell.exe` or
      // `cmd.exe` from settings.
      return "pwsh.exe"
    case "macos":
      return "/bin/zsh"
    case "linux":
      return "/bin/bash"
    case "other":
    default:
      return "/bin/sh"
  }
}

export interface ResolveShellInput {
  projectShell?: string
  settingShell?: string
  /** Override for tests; defaults to `navigator.userAgent`. */
  userAgent?: string
}

/**
 * Resolve the shell path the dock should spawn for a new tab. Empty
 * strings are treated as "unset" so that an empty per-project override
 * field doesn't shadow the user setting.
 */
export function resolveDefaultShell(input: ResolveShellInput): string {
  if (input.projectShell && input.projectShell.trim().length > 0) {
    return input.projectShell
  }
  if (input.settingShell && input.settingShell.trim().length > 0) {
    return input.settingShell
  }
  return platformDefaultShell(detectPlatform(input.userAgent))
}
