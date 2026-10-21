"use client"

export type ShellPlatform = "windows" | "macos" | "linux" | "other"

export type ShellKind =
  "bash" | "zsh" | "sh" | "pwsh" | "powershell" | "cmd" | "fish" | "nu" | "unknown"

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

export interface ShellOption {
  /** Shell binary to spawn — absolute path or PATH-resolvable name. */
  value: string
  /** i18n key (under `terminal.shellPicker`) for the menu label. */
  labelKey: string
  /** Executable basename used to detect the shell on PATH (no extension). */
  bin: string
}

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

export function filterDetectedShellOptions(
  options: readonly ShellOption[],
  detectedBins: ReadonlySet<string>
): ShellOption[] {
  if (detectedBins.size === 0) return [...options]
  const kept = options.filter((o) => detectedBins.has(o.bin.toLowerCase()))
  return kept.length > 0 ? kept : [...options]
}

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
