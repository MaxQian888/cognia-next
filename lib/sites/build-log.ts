/**
 * Storing what a Sites build printed.
 *
 * `runConfinedSiteBuild` has always returned the full stdout and stderr of the
 * install and build phases. On success both were discarded; on failure only
 * `stderr.trim() || stdout.trim()` survived, as an Error message. So the one
 * artifact that explains a broken build — the compiler's own output — was the
 * one thing the console could never show.
 *
 * Two caps apply before anything is written:
 *
 *  - The **transport** cap is upstream and already enforced:
 *    `runConfinedSiteBuild` truncates each stream at `maxOutputBytes` (1 MiB by
 *    default) and reports `outputTruncated`.
 *  - The **storage** cap is here. 1 MiB × two streams × two phases × every
 *    version would make `siteBuildLogs` the next unbounded table, which is the
 *    problem `lib/sites/artifact-gc.ts` just finished solving for archives.
 *    {@link trimBuildOutput} keeps a head and a tail: the toolchain banner that
 *    identifies the runtime is at the top, and the cause of a failure is at the
 *    bottom. The middle of a long build is repetition.
 *
 * Credential-shaped text is stripped before storage. `confined-build.ts` blocks
 * credential-shaped environment *keys* from entering the child, but a build
 * script can print a token it fetched itself, and this output is persisted.
 */
import { redactCredentialText } from "@/lib/security/redact-credentials"
import type { ConfinedSiteBuildResult } from "./confined-build"
import type { SiteBuildLogRow, SiteBuildPhase } from "@/types/sites"

/** Per stream, per phase. */
export const SITE_BUILD_LOG_MAX_BYTES = 256 * 1024
const HEAD_BYTES = 64 * 1024
const TAIL_BYTES = SITE_BUILD_LOG_MAX_BYTES - HEAD_BYTES
const ELISION = "\n\n… output trimmed by Cognia (kept the first and last part) …\n\n"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Keep the head and the tail of an over-long stream.
 *
 * Cuts on byte offsets and decodes with the default lossy `TextDecoder`, so a
 * boundary landing mid-codepoint yields a replacement character rather than a
 * throw.
 */
export function trimBuildOutput(value: string): { value: string; truncated: boolean } {
  const bytes = encoder.encode(value)
  if (bytes.byteLength <= SITE_BUILD_LOG_MAX_BYTES) return { value, truncated: false }
  return {
    value:
      decoder.decode(bytes.slice(0, HEAD_BYTES)) +
      ELISION +
      decoder.decode(bytes.slice(bytes.byteLength - TAIL_BYTES)),
    truncated: true,
  }
}

export interface BuildLogContext {
  versionId: string
  siteId: string
  operationId: string
  phase: Exclude<SiteBuildPhase, "package">
  argv: readonly string[]
  now: number
}

/**
 * A durable row from one confined run. Written on success as well as failure —
 * a build that worked is exactly what you compare a broken one against.
 */
export function buildLogRowFrom(
  result: ConfinedSiteBuildResult,
  context: BuildLogContext
): SiteBuildLogRow {
  const stdout = trimBuildOutput(redactCredentialText(result.stdout))
  const stderr = trimBuildOutput(redactCredentialText(result.stderr))
  return {
    id: `${context.versionId}:${context.phase}`,
    versionId: context.versionId,
    siteId: context.siteId,
    operationId: context.operationId,
    phase: context.phase,
    argv: [...context.argv],
    exitCode: result.exitCode,
    durationSeconds: result.durationSeconds,
    timedOut: result.timedOut,
    truncated: result.outputTruncated || stdout.truncated || stderr.truncated,
    stdout: stdout.value,
    stderr: stderr.value,
    storedBytes: encoder.encode(stdout.value).byteLength + encoder.encode(stderr.value).byteLength,
    createdAt: context.now,
  }
}

/** Human-facing one-liner for a phase's progress event. */
export function buildPhaseMessage(
  phase: SiteBuildPhase,
  argv: readonly string[] | undefined
): string {
  return argv && argv.length > 0 ? `${phase}: ${argv.join(" ")}` : phase
}
