/**
 * Running a `!` line as a supervised background job.
 *
 * `runShellLine` (`./execute.ts`) captures a line through `terminal_exec`: one
 * response after the process exits, a timeout that kills it, no way to cancel
 * it or let it run on. That is wrong for exactly the commands people type most
 * — builds, test runs, dev servers. So the composer starts the line on the
 * Host's job supervisor instead (`background_job_spawn_session`, owned by the
 * conversation), streams its merged output into the chat and can hand it to
 * the Job Center. `./shell-job-run.ts` drives the job once it exists; this
 * module starts it and holds the pure pieces both sides share.
 *
 * The argv still comes from {@link buildShellInvocation}, so the user's
 * configured shell runs the line, exactly as on the capture path.
 */

import type { BackgroundJobRecord, BackgroundJobStatus } from "@/lib/jobs/background-jobs"
import { spawnSessionBackgroundJob } from "@/lib/jobs/background-jobs"
import { issueHostAdminLease } from "@/lib/tauri/admin-lease"
import { NO_HOST_TRANSPORT_CODE } from "@/lib/tauri/transport-web"
import { callWithHostApproval, MAX_OUTPUT_BYTES } from "./execute"
import { buildShellInvocation } from "./shell-argv"
import type { ResolvedShell, ShellAvailability } from "./types"

export type ShellJobStartOutcome =
  | { ok: true; job: BackgroundJobRecord }
  | {
      ok: false
      /**
       * `job-unavailable` means the Host has no session job command (an older
       * Host, or a transport that cannot carry it). The caller falls back to
       * the capture path; every other reason is reported to the user.
       */
      reason:
        | "no-host"
        | "shell-unavailable"
        | "unsupported-shell"
        | "empty-command"
        | "consent-required"
        | "job-unavailable"
        | "failed"
      /** Untranslated detail for the log; the UI renders its own message. */
      detail: string
    }

export interface StartShellJobInput {
  sessionId: string
  /** The command line (the `!` already stripped). */
  line: string
  cwd: string
  shell: ResolvedShell
  availability: ShellAvailability
  /** Job Center label, already translated. */
  label?: string
  /** Test seam — defaults to the transport-routed spawn. */
  spawn?: typeof spawnSessionBackgroundJob
  /** Test seam — defaults to the explicit Host approval flow. */
  issueLease?: typeof issueHostAdminLease
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Whether the Host answered "no such command".
 *
 * One spelling per layer that can say it: the companion executor's
 * `unknown_command` problem (a paired Host older than this command) or its
 * transport refusal, Tauri's `Command … not found`, and the web stub's
 * `no_host_transport` — no Host behind the general transport. The capture
 * fallback reaches `terminal_exec` over the terminal's own transport picker,
 * so it can still run the line in each of these cases.
 */
const MISSING_COMMAND_CODES = new Set([
  "unknown_command",
  "command_transport_forbidden",
  NO_HOST_TRANSPORT_CODE,
])

export function isMissingCommandError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined
  if (code && MISSING_COMMAND_CODES.has(code)) return true
  const text = errorText(error)
  return (
    [...MISSING_COMMAND_CODES].some((known) => text.includes(known)) ||
    /command \S+ not found/i.test(text) ||
    text.includes("is not registered")
  )
}

/**
 * Start `line` as a job owned by the conversation.
 *
 * Refuses by name for the same reasons `runShellLine` does, before anything
 * reaches the Host, so the two paths can never disagree about what a `!` line
 * may run.
 */
export async function startShellJob(input: StartShellJobInput): Promise<ShellJobStartOutcome> {
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

  const spawn = input.spawn ?? spawnSessionBackgroundJob
  const request = {
    sessionId: input.sessionId,
    command: line,
    program: invocation.program,
    args: invocation.args,
    cwd: input.cwd,
    ...(input.label ? { label: input.label } : {}),
  }
  const outcome = await callWithHostApproval(
    "background_job_spawn_session",
    (adminLease) => spawn(adminLease ? { ...request, adminLease } : request),
    input.issueLease
  )
  if (outcome.ok) return { ok: true, job: outcome.value }
  if (isMissingCommandError(outcome.error)) {
    return { ok: false, reason: "job-unavailable", detail: outcome.detail }
  }
  return { ok: false, reason: outcome.reason, detail: outcome.detail }
}

