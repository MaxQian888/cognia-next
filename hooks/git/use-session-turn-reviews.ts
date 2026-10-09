"use client"

/**
 * The turns of one conversation that can be reviewed as a diff of their own:
 * every turn the Task Workspace measured (so its patch set exists) that changed
 * at least one file. Newest first, numbered in conversation order, and labelled
 * with the prompt that started each one when the transcript is on screen.
 *
 * A turn measured only by the legacy fingerprint has counts but no patch, so it
 * has nothing to show here and is left out rather than listed as an empty diff.
 */

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import type { UIMessage } from "ai"

import { listCodeAdoptionTurnsBySession } from "@/lib/code-adoption/persist"
import type { CodeAdoptionTurnRow } from "@/lib/code-adoption/types"
import { useChatStore } from "@/stores/chat/chat-store"

export interface TurnReviewOption {
  /** Task Workspace run whose patch set is this turn's diff. */
  runId: string
  /** 1-based position among the conversation's recorded turns. */
  ordinal: number
  ts: number
  files: number
  added: number
  removed: number
  /** First line of the prompt that started the turn, when known. */
  prompt: string | null
}

const NO_MESSAGES: UIMessage[] = []
const PROMPT_MAX = 60

/** The first line of the user prompt that opened the turn `messageId` closed. */
export function promptBeforeMessage(
  messages: readonly UIMessage[],
  messageId: string | undefined
): string | null {
  if (!messageId) return null
  const at = messages.findIndex((message) => message.id === messageId)
  if (at === -1) return null
  for (let index = at - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== "user") continue
    const text = message.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join(" ")
      .trim()
    const line = text.split("\n")[0]?.trim() ?? ""
    if (!line) return null
    return line.length > PROMPT_MAX ? `${line.slice(0, PROMPT_MAX - 1)}…` : line
  }
  return null
}

/** Pure projection of the session's turn rows into picker options. */
export function turnReviewOptions(
  rows: readonly CodeAdoptionTurnRow[],
  messages: readonly UIMessage[]
): TurnReviewOption[] {
  const ordered = [...rows].sort((a, b) => a.ts - b.ts)
  const options: TurnReviewOption[] = []
  ordered.forEach((row, index) => {
    if (!row.taskWorkspaceRunId || row.measurement !== "taskWorkspace") return
    if (row.totalFiles === 0) return
    options.push({
      runId: row.taskWorkspaceRunId,
      ordinal: index + 1,
      ts: row.ts,
      files: row.totalFiles,
      added: row.totalAdded,
      removed: row.totalRemoved,
      prompt: promptBeforeMessage(messages, row.assistantMessageId),
    })
  })
  return options.reverse()
}

export function useSessionTurnReviews(sessionId: string | null | undefined): TurnReviewOption[] {
  const rows = useLiveQuery(
    async () => (sessionId ? listCodeAdoptionTurnsBySession(sessionId) : []),
    [sessionId]
  )
  const messages = useChatStore((s) =>
    !sessionId
      ? NO_MESSAGES
      : s.activeSessionId === sessionId
        ? s.messages
        : (s.sessions[sessionId]?.messages ?? NO_MESSAGES)
  )
  return useMemo(() => turnReviewOptions(rows ?? [], messages), [rows, messages])
}
