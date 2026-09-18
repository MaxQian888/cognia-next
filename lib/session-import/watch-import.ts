// Background (non-UI) re-import driven by the fs-watch (ADR-0062, T5).
//
// Distinct from the `useSessionImport` hook (which drives a UI state machine):
// this is a plain async entry the watch hook calls on a `session-import://changed`
// event. It re-scans the sources and re-imports through the SAME guarded
// `applyImported` (`applyImportedMerged`), so a session the user already
// continued in Cognia is never clobbered (its row is frozen and skipped).

import {
  detectSourceForPath,
  getSessionSources,
  importSessions,
  listAllSessions,
  listSessionsForSource,
  resolveScanInput,
} from "./index"
import type { SessionSummary } from "./types"

const EMPTY = { sessions: 0, messages: 0 }

interface WatchImportResult {
  sessions: number
  messages: number
}

interface WatchImportJob {
  opts: { changedPath?: string; projectId?: string }
  resolve: (result: WatchImportResult) => void
  reject: (error: unknown) => void
}

/**
 * Serialized, path-coalesced queue for watch-triggered imports.
 *
 * The fs-watch fires per change burst and an active agent appends constantly;
 * without this, every event spawned a CONCURRENT `runWatchImport` — several
 * imports parsing the same file and racing `applyImported` writes at once.
 * Calls for the same path while one is queued collapse into a single run
 * (the file is re-read anyway, so a queued re-import sees the newest bytes);
 * different paths queue FIFO. A same-path event arriving while its import is
 * RUNNING queues a fresh run, which observes state newer than the in-flight
 * read — the trailing edge is preserved, never dropped.
 */
const watchJobQueue: WatchImportJob[] = []
const pendingWatchJobs = new Map<string | undefined, Promise<WatchImportResult>>()
let watchDrainActive = false

/**
 * Per-source, per-session `updatedAt` values already re-imported by the watcher,
 * for sources that have no `summarizeFile` and therefore cannot be narrowed to
 * a single changed file.
 *
 * Without it, every OpenCode write re-parsed and re-persisted the user's
 * ENTIRE history: OpenCode keeps all sessions in one SQLite file, so the
 * watcher's "re-scan only this source" path still meant N sessions per turn.
 * `applyImported` is idempotent, so this is a cost fix, not a correctness one
 * — which is why an unseen source (no entry) still imports everything.
 */
const watermarks = new Map<string, Map<string, string>>()

/** Drop the per-source watermarks and any queued watch jobs. Tests only. */
export function __resetWatchWatermarksForTesting(): void {
  watermarks.clear()
  watchJobQueue.length = 0
  pendingWatchJobs.clear()
  // Tests that abandon a drain mid-flight (e.g. an unreleased deferred) must
  // not poison the queue for the next test.
  watchDrainActive = false
}

/**
 * Narrow a multi-session source's scan to what actually changed since the last
 * successful watch-triggered import. The first run for a source has no mark and
 * therefore imports everything.
 */
function sessionWatermarkKey(summary: SessionSummary): string {
  return summary.ref.originalSessionId || summary.ref.locator
}

function sessionWatermarkValue(summary: SessionSummary): string {
  return (
    summary.watchRevision ??
    JSON.stringify([summary.updatedAt, summary.messageCount, summary.title, summary.cwd ?? ""])
  )
}

function sinceLastWatch(sourceId: string, summaries: SessionSummary[]): SessionSummary[] {
  const previous = watermarks.get(sourceId)
  if (!previous) return summaries
  return summaries.filter((summary) => {
    if (summary.updatedAt <= 0 && !summary.watchRevision) return true
    return previous.get(sessionWatermarkKey(summary)) !== sessionWatermarkValue(summary)
  })
}

function recordImportedSessions(sourceId: string, summaries: SessionSummary[]): void {
  const marks = watermarks.get(sourceId) ?? new Map<string, string>()
  for (const summary of summaries) {
    if (summary.updatedAt > 0 || summary.watchRevision) {
      marks.set(sessionWatermarkKey(summary), sessionWatermarkValue(summary))
    }
  }
  if (marks.size > 0) watermarks.set(sourceId, marks)
}

