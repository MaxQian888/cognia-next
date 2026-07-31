// Shared desktop-scan driver for per-file JSONL session sources (Claude Code,
// Codex, …). Walks the source's roots, reads each matching file ONCE, and turns
// it into a `SessionSummary` via the adapter's lightweight `summarizeFile` — no
// full parse, no `StoredMessage` allocation (see `AgentSessionSourceAdapter.
// summarizeFile`). The heavy `parseSession` is paid later, only for the
// sessions the user actually imports.

import { walkFiles } from "./fs"
import type { PickedSessionFile, SessionScanInput, SessionSummary } from "./types"

/** A file's raw content → its summary, or null when it holds no session. */
export type SummarizeFile = (content: string, locator: string) => SessionSummary | null

/**
 * List summaries for a per-file source, from either the desktop walk or the
 * hand-picked files. Reads each file exactly once and summarizes it cheaply.
 * Unreadable files and null summaries are skipped; the result is newest-first.
 */
export async function scanFileSummaries(
  input: SessionScanInput,
  roots: string[],
  accept: (name: string) => boolean,
  summarize: SummarizeFile
): Promise<SessionSummary[]> {
  const summaries: SessionSummary[] = []

  if (input.pickedFiles?.length) {
    for (const file of pickedMatching(input.pickedFiles, accept)) {
      const summary = summarize(file.content, file.path)
      if (summary) summaries.push(summary)
    }
    return sortNewestFirst(summaries)
  }

  for (const root of roots) {
    const files = await walkFiles(input.fs, root, accept)
    for (const file of files) {
      let content: string
      try {
        content = await input.fs.readTextFile(file)
      } catch {
        // Skip an unreadable transcript rather than sinking the whole scan.
        continue
      }
      const summary = summarize(content, file)
      if (summary) summaries.push(summary)
    }
  }
  return sortNewestFirst(summaries)
}

/** Picked files whose basename passes `accept`. */
function pickedMatching(
  files: PickedSessionFile[],
  accept: (name: string) => boolean
): PickedSessionFile[] {
  return files.filter((f) => accept(f.name))
}

function sortNewestFirst(summaries: SessionSummary[]): SessionSummary[] {
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
}
