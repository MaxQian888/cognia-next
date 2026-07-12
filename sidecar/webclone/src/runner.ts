/**
 * web-clone engine runner — the process-isolation seam.
 *
 * The vendored library writes progress chatter to `process.stdout` and does
 * heavy, memory-hungry parsing. Running it in-process inside the sidecar would
 * (a) corrupt the sidecar's JSON-RPC stdout channel and (b) couple a crash /
 * OOM to the whole host. So instead the sidecar spawns THIS file as a short
 * child process:
 *
 *   node webclone/dist/runner.js <job.json>        (or job JSON on stdin)
 *
 * The child owns its own stdout, so we can safely reroute the library's chatter
 * to stderr and reserve stdout for exactly one line: the JSON result envelope.
 * Both the agent tool (`builtin-tools/webclone`) and the workflow node's Tauri
 * command spawn the same runner — it is the single reusable seam.
 */

import { readFileSync } from "node:fs"
import { snapshot, convertLocalSnapshot } from "./assembler.js"
import type { SnapshotOptions, SnapshotResult, Asset } from "./types.js"
import { FetchTargetBlockedError } from "./ssrf-guard.js"

/** Job payload handed to the runner (JSON on argv[2] file path, or stdin). */
export interface RunnerJob {
  /** 'snapshot' fetches a URL; 'convert' runs codegen on an existing local output. */
  mode: "snapshot" | "convert"
  /** Required for mode 'snapshot'. */
  url?: string
  /** Full engine options (already normalized by the caller). */
  options: SnapshotOptions
}

/** Compact, transport-safe projection of a downloaded asset (no buffers). */
export interface AssetSummary {
  originUrl: string
  type: Asset["type"]
  status: Asset["status"]
  size: number
  localPath?: string
  error?: string
}

export interface RunnerResult {
  sourceUrl: string
  timestamp: string
  mode: RunnerJob["mode"]
  output: string
  stats: SnapshotResult["stats"]
  assets: AssetSummary[]
}

export type RunnerEnvelope =
  | { ok: true; result: RunnerResult }
  | { ok: false; error: { name: string; message: string; reason?: string } }

/** Strip heavy buffers/text from the result so the envelope stays small. */
function summarizeAssets(assets: Asset[]): AssetSummary[] {
  return assets.map((a) => ({
    originUrl: a.originUrl,
    type: a.type,
    status: a.status,
    size: a.size,
    localPath: a.localPath,
    error: a.error,
  }))
}

/** Execute a job and return the compact envelope. Pure w.r.t. stdio. */
export async function runJob(job: RunnerJob): Promise<RunnerEnvelope> {
  try {
    if (job.mode === "convert") {
      const result = await convertLocalSnapshot(job.options)
      return {
        ok: true,
        result: {
          sourceUrl: result.sourceUrl,
          timestamp: result.timestamp,
          mode: "convert",
          output: job.options.output,
          stats: result.stats,
          assets: summarizeAssets(result.assets),
        },
      }
    }
    if (!job.url) {
      return { ok: false, error: { name: "BadJob", message: "mode 'snapshot' requires a url" } }
    }
    const result = await snapshot(job.url, job.options)
    return {
      ok: true,
      result: {
        sourceUrl: result.sourceUrl,
        timestamp: result.timestamp,
        mode: "snapshot",
        output: job.options.output,
        stats: result.stats,
        assets: summarizeAssets(result.assets),
      },
    }
  } catch (err) {
    if (err instanceof FetchTargetBlockedError) {
      return { ok: false, error: { name: err.name, message: err.message, reason: err.reason } }
    }
    const e = err instanceof Error ? err : new Error(String(err))
    return { ok: false, error: { name: e.name, message: e.message } }
  }
}

/** Parse the job from argv[2] (a file path or '-') / stdin. Exported for tests. */
export function readJob(argv: string[], stdinFd = 0): RunnerJob {
  const jobArg = argv[2]
  const raw =
    jobArg && jobArg !== "-" ? readFileSync(jobArg, "utf8") : readFileSync(stdinFd, "utf8")
  const parsed = JSON.parse(raw) as RunnerJob
  if (parsed.mode !== "snapshot" && parsed.mode !== "convert") {
    throw new Error(`Invalid job.mode: ${String((parsed as { mode?: unknown }).mode)}`)
  }
  return parsed
}

async function main(): Promise<void> {
  // Reserve real stdout for the single result line; reroute the library's
  // progress chatter to stderr so it never mingles with the envelope.
  const realStdoutWrite = process.stdout.write.bind(process.stdout)
  ;(process.stdout as { write: unknown }).write = (
    chunk: string | Uint8Array,
    ...args: unknown[]
  ): boolean =>
    (process.stderr.write as (c: string | Uint8Array, ...a: unknown[]) => boolean)(chunk, ...args)

  let envelope: RunnerEnvelope
  try {
    const job = readJob(process.argv)
    envelope = await runJob(job)
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    envelope = { ok: false, error: { name: e.name, message: e.message } }
  }
  realStdoutWrite(JSON.stringify(envelope) + "\n")
  if (!envelope.ok) process.exitCode = 1
}

// Only run when invoked as a script (not when imported by tests).
const isDirectRun =
  typeof process.argv[1] === "string" && /runner(\.[cm]?[jt]s)?$/.test(process.argv[1])
if (isDirectRun) {
  void main()
}