/** The last {@link MAX_OUTPUT_BYTES} of a job's output, and whether more came before. */
export interface OutputTail {
  text: string
  /** True once anything was dropped from the front. */
  truncated: boolean
}

export const EMPTY_TAIL: OutputTail = { text: "", truncated: false }

/**
 * Keep the LAST `maxBytes` of `text`, never starting inside a UTF-8 character.
 *
 * The tail, not the head: the capture path kept the first 64 KB, which for a
 * failing build is the part with no error in it. A streaming view shows what
 * the command is doing now, and the full log stays in the Job Center.
 */
export function keepTailBytes(
  text: string,
  maxBytes: number = MAX_OUTPUT_BYTES
): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= maxBytes) return { text, truncated: false }
  let start = bytes.length - maxBytes
  // Step past continuation bytes (10xxxxxx) so the cut lands on a character
  // boundary instead of decoding the stray bytes as U+FFFD.
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1
  return { text: new TextDecoder("utf-8").decode(bytes.slice(start)), truncated: true }
}

/** Append a chunk of output, keeping only the tail. */
export function appendTail(
  tail: OutputTail,
  chunk: string,
  maxBytes: number = MAX_OUTPUT_BYTES
): OutputTail {
  if (!chunk) return tail
  const next = keepTailBytes(tail.text + chunk, maxBytes)
  return { text: next.text, truncated: tail.truncated || next.truncated }
}

/** How a settled job ended, as the transcript says it. */
export interface ShellJobResult {
  command: string
  status: BackgroundJobStatus
  exitCode?: number
  output: OutputTail
}

/**
 * Translated phrases the transcript text is built from. Supplied by the UI
 * (`useShellJobCopy`) so this module stays free of React and next-intl, and
 * so the run controller can keep writing after the composer that started it
 * has unmounted.
 */
export interface ShellJobCopy {
  /** `` `$ {cmd}` *({status})* `` */
  header: (command: string, status: string) => string
  statusExit: (code: number | string) => string
  statusKilled: string
  statusInterrupted: string
  statusFailed: string
  noOutput: string
  /** Shown under output whose front was dropped. */
  truncated: string
  movedToBackground: (command: string) => string
  lost: (command: string, error: string) => string
}

export function describeJobStatus(
  copy: ShellJobCopy,
  status: BackgroundJobStatus,
  exitCode?: number
): string {
  switch (status) {
    case "killed":
      return copy.statusKilled
    case "interrupted":
      return copy.statusInterrupted
    case "failed":
      return copy.statusFailed
    default:
      return copy.statusExit(exitCode ?? "?")
  }
}

/**
 * Longest run of backticks in `text`, plus one, as a fence — so output that
 * itself prints a ``` line cannot close the block early and spill markdown
 * into the transcript.
 */
export function fenceFor(text: string): string {
  let longest = 0
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  return "`".repeat(Math.max(3, longest + 1))
}

/** The markdown a settled job leaves in the transcript. */
export function formatShellJobResult(copy: ShellJobCopy, result: ShellJobResult): string {
  const header = copy.header(
    result.command,
    describeJobStatus(copy, result.status, result.exitCode)
  )
  const body = result.output.text.trimEnd()
  if (!body.trim()) return `${header}\n\n${copy.noOutput}`
  const fence = fenceFor(body)
  const block = `${fence}\n${body}\n${fence}`
  return result.output.truncated
    ? `${header}\n\n${copy.truncated}\n\n${block}`
    : `${header}\n\n${block}`
}
