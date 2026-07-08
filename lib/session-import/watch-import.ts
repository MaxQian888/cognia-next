// Background (non-UI) re-import driven by the fs-watch (ADR-0062, T5).
//
// Distinct from the `useSessionImport` hook (which drives a UI state machine):
// this is a plain async entry the watch hook calls on a `session-import://changed`
// event. It re-scans the sources and re-imports through the SAME guarded
// `applyImported` (`applyImportedMerged`), so a session the user already
// continued in Cognia is never clobbered (its row is frozen and skipped).

import { getSessionSources, importSessions, listAllSessions, resolveScanInput } from "./index"

/**
 * Re-scan + re-import. When `changedPath` maps to exactly one listed session
 * (the common JSONL case), only that session is re-imported; otherwise every
 * session is re-imported (idempotent via the deterministic ids + merge guard).
 */
export async function runWatchImport(
  opts: { changedPath?: string; projectId?: string } = {}
): Promise<{ sessions: number; messages: number }> {
  const input = await resolveScanInput()
  const summaries = await listAllSessions(input)
  if (summaries.length === 0) return { sessions: 0, messages: 0 }

  let refs = summaries.map((s) => s.ref)
  if (opts.changedPath) {
    const scoped = summaries.filter((s) => s.ref.locator === opts.changedPath).map((s) => s.ref)
    if (scoped.length > 0) refs = scoped
  }
  return importSessions(refs, input, opts.projectId)
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
