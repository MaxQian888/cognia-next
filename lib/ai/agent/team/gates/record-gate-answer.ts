/**
 * Leave a record of an answered gate in the conversation the run belongs to.
 *
 * The gate dialog is mounted at the app root on purpose — a budget or plan
 * gate has to be answerable from whatever surface the user is on, not only
 * from the thread that started the run. The cost of that is a modal which
 * vanishes when answered, leaving nothing behind: no way to see later what
 * was approved, or when, or that a gate happened at all.
 *
 * So the decision is written back. Best-effort throughout: a gate must never
 * fail to resolve because the record could not be stored — the run is waiting
 * on the answer, and losing the answer is far worse than losing the note.
 *
 * The conversation is found through `ExecutionRun.sessionId`, which
 * `startSquadRun` stamps for chat-started runs. A run with no session (a
 * scheduled run, an IM run, a workflow node) simply has nowhere to write, and
 * this does nothing.
 */

import type { UIMessage } from "ai"

import { getExecutionRun } from "@/lib/db/execution-runs"
import { commitMessageDelta } from "@/lib/db/messages"
import { useChatStore } from "@/stores/chat"
import type { SquadGatePart } from "@/lib/claude/parts-extensions"

export interface RecordGateAnswerInput {
  /** Execution run id, or the raw team run id — both resolve. */
  runId?: string
  gateType: string
  decision: SquadGatePart["decision"]
  title: string
  answeredAt?: number
}

export interface RecordGateAnswerDeps {
  loadRun?: typeof getExecutionRun
  commit?: typeof commitMessageDelta
  appendToStore?: (sessionId: string, message: UIMessage) => void
  newId?: () => string
}

/**
 * @returns the session the record landed in, or `null` when there was nowhere
 * to write it (no run, no bound conversation, or the write failed).
 */
export async function recordSquadGateAnswer(
  input: RecordGateAnswerInput,
  deps: RecordGateAnswerDeps = {}
): Promise<string | null> {
  const runId = input.runId?.trim()
  if (!runId) return null

  const loadRun = deps.loadRun ?? getExecutionRun
  const commit = deps.commit ?? commitMessageDelta
  const appendToStore =
    deps.appendToStore ??
    ((sessionId, message) => useChatStore.getState().appendSessionMessage(sessionId, message))
  const newId = deps.newId ?? (() => crypto.randomUUID())

  try {
    const run = await loadRun(runId)
    const sessionId = run?.sessionId
    if (!sessionId) return null

    const part: SquadGatePart = {
      type: "squad-gate",
      runId,
      gateType: input.gateType,
      decision: input.decision,
      title: input.title,
      answeredAt: input.answeredAt ?? Date.now(),
    }
    const message: UIMessage = {
      id: newId(),
      role: "assistant",
      parts: [part] as unknown as UIMessage["parts"],
    }

    // Persist as a single-message delta rather than a whole-transcript write:
    // the chat controller owns the full list, and a second writer replacing it
    // would race whatever turn is in flight.
    await commit(sessionId, { upserts: [message] })
    appendToStore(sessionId, message)
    return sessionId
  } catch {
    // A gate must resolve even if its note cannot be stored.
    return null
  }
}
