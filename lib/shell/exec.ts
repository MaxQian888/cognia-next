// Shell invocation + rendering for a captured `!cmd` run in the chat transcript.
//
// `executeShell` is the desktop-only wrapper over the `shell_exec` Tauri
// command, which hard-codes `sh -c` on POSIX and `cmd /C` on Windows.
//
// The chat composer's `!` mode NO LONGER uses it: `lib/shell-intelligence/execute.ts`
// replaced that path, routing through `terminal_exec` so a paired browser or
// phone can run a line, and building the argv from the user's configured shell
// instead of from a `cfg!` in Rust. Do not reach for `executeShell` from a
// user-facing execution surface again — it has different caps, different rules
// and a desktop-only reachable surface.
//
// It stays exported for the two non-chat, desktop-only tooling callers that
// genuinely want "run this one string under the host's own shell and give me
// stdout": `lib/pi-packages/host.ts` (the Pi CLI) and
// `lib/workspace/pnpm-virtual-store.ts` (the pnpm probe). Neither has a
// `ResolvedShell` to hand, and neither runs on a companion client.

import { invoke } from "@tauri-apps/api/core"
import { isTauri } from "@/lib/tauri"

export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

interface RawShellResult {
  stdout: string
  stderr: string
  exit_code: number | null
  timed_out: boolean
  stdout_truncated: boolean
  stderr_truncated: boolean
}

/**
 * Run `cmd` under the host's own shell on the DESKTOP only.
 *
 * Throws off Tauri rather than degrading: both callers are desktop tooling
 * paths, and a silent no-op would report "pnpm has no virtual store" or "the Pi
 * CLI is unavailable" for a shell that was never asked.
 */
export async function executeShell(
  cmd: string,
  cwd: string,
  timeoutSecs?: number
): Promise<ShellResult> {
  if (!isTauri()) {
    throw new Error("Shell execution is only available in the desktop app.")
  }
  const raw = await invoke<RawShellResult>("shell_exec", {
    cmd,
    cwd,
    timeoutSecs: timeoutSecs ?? null,
  })
  return {
    stdout: raw.stdout,
    stderr: raw.stderr,
    exitCode: raw.exit_code,
    timedOut: raw.timed_out,
    stdoutTruncated: raw.stdout_truncated,
    stderrTruncated: raw.stderr_truncated,
  }
}

/** Format a shell result as a markdown block for the chat transcript. */
export function formatShellResult(cmd: string, result: ShellResult): string {
  const status = result.timedOut
    ? "timed out"
    : result.exitCode === 0
      ? "exit 0"
      : `exit ${result.exitCode ?? "?"}`
  const sections: string[] = [`\`$ ${cmd}\` *(${status})*`]
  // The truncation flags are the reason the caps are safe to have at all. A
  // 64 KB clip rendered as if it were the whole output is a silent lie about
  // what the command printed — and the one case where the reader most needs to
  // know is the chatty command the cap exists for.
  const clipped = " *(output truncated)*"
  if (result.stdout.trim()) {
    sections.push(
      "```\n" + result.stdout.trimEnd() + "\n```" + (result.stdoutTruncated ? clipped : "")
    )
  }
  if (result.stderr.trim()) {
    sections.push(
      "**stderr**\n```\n" +
        result.stderr.trimEnd() +
        "\n```" +
        (result.stderrTruncated ? clipped : "")
    )
  }
  if (!result.stdout.trim() && !result.stderr.trim()) {
    sections.push("*(no output)*")
  }
  return sections.join("\n\n")
}
