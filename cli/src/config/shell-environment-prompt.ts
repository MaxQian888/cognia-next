/**
 * What the model needs to know about the shell it is about to run commands in.
 *
 * The prompt used to describe the working directory and the platform and stop
 * there, which left every shell difference to be discovered by failing: BSD
 * flags on macOS, a sandbox that refuses `/dev/null`, a chained command whose
 * exit status came from the wrong half. The model then retried the same
 * construct, because nothing had told it the construct was the problem.
 *
 * Two kinds of fact live here, and the difference matters:
 *
 *  - What this host IS. The platform, the shell binary, and (for an external
 *    backend) the fact that the shell belongs to that runtime and Cognia does
 *    not control its sandbox. All observed, none guessed.
 *  - What survives ANY of them. A command that avoids device files, GNU-only
 *    flags and chaining works on every host we run on, so these are stated as
 *    rules rather than as claims about this particular machine.
 *
 * Deliberately short. It rides in front of every turn, and a page of shell
 * folklore would cost more context than the failures it prevents.
 */

export interface ShellEnvironmentInput {
  /** Usually `process.platform`. */
  platform: string
  /** The user's login shell, when the environment names one. */
  shell?: string
  /**
   * The external backend running the tools, when one is in use. Its shell is
   * the agent's own, under the agent's own sandbox, which Cognia can neither
   * see nor widen.
   */
  externalBackend?: string
}

/** The shell binary's base name, or undefined when the environment names none. */
export function shellName(shell: string | undefined): string | undefined {
  const trimmed = shell?.trim()
  if (!trimmed) return undefined
  const base = trimmed.split(/[\\/]/u).pop()
  return base && base.length > 0 ? base : undefined
}

/** A one-line description of the host's command interpreter. */
export function describeShell(input: ShellEnvironmentInput): string {
  if (input.platform === "win32") {
    return shellName(input.shell) ?? "cmd.exe or PowerShell, depending on the host"
  }
  return shellName(input.shell) ?? "an unnamed POSIX shell"
}

/**
 * The `<shell>` section, or an empty string when there is nothing to add.
 *
 * Never empty in practice. It returns a string rather than an array so callers
 * can append it the way every other prompt section is appended.
 */
export function buildShellEnvironmentSection(input: ShellEnvironmentInput): string {
  const bsd = input.platform === "darwin"
  return [
    "<shell>",
    `Interpreter: ${describeShell(input)}`,
    `Platform: ${input.platform}`,
    ...(input.externalBackend
      ? [
          `Commands run inside ${input.externalBackend}, under that runtime's own sandbox. Cognia cannot widen it, so a permission error from a command is a fact about the sandbox and not something to retry.`,
        ]
      : []),
    "</shell>",
    "",
    "Running commands:",
    "- One command per call. Chaining with `;` or `&&` hides which part failed and reports the wrong exit status, and a partial failure then reads as a working command.",
    "- Do not redirect to `/dev/null` or any other device file. The tool already captures stdout and stderr, and a sandboxed shell may refuse the device outright.",
    ...(bsd
      ? [
          "- This is macOS: `ls`, `sed`, `date`, `stat` and `grep` are the BSD versions. GNU-only flags (`sed -i` with no argument, `date -d`, `stat -c`, `ls --color`) fail here. Prefer a portable form, or the dedicated read/grep/glob tools.",
        ]
      : []),
    ...(input.platform === "win32"
      ? [
          "- This is Windows: paths use backslashes, and POSIX utilities are not guaranteed to be on PATH. Prefer the dedicated read/grep/glob tools over shelling out.",
        ]
      : []),
    "- If a command fails on the environment rather than on your input (a missing binary, a refused device, an unsupported flag), change the approach rather than repeating it. Say what the environment refused.",
  ].join("\n")
}
