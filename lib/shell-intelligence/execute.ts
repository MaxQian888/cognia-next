/**
 * Running a `!` line — on whichever Host the client is attached to.
 *
 * The composer used to call `shell_exec`, a Tauri command that hard-codes
 * `sh -c` (or `cmd /C`) and exists only on the desktop. Two consequences it is
 * worth naming, because they are what this module exists to fix:
 * `terminal.defaultShell` was decorative — a user on `fish` still got `sh` —
 * and a browser paired to a Host could not run anything at all, despite the
 * Host being right there with a perfectly good shell on it.
 *
 * So execution moves to the transport-routed `terminal_exec`, which the desktop
 * renderer, the paired browser and the Capacitor shell all reach, and the shell
 * comes from {@link buildShellInvocation} instead of from a `cfg!` in Rust.
 *
 * `terminal_exec` caps neither its output nor its default runtime the way
 * `shell_exec` did, so both caps are re-applied here rather than silently
 * dropped — a chatty command must not be able to blow up a chat transcript.
 */

import { issueHostAdminLease } from "@/lib/tauri/admin-lease"
import {
  execTerminalCommand,
  type RemoteExecRequest,
  type RemoteExecResult,
} from "@/lib/terminal/remote-api"
import { buildShellInvocation } from "./shell-argv"
import type { ResolvedShell, ShellAvailability } from "./types"

/** Matches `shell.rs`'s cap, which this path replaces. */
export const MAX_OUTPUT_BYTES = 64 * 1024
/** Matches `shell.rs`'s default and ceiling. */
export const DEFAULT_TIMEOUT_MS = 30_000
export const MAX_TIMEOUT_MS = 5 * 60_000

export interface ShellRunResult {
  stdout: string
  stderr: string
  /** `null` when the process was killed by the timeout or a signal. */
  exitCode: number | null
  timedOut: boolean
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

export type ShellRunOutcome =
  | ({ ok: true } & ShellRunResult)
  | {
      ok: false
      reason:
        | "no-host"
        | "shell-unavailable"
        | "unsupported-shell"
        | "empty-command"
        | "consent-required"
        | "failed"
      /** Untranslated detail for the log; the UI renders its own message. */
      detail: string
    }

export interface RunShellLineInput {
  /** The command line (the `!` already stripped). */
  line: string
  /** Effective working directory. */
  cwd: string
  shell: ResolvedShell
  availability: ShellAvailability
  timeoutMs?: number
  /** Test seam — defaults to the transport-routed RPC. */
  exec?: typeof execTerminalCommand
  /** Test seam — defaults to the explicit Host approval flow. */
  issueLease?: typeof issueHostAdminLease
}

/**
 * Truncate to a byte budget without splitting a UTF-8 character.
 *
 * Byte-based because the cap exists to bound the IPC payload, and character
 * counting would let a CJK or emoji-heavy output through at three times the
 * intended size.
 */
export function truncateToBytes(
  text: string,
  maxBytes: number
): { text: string; truncated: boolean } {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(text)
  if (bytes.length <= maxBytes) return { text, truncated: false }
  // `fatal: false` lets the decoder drop a trailing partial sequence rather
  // than throw, which is exactly the boundary behaviour wanted here.
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, maxBytes))
  // At most ONE replacement char can come from the cut, so strip exactly one.
  // A `+` here would also eat U+FFFD the command really printed.
  return { text: decoded.replace(/�$/, ""), truncated: true }
}

/**
 * Whether the host refused for want of an interactive approval.
 *
 * Matched on both spellings the two layers use: `remote_execution.rs` answers
 * `interactive_approval_required` (428), while `admin_lease::validate` phrases
 * its own refusals as `REMOTE_CONSENT_REQUIRED`.
 */
function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isConsentRefusal(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined
  const detail = errorDetail(error)
  return (
    code === "interactive_approval_required" ||
    code === "REMOTE_CONSENT_REQUIRED" ||
    detail.includes("interactive_approval_required") ||
    detail.includes("REMOTE_CONSENT_REQUIRED")
  )
}

/**
 * Run one shell line and capture its output.
 *
 * Refuses by name whenever it cannot honour the request as asked — no Host, a
 * shell the Host does not have, a family with no known invocation — rather than
 * running the line under different rules than the caller believes are in force.
 */
export async function runShellLine(input: RunShellLineInput): Promise<ShellRunOutcome> {
  const line = input.line.trim()
  if (!line) return { ok: false, reason: "empty-command", detail: "empty command" }

  if (input.availability === "static-only") {
    return { ok: false, reason: "no-host", detail: "no host is reachable" }
  }
  if (input.availability === "shell-unavailable") {
    return {
      ok: false,
      reason: "shell-unavailable",
      detail: `the host does not have ${input.shell.path}`,
    }
  }

  const invocation = buildShellInvocation(input.shell.path, input.shell.kind, line)
  if (!invocation.ok) {
    return {
      ok: false,
      reason: "unsupported-shell",
      detail: `no known invocation for shell family "${invocation.kind}"`,
    }
  }

  const exec = input.exec ?? execTerminalCommand
  const request: RemoteExecRequest = {
    command: invocation.program,
    args: invocation.args,
    cwd: input.cwd,
    timeoutMs: Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    // argv is fully formed above; asking the host to shell-wrap it again
    // would run the user's line under the host's `sh`, not their shell.
    shell: false,
  }
  let result: RemoteExecResult
  try {
    result = await exec(request)
  } catch (err) {
    const detail = errorDetail(err)
    if (!isConsentRefusal(err)) return { ok: false, reason: "failed", detail }

    // Enter is an explicit user action, so it is the correct place to request
    // the Host's short-lived step-up lease. The Host still controls approval;
    // a pending consent request remains distinct from command failure.
    try {
      const lease = await (input.issueLease ?? issueHostAdminLease)(["terminal_exec"])
      result = await exec({ ...request, adminLease: lease.token })
    } catch (approvalError) {
      const approvalDetail = errorDetail(approvalError)
      if (isConsentRefusal(approvalError)) {
        return { ok: false, reason: "consent-required", detail: approvalDetail }
      }
      return { ok: false, reason: "failed", detail: approvalDetail }
    }
  }

  const stdout = truncateToBytes(result.stdout ?? "", MAX_OUTPUT_BYTES)
  const stderr = truncateToBytes(result.stderr ?? "", MAX_OUTPUT_BYTES)
  return {
    ok: true,
    stdout: stdout.text,
    stderr: stderr.text,
    exitCode: result.timedOut ? null : (result.exitCode ?? null),
    timedOut: result.timedOut === true,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  }
}