/**
 * Re-import in response to an fs-watch event, scoped as tightly as the changed
 * path allows so an active external agent (which appends to its transcript every
 * turn) never triggers a full re-scan+re-parse of the user's ENTIRE history:
 *
 *   • `changedPath` under a one-file-per-session source (Claude Code, Codex — the
 *     ones with a cheap `summarizeFile`) → re-parse ONLY that file.
 *   • `changedPath` under a multi-session source (OpenCode's single SQLite file,
 *     Gemini/Continue dirs) → re-scan ONLY that source, and re-import only the
 *     sessions whose `updatedAt` moved since the last watch event.
 *   • no path, or a path under no known root → full re-scan (rare fallback).
 *
 * Every path routes through the guarded `importSessions` (deterministic ids +
 * merge guard), so a session the user already continued in Cognia is never
 * clobbered and re-imports are idempotent.
 */
export function runWatchImport(
  opts: { changedPath?: string; projectId?: string } = {}
): Promise<WatchImportResult> {
  const key = opts.changedPath
  const pending = pendingWatchJobs.get(key)
  if (pending) return pending
  const promise = new Promise<WatchImportResult>((resolve, reject) => {
    watchJobQueue.push({ opts, resolve, reject })
  })
  pendingWatchJobs.set(key, promise)
  kickWatchDrain()
  return promise
}

function kickWatchDrain(): void {
  if (watchDrainActive) return
  watchDrainActive = true
  void drainWatchJobs().finally(() => {
    watchDrainActive = false
    // A job pushed in the narrow window between the drain's last queue check
    // and this flag clearing would otherwise sit unprocessed forever.
    if (watchJobQueue.length > 0) kickWatchDrain()
  })
}

async function drainWatchJobs(): Promise<void> {
  while (watchJobQueue.length > 0) {
    const job = watchJobQueue.shift()!
    // Free the key BEFORE running: a fresh event for this path during the run
    // must queue a follow-up, not attach to the in-flight (older) read.
    pendingWatchJobs.delete(job.opts.changedPath)
    try {
      job.resolve(await runWatchImportNow(job.opts))
    } catch (error) {
      job.reject(error)
    }
  }
}

async function runWatchImportNow(opts: {
  changedPath?: string
  projectId?: string
}): Promise<WatchImportResult> {
  const input = await resolveScanInput()

  if (opts.changedPath) {
    const source = detectSourceForPath(opts.changedPath, input.home, input.roots)
    if (source) {
      if (source.summarizeFile) {
        // One-file-one-session: re-parse just the changed transcript.
        // `singleFile` keeps `parseGraph` from undoing the narrowing — Codex's
        // graph build otherwise walks+parses the whole corpus to find
        // children, so every transcript append would cost a full rescan.
        const ref = { sourceId: source.id, originalSessionId: "", locator: opts.changedPath }
        return importSessions([ref], input, opts.projectId, { singleFile: true })
      }
      // Watched source without a per-file summary (a dir — or a single SQLite
      // file — may hold many sessions): re-scan only this source, then
      // re-import only the sessions that moved since the last watch event.
      const summaries = await listSessionsForSource(source.id, input)
      if (summaries.length === 0) return EMPTY
      const changed = sinceLastWatch(source.id, summaries)
      if (changed.length === 0) return EMPTY
      const parsedRefs = new Set<string>()
      const result = await importSessions(
        changed.map((s) => s.ref),
        input,
        opts.projectId,
        {
          onRefParsed: (ref) => {
            parsedRefs.add(ref.originalSessionId || ref.locator)
          },
        }
      )
      // Commit the watermark only after the import resolves. A transient parse
      // or persistence rejection must leave the same sessions eligible for the
      // next filesystem event.
      recordImportedSessions(
        source.id,
        changed.filter((summary) => parsedRefs.has(sessionWatermarkKey(summary)))
      )
      return result
    }
  }

  // Fallback: full re-scan (no path hint, or the path matched no scan root).
  const summaries = await listAllSessions(input)
  if (summaries.length === 0) return EMPTY
  return importSessions(
    summaries.map((s) => s.ref),
    input,
    opts.projectId
  )
}

/**
 * The union of every registered source's desktop scan roots — handed to the
 * Rust watcher so it knows which directories to watch.
 */
export async function collectWatchRoots(): Promise<string[]> {
  const input = await resolveScanInput()
  const roots = new Set<string>()
  for (const source of getSessionSources()) {
    for (const r of source.scanRoots(input.home, input.roots)) roots.add(r)
  }
  return [...roots]
}
