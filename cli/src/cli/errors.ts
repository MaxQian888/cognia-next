/**
 * The failure block every new command writes to stderr.
 *
 *   Error:        what went wrong, one line
 *   Details:      the raw supporting lines, when there are any
 *   Cause:        this CLI's classification of the failure
 *   Fix:          a step that can be run or adopted right now
 *   Inspect:      a command that narrows the problem further
 *   Diagnostics:  server-side identifiers worth quoting in a bug report
 *
 * `Fix` and `Inspect` exist because the primary reader of a failed command in
 * this repo is an agent, and an agent needs a next action rather than a
 * sentiment. A refusal with no `Fix` is a bug in the caller, not a style
 * choice, so every refusal path in the API plane fills one in.
 */

import type { OutputSink } from "./output"

export type FailureCause =
  /** The request never reached a host. */
  | "network"
  /** No host is configured or discoverable. */
  | "no-host"
  /** A credential is missing, expired, or refused. */
  | "auth"
  /** The CLI refused before sending, because the call could not be valid. */
  | "invalid-request"
  /** The host does not carry this command or route. */
  | "unknown-command"
  /** The host understood the call and refused it. */
  | "refused"
  /** The host accepted the call and it failed while running. */
  | "failed"
  /** The call exceeded its budget. */
  | "timeout"

export interface CliFailure {
  error: string
  details?: string[]
  cause: FailureCause
  fix?: string[]
  inspect?: string[]
  diagnostics?: Record<string, string | number | undefined>
}

/** Exit codes, kept stable so a script can branch without parsing text. */
export const EXIT_OK = 0
export const EXIT_FAILURE = 1
export const EXIT_USAGE = 2

export function renderFailure(failure: CliFailure): string {
  const lines: string[] = [`Error: ${failure.error}`]
  for (const detail of failure.details ?? []) lines.push(`Details: ${detail}`)
  lines.push(`Cause: ${failure.cause}`)
  for (const fix of failure.fix ?? []) lines.push(`Fix: ${fix}`)
  for (const inspect of failure.inspect ?? []) lines.push(`Inspect: ${inspect}`)
  const diagnostics = Object.entries(failure.diagnostics ?? {}).filter(
    ([, value]) => value !== undefined && value !== ""
  )
  for (const [key, value] of diagnostics) lines.push(`Diagnostics: ${key}=${String(value)}`)
  return `${lines.join("\n")}\n`
}

/** Write the block and hand back the exit code, so callers stay one-liners. */
export function emitFailure(
  out: OutputSink,
  failure: CliFailure,
  exitCode: number = EXIT_FAILURE
): number {
  out.error(renderFailure(failure).trimEnd())
  return exitCode
}

/** A usage mistake: the same block, but exit 2 and a `--help` pointer. */
export function usageFailure(
  out: OutputSink,
  error: string,
  fix: string[],
  inspect: string[] = []
): number {
  return emitFailure(
    out,
    { error, cause: "invalid-request", fix, ...(inspect.length > 0 ? { inspect } : {}) },
    EXIT_USAGE
  )
}
