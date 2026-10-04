"use client"

/**
 * The outbound queue as one line of UI: how many writes are waiting, how many
 * are on the wire, how many stopped for good, whether the Host is holding them
 * for a human's approval — and the sentence that says so.
 *
 * Two surfaces report it: the shell's `OfflineBanner`, and, while the Host is
 * unreachable on a conversation, the chat's runtime strip on the composer
 * (which then claims the report so the banner stands down). One source, so the
 * two cannot count or word it differently.
 *
 * The counts come from a Dexie live query, so enqueued and drained rows update
 * it reactively rather than on a polling timer.
 */

import { useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"

import { useClientLiveQuery } from "@/hooks/data"
import { getQueueSummary, inFlight, needsAttention } from "@/lib/queue/outbound-queue"
import {
  outboundConsentCode,
  PENDING_NO_CODE,
  subscribeOutboundApproval,
} from "@/lib/queue/outbound-approval"

export interface OutboundQueueStatus {
  /** Rows on their way: pending plus sending. */
  pending: number
  /** Of `pending`, the rows on the wire right now. */
  sending: number
  /** Rows the Host refused, ran out of retries on, or that lost a race. */
  stuck: number
  /** The Host is holding the queue for an interactive approval. */
  awaitingApproval: boolean
  /** Rows exist — there is a list worth opening. */
  hasRows: boolean
  /** Anything to report at all. */
  visible: boolean
  /** The one sentence for the line (empty when not `visible`). */
  message: string
}

export function useOutboundQueueStatus(): OutboundQueueStatus {
  const t = useTranslations("mobile.offline")
  // A queue frozen on an interactive approval is not offline, not retrying and
  // not stuck: the Host is asking a human, and until someone answers, the rows
  // simply do not move.
  const consentCode = useSyncExternalStore(
    subscribeOutboundApproval,
    outboundConsentCode,
    () => null
  )
  const queue = useClientLiveQuery<{ inFlight: number; sending: number; stuck: number }>(
    async () => {
      const summary = await getQueueSummary()
      return {
        inFlight: inFlight(summary),
        sending: summary.sending,
        stuck: needsAttention(summary),
      }
    },
    [],
    { inFlight: 0, sending: 0, stuck: 0 }
  )

  const pending = queue?.inFlight ?? 0
  // "2 queued" over a card reading "Sending" looked like two accounts of one
  // action, so both lanes are named when both are occupied.
  const sending = Math.min(queue?.sending ?? 0, pending)
  const stuck = queue?.stuck ?? 0
  const awaitingApproval = consentCode !== null
  const hasRows = pending > 0 || stuck > 0
  const visible = hasRows || awaitingApproval

  const message = !visible
    ? ""
    : consentCode
      ? consentCode === PENDING_NO_CODE
        ? t("queueAwaitingApprovalNoCode")
        : t("queueAwaitingApproval", { code: consentCode })
      : stuck > 0
        ? t("queueNeedsAttention", { count: stuck })
        : sending > 0
          ? t("queuePendingWithSending", { count: pending, sending })
          : t("queuePending", { count: pending })

  return { pending, sending, stuck, awaitingApproval, hasRows, visible, message }
}
