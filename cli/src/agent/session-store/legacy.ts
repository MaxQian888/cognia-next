/**
 * Backward-read of the pre-canonical flat transcript
 * (`~/.cognia/sessions/<sessionId>.jsonl`, see `../transcript.ts`).
 *
 * Two hard rules, both about not destroying data we cannot regenerate:
 *
 * 1. The legacy file is NEVER modified, moved, or deleted. The canonical store
 *    is created beside it on first canonical write; if a user rolls back to an
 *    older CLI, their history is still exactly where that CLI expects it.
 * 2. A line that does not parse is COUNTED into the loss report, not skipped.
 *    `readTranscript` swallows corrupt lines by design (a read must not fail a
 *    turn); an IMPORT must not, because silently dropping three turns out of
 *    forty is indistinguishable from the model having forgotten them.
 *
 * Fidelity is `contextual`: the flat format preserves role + text but has no
 * tool calls, no permissions, no thinking, and no native runtime binding, so a
 * resumed session is a faithful CONVERSATION but not a faithful RUNTIME state.
 */

import type {
  CanonicalTurn,
  SessionLossEntry,
  SessionLossReport,
} from "@cognia/agent-config-types/canonical-session"
import type { AgentEventEnvelope } from "@cognia/agent-config-types/agent-execution"

import type { TranscriptEntry } from "../transcript"
import { legacyTranscriptPath, type SessionStoreFs } from "./paths"

export interface LegacyImport {
  /** True when a legacy transcript existed at all. */
  found: boolean
  sourcePath: string
  turns: CanonicalTurn[]
  envelopes: AgentEventEnvelope[]
  invalidLines: number
  loss: SessionLossReport
  /** Native session handle recovered from the last assistant entry's meta. */
  nativeSessionId?: string
  model?: string
  provider?: string
}

function isTranscriptEntry(value: unknown): value is TranscriptEntry {
  if (typeof value !== "object" || value === null) return false
  const entry = value as Partial<TranscriptEntry>
  return (
    typeof entry.content === "string" &&
    (entry.role === "user" || entry.role === "assistant" || entry.role === "system")
  )
}

/**
 * Read a legacy transcript and project it onto canonical turns + a synthetic
 * envelope stream (so the canonical log can be seeded with real history rather
 * than starting mid-conversation).
 */
export function importLegacyTranscript(
  home: string,
  sessionId: string,
  fsx: SessionStoreFs,
  sessionDirOverride?: string
): LegacyImport {
  const sourcePath = legacyTranscriptPath(home, sessionId, sessionDirOverride)
  const raw = fsx.readFile(sourcePath)
  const losses: SessionLossEntry[] = []

  if (raw === null) {
    return {
      found: false,
      sourcePath,
      turns: [],
      envelopes: [],
      invalidLines: 0,
      loss: { fidelity: "unsupported", losses: [] },
    }
  }

  const turns: CanonicalTurn[] = []
  const envelopes: AgentEventEnvelope[] = []
  let invalidLines = 0
  let nativeSessionId: string | undefined
  let model: string | undefined
  let provider: string | undefined
  let index = 0

  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      invalidLines += 1
      losses.push({
        path: `legacy.line[${index}]`,
        kind: "dropped",
        detail: "line is not valid JSON",
      })
      index += 1
      continue
    }
    if (!isTranscriptEntry(parsed)) {
      invalidLines += 1
      losses.push({
        path: `legacy.line[${index}]`,
        kind: "dropped",
        detail: "line is not a transcript entry (role/content missing)",
      })
      index += 1
      continue
    }

    const at = new Date(typeof parsed.ts === "number" ? parsed.ts : 0).toISOString()
    const turnId = `legacy-${index}`
    turns.push({ turnId, role: parsed.role, text: parsed.content, at })

    const meta = parsed.meta
    if (meta) {
      if (typeof meta.sdkSessionId === "string") nativeSessionId = meta.sdkSessionId
      if (typeof meta.model === "string") model = meta.model
      if (typeof meta.provider === "string") provider = meta.provider
    }

    envelopes.push({
      schemaVersion: 1,
      eventId: `${sessionId}:legacy:${index}`,
      sequence: index,
      sessionId,
      runId: "legacy-import",
      turnId,
      attemptId: "legacy-import",
      hostRef: "legacy-transcript",
      runtime: "legacy",
      timestamp: at,
      event:
        parsed.role === "user"
          ? { kind: "user-input", text: parsed.content }
          : { kind: "text-delta", delta: parsed.content },
    })
    index += 1
  }

  losses.push({
    path: "toolCalls",
    kind: "dropped",
    detail: "the flat transcript format records no tool calls or results",
  })
  losses.push({
    path: "permissions",
    kind: "dropped",
    detail: "the flat transcript format records no approval decisions",
  })

  return {
    found: true,
    sourcePath,
    turns,
    envelopes,
    invalidLines,
    loss: { fidelity: "contextual", losses, rebuilt: true },
    ...(nativeSessionId ? { nativeSessionId } : {}),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
  }
}
