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
  "bash" | "zsh" | "sh" | "pwsh" | "powershell" | "cmd" | "fish" | "nu" | "unknown"

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

/** A built-in shell choice offered by the "+ New" shell picker. */
export interface ShellOption {
  /** Shell binary to spawn — absolute path or PATH-resolvable name. */
  value: string
  /** i18n key (under `terminal.shellPicker`) for the menu label. */
  labelKey: string
  /** Executable basename used to detect the shell on PATH (no extension). */
  bin: string
}

/**
 * Built-in shell choices appropriate for a platform — Windows shells on
 * Windows, POSIX shells on macOS/Linux. Excludes the "auto / default"
 * entry, which the picker always renders. This is the platform half of
 * "show what fits the OS"; `filterDetectedShellOptions` is the
 * "show only what's installed" half.
 */
export function platformShellOptions(platform: ShellPlatform): ShellOption[] {
  switch (platform) {
    case "windows":
      return [
        { value: "pwsh.exe", labelKey: "terminal.shellPicker.pwsh", bin: "pwsh" },
        { value: "powershell.exe", labelKey: "terminal.shellPicker.powershell", bin: "powershell" },
        { value: "cmd.exe", labelKey: "terminal.shellPicker.cmd", bin: "cmd" },
      ]
    case "macos":
      return [
        { value: "/bin/zsh", labelKey: "terminal.shellPicker.zsh", bin: "zsh" },
        { value: "/bin/bash", labelKey: "terminal.shellPicker.bash", bin: "bash" },
        { value: "/bin/sh", labelKey: "terminal.shellPicker.sh", bin: "sh" },
        { value: "fish", labelKey: "terminal.shellPicker.fish", bin: "fish" },
        { value: "nu", labelKey: "terminal.shellPicker.nu", bin: "nu" },
      ]
    case "linux":
      return [
        { value: "/bin/bash", labelKey: "terminal.shellPicker.bash", bin: "bash" },
        { value: "/bin/zsh", labelKey: "terminal.shellPicker.zsh", bin: "zsh" },
        { value: "/bin/sh", labelKey: "terminal.shellPicker.sh", bin: "sh" },
        { value: "fish", labelKey: "terminal.shellPicker.fish", bin: "fish" },
        { value: "nu", labelKey: "terminal.shellPicker.nu", bin: "nu" },
      ]
    case "other":
    default:
      return [{ value: "/bin/sh", labelKey: "terminal.shellPicker.sh", bin: "sh" }]
  }
}

/**
 * Narrow a platform option list to the shells actually present on PATH.
 * `detectedBins` is the set of executable basenames found (lowercased, no
 * extension). When it is empty — detection unavailable (web) or the scan
 * failed — the full list is returned unchanged. As a safety net, if the
 * filter would hide everything (e.g. a misbehaving scan), the full list is
 * kept so the menu is never empty.
 */
export function filterDetectedShellOptions(
  options: readonly ShellOption[],
  detectedBins: ReadonlySet<string>
): ShellOption[] {
  if (detectedBins.size === 0) return [...options]
  const kept = options.filter((o) => detectedBins.has(o.bin.toLowerCase()))
  return kept.length > 0 ? kept : [...options]
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
