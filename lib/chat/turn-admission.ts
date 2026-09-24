/**
 * Whether a user turn actually ran, recorded on the user's own message.
 *
 * Two outcomes used to leave the transcript row looking like any other sent
 * message:
 *
 *  - **Queued.** A send whose working tree was held (a plan step, another
 *    conversation in the same checkout) waited inside the execution broker with
 *    nothing on screen. The message only appeared minutes later, when the
 *    holder let go.
 *  - **Failed before it ran.** An external runtime that died during startup —
 *    Pi exiting before its extension was ready, an agent process id still held
 *    by another process — produced a transient toast while the row itself
 *    carried no mark, so the user could not tell the turn had never run.
 *
 * The state rides in `metadata.turnAdmission`, persisted with the message, so
 * it survives a reload. `queued` is only live while the send that wrote it is
 * still waiting in THIS realm (`isChatTurnQueued`); a persisted `queued` whose
 * waiter is gone — the app was closed mid-wait — is shown as `interrupted`,
 * derived at render time the same way `resolveSteerDisplayState` treats a
 * queued follow-up whose queue did not survive a restart.
 */

import type { UIMessage } from "ai"
import type { ExecutionAdmissionBlocker, ExecutionLegKind } from "@/lib/execution/types"

/** What a queued turn is waiting for, reduced to what the row can say. */
export interface TurnAdmissionWait {
  reason: ExecutionAdmissionBlocker["reason"]
  /** For `slot`: the kind of work holding the working tree. */
  holderKind?: ExecutionLegKind
  /** For `slot`: that work's own label (a plan title, a conversation title). */
  holderLabel?: string
}

export type TurnAdmissionMeta =
  | { state: "queued"; waitingFor: TurnAdmissionWait; since: number }
  | {
      state: "failed"
      /** A `DiagnosticCode`; the row renders its localized label and hint. */
      code: string
      /** The runtime's own words, for the disclosure — never the headline. */
      detail?: string
      at: number
    }

export type TurnAdmissionDisplay = "queued" | "failed" | "interrupted"

const KEY = "turnAdmission"

/** Read `metadata.turnAdmission`, validating the shape a stored row carries. */
export function turnAdmissionMetaOf(metadata: unknown): TurnAdmissionMeta | null {
  if (!metadata || typeof metadata !== "object") return null
  const value = (metadata as Record<string, unknown>)[KEY]
  if (!value || typeof value !== "object") return null
  const meta = value as Partial<Record<string, unknown>>
  if (meta.state === "queued") {
    const waitingFor = meta.waitingFor as Partial<TurnAdmissionWait> | undefined
    if (!waitingFor || typeof waitingFor.reason !== "string") return null
    return value as TurnAdmissionMeta
  }
  if (meta.state === "failed" && typeof meta.code === "string") return value as TurnAdmissionMeta
  return null
}

/** Reduce a broker blocker to the part a transcript row can show. */
export function waitFromBlocker(blocker: ExecutionAdmissionBlocker): TurnAdmissionWait {
  if (blocker.reason !== "slot" || !blocker.holder) return { reason: blocker.reason }
  return {
    reason: "slot",
    holderKind: blocker.holder.kind,
    ...(blocker.holder.label ? { holderLabel: blocker.holder.label } : {}),
  }
}

/** A copy of `message` carrying `meta`, or with the mark removed when null. */
export function withTurnAdmission(message: UIMessage, meta: TurnAdmissionMeta | null): UIMessage {
  const metadata = { ...((message.metadata as Record<string, unknown> | undefined) ?? {}) }
  if (meta) metadata[KEY] = meta
  else if (!(KEY in metadata)) return message
  else delete metadata[KEY]
  return { ...message, metadata } as UIMessage
}

/**
 * The id of the user message a turn belongs to: `messageId` when the send
 * appended one, otherwise the last user message (a regenerate or a steer
 * replay re-issues a turn that is already in the transcript).
 */
export function turnMessageId(
  messages: readonly UIMessage[],
  messageId?: string | null
): string | null {
  if (messageId && messages.some((message) => message.id === messageId)) return messageId
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return messages[index].id
  }
  return null
}

/**
 * `messages` with the turn's user message re-marked. Returns the same array
 * when there is nothing to change, so a caller can skip a store write.
 */
export function markTurnAdmission(
  messages: UIMessage[],
  messageId: string | null,
  meta: TurnAdmissionMeta | null
): UIMessage[] {
  if (!messageId) return messages
  let changed = false
  const next = messages.map((message) => {
    if (message.id !== messageId) return message
    const marked = withTurnAdmission(message, meta)
    if (marked !== message) changed = true
    return marked
  })
  return changed ? next : messages
}

/**
 * What the row should show. `stillQueued` is whether the send that wrote a
 * `queued` mark is still waiting; once it is not, the mark is a leftover of a
 * wait that ended without the turn running.
 */
export function resolveTurnAdmissionDisplay(
  meta: TurnAdmissionMeta,
  ctx: { stillQueued: boolean }
): TurnAdmissionDisplay {
  if (meta.state === "failed") return "failed"
  return ctx.stillQueued ? "queued" : "interrupted"
}
