/**
 * Which shell the `!` line runs under, and whether it can run at all.
 *
 * Two questions that look like one. "Which shell?" has an answer everywhere —
 * even a standalone browser can say `/bin/zsh`, and completion needs it to pick
 * a builtin list. "Can it run?" has an answer only once you know whether a Host
 * is reachable and whether that Host actually has the shell.
 *
 * Answering them separately is what lets a standalone client keep useful
 * completion while being honest that nothing will execute — instead of the two
 * failure modes this replaces: pretending it can run, or hiding the feature.
 *
 * The precedence mirrors `resolveDefaultShell` deliberately, minus the
 * per-project tier: a `!` line in chat is not spawning a project terminal, so
 * `terminal.defaultShell` is the user-level choice that applies.
 */

import type { TerminalHostCapabilities } from "@/lib/terminal/host-capabilities"
import {
  detectPlatform,
  detectShellKind,
  platformDefaultShell,
  type ShellKind,
} from "@/lib/terminal/shell-detect"
import { isShellFamilySupported } from "./shell-argv"
import type { ResolvedShell, ShellAvailability } from "./types"

/** Why execution is refused, when it is. */
export type UnavailableReason =
  /** No Host at all — a standalone browser or an unpaired mobile shell. */
  | "no-host"
  /** The Host is there and does not have the configured shell. */
  | "shell-missing"
  /** The shell exists but nobody here knows how to hand it a command line. */
  | "unsupported-family"

export interface ResolveShellContextInput {
  /** `settings.terminal.defaultShell`. Empty/blank counts as unset. */
  settingShell?: string | null
  /** What the selected Host reported about itself, or null when none is reachable. */
  hostCapabilities?: TerminalHostCapabilities | null
  /**
   * Whether a Host is reachable at all. Separate from `hostCapabilities`
   * because the capability probe can legitimately be in flight or have failed
   * on a Host that is nonetheless there — and a momentarily-missing probe must
   * not be reported to the user as "no Host".
   */
  hostReachable: boolean
  /** Override for tests; defaults to `navigator.userAgent`. */
  userAgent?: string
}

export interface ShellContext {
  shell: ResolvedShell
  availability: ShellAvailability
  /** Set whenever `availability` is not `"full"`. */
  reason?: UnavailableReason
}

/** Basename without a `.exe`-style suffix, for tolerant host matching. */
function shellBasename(path: string): string {
  return (path.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.(exe|cmd|bat)$/, "")
}

/**
 * Does the Host have this shell?
 *
 * Matched on the full path first, then on the basename, so a user who typed
 * `zsh` is not told it is missing by a Host that reports `/bin/zsh`. When the
 * Host reported no shells at all the answer is "yes" — an empty list means the
 * probe told us nothing, and refusing to run on the strength of nothing is a
 * worse failure than letting the Host answer with its own spawn error.
 */
function hostHasShell(path: string, capabilities: TerminalHostCapabilities): boolean {
  const shells = capabilities.availableShells ?? []
  if (shells.length === 0) return true
  const wanted = path.trim()
  if (shells.some((s) => s.path === wanted)) return true
  if (capabilities.defaultShell === wanted) return true
  const base = shellBasename(wanted)
  return shells.some((s) => shellBasename(s.path) === base)
}

/**
 * The shell family, preferring what the Host said over re-classifying the path.
 *
 * The Host classifies against the shells it can actually launch — it knows
 * `/bin/ash` is a `sh` — and a second classifier here would be free to disagree
 * with it about the very thing it just answered.
 */
function resolveKind(path: string, capabilities: TerminalHostCapabilities | null): ShellKind {
  const reported = capabilities?.availableShells?.find((s) => s.path === path.trim())?.kind
  if (reported) {
    const kind = detectShellKind(reported)
    // The Host speaks the same vocabulary, so a recognised family is its answer;
    // an unrecognised one falls through to classifying the path ourselves.
    if (kind !== "unknown") return kind
  }
  return detectShellKind(path)
}

/**
 * Resolve the shell and the execution verdict together.
 *
 * Never throws and never returns a blank shell: completion has to work on the
 * worst client in the matrix, so every branch ends with something spawnable in
 * `shell.path`, even when nothing will spawn it.
 */
export function resolveShellContext(input: ResolveShellContextInput): ShellContext {
  const capabilities = input.hostCapabilities ?? null
  const setting = input.settingShell?.trim()

  let path: string
  let source: ResolvedShell["source"]
  if (setting) {
    path = setting
    source = "setting"
  } else if (capabilities?.defaultShell?.trim()) {
    path = capabilities.defaultShell.trim()
    source = "host-default"
  } else {
    path = platformDefaultShell(detectPlatform(input.userAgent))
    source = "platform-default"
  }

  const shell: ResolvedShell = { path, kind: resolveKind(path, capabilities), source }

  if (!input.hostReachable) {
    return { shell, availability: "static-only", reason: "no-host" }
  }
  // Only an EXPLICIT choice is validated against the Host. The other two tiers
  // came from the Host or from a platform guess, so calling them "missing"
  // would be reporting our own fallback back to the user as their mistake.
  if (source === "setting" && capabilities && !hostHasShell(path, capabilities)) {
    return { shell, availability: "shell-unavailable", reason: "shell-missing" }
  }
  if (!isShellFamilySupported(shell.kind)) {
    return { shell, availability: "shell-unavailable", reason: "unsupported-family" }
  }
  return { shell, availability: "full" }
}
