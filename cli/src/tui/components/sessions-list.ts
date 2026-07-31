/**
 * List past sessions for the `/sessions` browser. Pure over an injected
 * directory reader + the existing `readTranscript`, so it unit-tests without
 * real disk. Each summary derives a human-readable title from the first user
 * turn and the most recent activity timestamp.
 */
import path from "node:path"

import { readTranscript, SESSIONS_DIR, type TranscriptFs } from "../../agent/transcript"
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
    const entries = readTranscript(home, sessionId, deps.transcriptFs)
    if (entries.length === 0) continue
    const firstUser = entries.find((e) => e.role === "user")
    const turns = entries.filter((e) => e.role === "user").length
    const updatedAt = entries[entries.length - 1].ts
    summaries.push({
      sessionId,
      title: titleFrom(firstUser?.content ?? entries[0].content),
      turns,
      updatedAt,
    })
  }
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
}
