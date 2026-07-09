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

const EMPTY = { sessions: 0, messages: 0 }

/**
 * Re-import in response to an fs-watch event, scoped as tightly as the changed
 * path allows so an active external agent (which appends to its transcript every
 * turn) never triggers a full re-scan+re-parse of the user's ENTIRE history:
 *
 *   • `changedPath` under a one-file-per-session source (Claude Code, Codex — the
 *     ones with a cheap `summarizeFile`) → re-parse ONLY that file.
 *   • `changedPath` under a multi-session source (e.g. Gemini/Continue dirs) →
 *     re-scan ONLY that source, not every source.
 *   • no path, or a path under no known root → full re-scan (rare fallback).
 *
 * Every path routes through the guarded `importSessions` (deterministic ids +
 * merge guard), so a session the user already continued in Cognia is never
 * clobbered and re-imports are idempotent.
 */
export async function runWatchImport(
  opts: { changedPath?: string; projectId?: string } = {}
): Promise<{ sessions: number; messages: number }> {
  const input = await resolveScanInput()

  if (opts.changedPath) {
    const source = detectSourceForPath(opts.changedPath, input.home)
    if (source) {
      if (source.summarizeFile) {
        // One-file-one-session: re-parse just the changed transcript.
        const ref = { sourceId: source.id, originalSessionId: "", locator: opts.changedPath }
        return importSessions([ref], input, opts.projectId)
      }
      // Watched source without a per-file summary (a dir may hold many sessions):
      // re-scan only this source instead of all of them.
      const summaries = await listSessionsForSource(source.id, input)
      if (summaries.length === 0) return EMPTY
      return importSessions(
        summaries.map((s) => s.ref),
        input,
        opts.projectId
      )
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
    for (const r of source.scanRoots(input.home)) roots.add(r)
  }
  return [...roots]
}
