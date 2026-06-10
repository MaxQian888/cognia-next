/**
 * `/export` controller — write the active session's transcript to a file in the
 * working directory, in markdown / json / jsonl. Reuses the CLI's append-only
 * transcript store (`readTranscript`) as the authoritative source and the pure
 * `formatTranscriptExport` renderer. All fs effects are injectable for tests.
 */
import fs from "node:fs"
import path from "node:path"

import { readTranscript, type TranscriptEntry, type TranscriptFs } from "../../agent/transcript"
import { exportExtension, formatTranscriptExport, normalizeExportFormat } from "../format/export"
import { errorMessage } from "./shared"
import type { TuiAction } from "../state/types"

export interface ExportDeps {
  dispatch: (action: TuiAction) => void
  /** Config home (`~/.cognia`) — where session transcripts live. */
  home: string
  sessionId: string
  /** Working directory the export file is written into. */
  cwd: string
  read?: (home: string, sessionId: string) => TranscriptEntry[]
  write?: (absPath: string, content: string) => void
  transcriptFs?: TranscriptFs
}

export async function exportSession(formatArg: string, deps: ExportDeps): Promise<void> {
  const read = deps.read ?? ((h, s) => readTranscript(h, s, deps.transcriptFs))
  const entries = read(deps.home, deps.sessionId)
  if (entries.length === 0) {
    deps.dispatch({
      type: "NOTICE",
      message: "Nothing to export yet — this session has no turns.",
    })
    return
  }
  const format = normalizeExportFormat(formatArg)
  const content = formatTranscriptExport(entries, format)
  const target = path.join(deps.cwd, `cognia-export-${deps.sessionId}.${exportExtension(format)}`)
  const write = deps.write ?? ((p, c) => fs.writeFileSync(p, c, "utf8"))
  try {
    write(target, content)
  } catch (err) {
    deps.dispatch({ type: "NOTICE", message: `Export failed: ${errorMessage(err)}` })
    return
  }
  deps.dispatch({
    type: "NOTICE",
    message: `Exported ${entries.length} ${entries.length === 1 ? "entry" : "entries"} → ${target}`,
  })
}
