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
 *
 * Pass the HOST's platform, not the client's, whenever the session will spawn
 * over `ws` / `webrtc` — see `hostShellOptions`, which is the remote form of
 * both halves at once.
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

/** Shell families the picker has a `terminal.shellPicker.*` label for. */
const LABELLED_SHELL_KINDS: ReadonlySet<string> = new Set([
  "bash",
  "zsh",
  "sh",
  "fish",
  "nu",
  "pwsh",
  "powershell",
  "cmd",
])

/**
 * Shell choices for a *remote* host, built from what it reported it has.
 *
 * This replaces both halves of the local story at once: the host already
 * filtered to shells that exist on it, so there is nothing left to detect —
 * and there is nothing the client *could* detect, since the PATH scan behind
 * `filterDetectedShellOptions` runs a Tauri command against the wrong machine.
 *
 * The family comes from the host, deliberately, rather than from re-running
 * `detectShellKind` on the path: the host classifies against the shells it can
 * actually launch (it knows `/bin/ash` is a `sh`), and a second classifier here
 * would be free to disagree with it about the very thing it just answered.
 *
 * A family with no translated name (a hand-built shell, a Nix store path) gets
 * an empty `labelKey`, and the picker renders its path — an exotic `$SHELL` is
 * still offered rather than silently dropped.
 */
export function hostShellOptions(
  shells: ReadonlyArray<{ path: string; kind: string }>
): ShellOption[] {
  const labelled: ShellOption[] = []
  const seen = new Set<string>()
  for (const shell of shells) {
    const path = shell.path.trim()
    if (path === "" || seen.has(path)) continue
    seen.add(path)
    const known = LABELLED_SHELL_KINDS.has(shell.kind)
    labelled.push({
      value: path,
      labelKey: known ? `terminal.shellPicker.${shell.kind}` : "",
      bin: known ? shell.kind : path,
    })
  }
  return labelled
}

export interface ResolveShellInput {
  projectShell?: string
  settingShell?: string
  /** Override for tests; defaults to `navigator.userAgent`. */
  userAgent?: string
  /**
   * What the *host* reported as its own default (`TerminalHostCapabilities.defaultShell`).
   *
   * Beats the user-agent sniff, because over `ws` / `webrtc` the user agent
   * describes the wrong machine: a macOS browser paired to a Linux server used
   * to ask it for `/bin/zsh`. Ranked *below* the explicit project and user
   * settings — those are choices, and a user who typed a shell path meant it.
   */
  hostDefaultShell?: string
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
  if (input.hostDefaultShell && input.hostDefaultShell.trim().length > 0) {
    return input.hostDefaultShell
  }
  return platformDefaultShell(detectPlatform(input.userAgent))
}
