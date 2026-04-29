// Tauri-side shell.exec invocation used by the chat composer's `!cmd` mode.
// Returns the same shape the Rust handler emits; callers format it for the
// chat transcript themselves.

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
  if (result.stdout.trim()) {
    sections.push("```\n" + result.stdout.trimEnd() + "\n```")
  }
  if (result.stderr.trim()) {
    sections.push("**stderr**\n```\n" + result.stderr.trimEnd() + "\n```")
  }
  if (!result.stdout.trim() && !result.stderr.trim()) {
    sections.push("*(no output)*")
  }
  return sections.join("\n\n")
}
