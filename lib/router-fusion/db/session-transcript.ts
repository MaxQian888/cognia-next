/**
 * A Run API run's conversation, written into its session (ADR-0188 D24,
 * DESIGN §12.1).
 *
 * The run is created with its input and ends with its answer; both belong in
 * the session the caller continues and the app shows. They cross from the
 * fusion database to the account database as `session_message` outbox effects,
 * so a crash between the two replays them instead of losing them:
 *
 * - `input` — the caller's messages, appended when the run is created;
 * - `answer` — the verified answer, appended when the run succeeds (a chat
 *   fusion turn writes only this, with the run card's summary on it);
 * - `marker` — a run that did not succeed keeps its input, marked with how it
 *   ended. No answer is ever invented for it.
 *
 * Message ids are derived from the run, so an effect applied twice writes the
 * same rows; and a replay that finds them already written changes nothing,
 * which keeps the session version from moving on a replay.
 */

import type { ChatSession, RouterFusionRunSummary } from "@cognia/agent-config-types"
import type { Message } from "@cognia/router-fusion"

import type { OutboxApplyResult, OutboxContext } from "./outbox"
import { decodeRunInput } from "./run-input"
import type { FusionOutboxRow } from "./types"

export interface TranscriptMessage {
  id: string
  role: "user" | "assistant" | "system"
  parts: Array<{ type: "text"; text: string }>
  metadata: Record<string, unknown>
}

export interface SessionTranscriptDeps {
  getSession: (sessionId: string) => Promise<ChatSession | undefined>
  /** The stored rows with these ids, in order (undefined for a missing one). */
  getMessages: (
    ids: string[]
  ) => Promise<Array<{ id: string; parts?: unknown; metadata?: unknown } | undefined>>
  commit: (sessionId: string, upserts: TranscriptMessage[]) => Promise<void>
}

type SessionMessagePayload =
  | {
      phase: "input"
      runId: string
      sessionId: string
      inputArtifactId: string
      actorKeyName?: string | null
    }
  | {
      phase: "answer"
      runId: string
      sessionId: string
      answerArtifactId: string
      mode?: string
      /** A chat fusion turn's answer carries the run card's summary. */
      origin?: "chat"
      summary?: RouterFusionRunSummary
    }
  | {
      phase: "marker"
      runId: string
      sessionId: string
      inputArtifactId: string
      actorKeyName?: string | null
      status: string
      errorCode?: string
    }

export function inputMessageId(runId: string, index: number): string {
  return `rf-${runId}-input-${index}`
}

export function answerMessageId(runId: string): string {
  return `rf-${runId}-answer`
}

/**
 * A run's answer as a transcript row. The chat path builds the same row to
 * show the answer at once, so the one the outbox writes is identical to it.
 */
export function answerMessage(
  run: { runId: string; mode?: string; origin?: "chat"; summary?: RouterFusionRunSummary },
  answer: string
): TranscriptMessage {
  return {
    id: answerMessageId(run.runId),
    role: "assistant",
    parts: [{ type: "text", text: answer }],
    metadata: {
      routerFusion: {
        runId: run.runId,
        ...(run.mode ? { mode: run.mode } : {}),
        ...(run.origin ? { origin: run.origin } : {}),
      },
      // Where the chat's message shell looks for a run card.
      ...(run.summary ? { run: { routerFusion: { fusion: run.summary } } } : {}),
    },
  }
}

function parseInput(content: string | null): Message[] | null {
  return decodeRunInput(content)?.messages ?? null
}

function inputRows(
  payload: Extract<SessionMessagePayload, { phase: "input" | "marker" }>,
  messages: Message[],
  outcome: { status: string; errorCode?: string } | null
): TranscriptMessage[] {
  return messages.map((message, index) => ({
    id: inputMessageId(payload.runId, index),
    role: message.role,
    parts: [{ type: "text", text: message.content }],
    metadata: {
      // The gateway's caller wrote this, not the person at the keyboard: the
      // app's own "on new message" workflows are not theirs to trigger.
      triggerWorkflows: false,
      routerFusion: {
        runId: payload.runId,
        origin: "gateway-api",
        ...(payload.actorKeyName ? { keyName: payload.actorKeyName } : {}),
        ...(outcome ? { runStatus: outcome.status } : {}),
        ...(outcome?.errorCode ? { errorCode: outcome.errorCode } : {}),
      },
    },
  }))
}

function sameRow(
  stored: { parts?: unknown; metadata?: unknown } | undefined,
  row: TranscriptMessage
): boolean {
  if (!stored) return false
  return (
    JSON.stringify(stored.parts ?? null) === JSON.stringify(row.parts) &&
    JSON.stringify(
      (stored.metadata as Record<string, unknown> | undefined)?.routerFusion ?? null
    ) === JSON.stringify(row.metadata.routerFusion)
  )
}

export async function applySessionMessage(
  row: FusionOutboxRow,
  context: OutboxContext,
  deps: SessionTranscriptDeps
): Promise<OutboxApplyResult> {
  const payload = row.payload as unknown as SessionMessagePayload
  if (!payload?.runId || !payload.sessionId) return "skipped"
  // The person deleted the conversation: there is nothing to write into.
  if (!(await deps.getSession(payload.sessionId))) return "skipped"

  let rows: TranscriptMessage[]
  if (payload.phase === "answer") {
    const answer = await context.readArtifact(payload.answerArtifactId)
    // The answer's content window has passed before the effect could apply.
    if (answer === null) return "skipped"
    rows = [answerMessage(payload, answer)]
  } else if (payload.phase === "input" || payload.phase === "marker") {
    const messages = parseInput(await context.readArtifact(payload.inputArtifactId))
    if (!messages || messages.length === 0) return "skipped"
    rows = inputRows(
      payload,
      messages,
      payload.phase === "marker"
        ? { status: payload.status, ...(payload.errorCode ? { errorCode: payload.errorCode } : {}) }
        : null
    )
  } else {
    return "skipped"
  }

  const stored = await deps.getMessages(rows.map((r) => r.id))
  if (rows.every((r, i) => sameRow(stored[i], r))) return "skipped"
  // An input effect retried after the run's marker landed must not wipe the marker.
  if (
    payload.phase === "input" &&
    stored.some((entry) => {
      const meta = (entry?.metadata as { routerFusion?: { runStatus?: unknown } } | undefined)
        ?.routerFusion
      return meta?.runStatus !== undefined
    })
  ) {
    return "skipped"
  }
  await deps.commit(payload.sessionId, rows)
  return "applied"
}
