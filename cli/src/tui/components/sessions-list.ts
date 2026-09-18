/**
 * List past sessions for the `/sessions` browser. Pure over an injected
 * directory reader + the existing `readTranscript`, so it unit-tests without
 * real disk. Each summary derives a human-readable title from the first user
 * turn and the most recent activity timestamp.
 */
import path from "node:path"

import { iterTranscriptEntries, SESSIONS_DIR, type TranscriptFs } from "../../agent/transcript"
import type { SessionSummary } from "../state/types"

export type ReadDir = (dir: string) => string[]

export interface SessionsListDeps {
  readdir: ReadDir
  transcriptFs?: TranscriptFs
}

function titleFrom(content: string): string {
  const oneLine = content.replace(/\s+/g, " ").trim()
  return oneLine.length > 60 ? oneLine.slice(0, 59) + "…" : oneLine || "(empty)"
}

export function listSessions(home: string, deps: SessionsListDeps): SessionSummary[] {
  const dir = path.join(home, SESSIONS_DIR)
  let files: string[]
  try {
    files = deps.readdir(dir)
  } catch {
    return []
  }
  const summaries: SessionSummary[] = []
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue
    const sessionId = file.slice(0, -".jsonl".length)
    // Stream the entries — the summary needs only first-user/count/last-ts, so
    // materializing the whole array would multiply the scan's footprint by the
    // number of sessions listed.
    let firstUser: string | undefined
    let firstContent: string | undefined
    let turns = 0
    let updatedAt = 0
    let sawAny = false
    try {
      for (const entry of iterTranscriptEntries(home, sessionId, deps.transcriptFs)) {
        if (!sawAny) {
          sawAny = true
          firstContent = entry.content
        }
        if (entry.role === "user") {
          turns++
          if (firstUser === undefined) firstUser = entry.content
        }
        updatedAt = entry.ts
      }
    } catch {
      // A disappearing/unreadable transcript must not hide every other session.
      continue
    }
    if (!sawAny) continue
    summaries.push({
      sessionId,
      title: titleFrom(firstUser ?? firstContent ?? ""),
      turns,
      updatedAt,
    })
  }
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
}
