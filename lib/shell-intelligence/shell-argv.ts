/**
 * The one place that knows how to hand a command line to a shell.
 *
 * `src-tauri/src/shell.rs` hard-codes `sh -c` on POSIX and `cmd /C` on Windows,
 * which is why the composer's `!` mode has always run under `sh` no matter what
 * `terminal.defaultShell` said. Getting that right means knowing each family's
 * "run this string" flag — and those disagree enough (`fish` wants `-l -c` as
 * two arguments, PowerShell wants `-Command`, `cmd` wants `/D /S /C`) that
 * spreading the knowledge across call sites guarantees one of them is wrong.
 *
 * So: one table, one function, and an explicit `unsupported` outcome for a
 * family nobody here can speak. Refusing by name beats guessing `-c` and
 * handing a user's line to a shell that will interpret it differently.
 *
 * Pure — no process spawning lives here.
 */

import type { ShellKind } from "@/lib/terminal/shell-detect"

/** The argv a shell family needs before the command string itself. */
const LOGIN_COMMAND_FLAGS: Partial<Record<ShellKind, readonly string[]>> = {
  // `-lc` is one argument on purpose: `sh` and friends accept bundled short
  // flags, and the bundled form is what every existing call site in the repo
  // (and every shell's own docs) uses.
  sh: ["-lc"],
  bash: ["-lc"],
  zsh: ["-lc"],
  // fish rejects the bundled form — `-lc` is read as `-l` with argument `c`.
  fish: ["-l", "-c"],
  nu: ["--login", "-c"],
  // `-NoLogo` suppresses the banner that would otherwise land in captured
  // output; `-Command` takes the rest of the line as PowerShell source.
  pwsh: ["-NoLogo", "-Command"],
  powershell: ["-NoLogo", "-Command"],
  // `/D` skips AutoRun registry commands, `/S` fixes the quote-stripping rule,
  // `/C` runs and exits — the combination `cmd` needs to run a line verbatim.
  cmd: ["/D", "/S", "/C"],
  // `detectShellKind` answers `"unknown"` for ksh, ash, csh, tcsh, elvish,
  // xonsh — every shell outside the eight above. Refusing them by name reads
  // well until you notice what it costs: `!` used to run under the host's
  // `sh -c` no matter what `terminal.defaultShell` said, so a `/bin/ksh` user
  // would LOSE the feature to a change made to serve them, and get the whole
  // line underlined red on the way out.
  //
  // `-c <string>` is the one invocation every shell family takes; the two that
  // do not (PowerShell's `-Command`, `cmd`'s `/C`) have explicit entries above
  // and never reach here. Deliberately NOT the bundled `-lc`: the login flag
  // is exactly where the exotic families disagree (csh accepts `-l` only as
  // the sole flag), and sourcing a profile is not worth a failed spawn.
  //
  // So the guess is bounded, and it can only be wrong for a path that is not a
  // shell at all — where the host's own spawn error is the honest answer.
  unknown: ["-c"],
}

/**
 * The refusal arm is DEFENSIVE, not dormant-by-design: every `ShellKind` the
 * vocabulary has today resolves to flags (`unknown` included, see the table),
 * so nothing reaches it now. It stays because adding a family to `ShellKind`
 * without adding it here is a one-line mistake, and refusing by name beats
 * handing the user's line to a shell nobody taught this module to drive.
 * `runShellLine`'s `unsupported-shell` outcome and `computeDiagnostics`'
 * `unsupported-family` reason are the same arm, downstream.
 */
export type ShellInvocation =
  | { ok: true; program: string; args: string[] }
  | { ok: false; reason: "unsupported-shell"; kind: ShellKind }

/**
 * Build the argv that runs `command` under `shell`.
 *
 * `program` is passed through untouched — the host resolves it against its own
 * PATH, and rewriting a path the user configured would be its own bug.
 */
export function buildShellInvocation(
  shellPath: string,
  kind: ShellKind,
  command: string
): ShellInvocation {
  const flags = LOGIN_COMMAND_FLAGS[kind]
  if (!flags) return { ok: false, reason: "unsupported-shell", kind }
  return { ok: true, program: shellPath, args: [...flags, command] }
}

/** Whether this family can run a one-shot command line at all. */
export function isShellFamilySupported(kind: ShellKind): boolean {
  return LOGIN_COMMAND_FLAGS[kind] !== undefined
}
