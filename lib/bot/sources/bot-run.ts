/**
 * A finished Bot run becomes a Bot event.
 *
 * This is the source a Bot must opt into, and the only one where the loop is
 * the default rather than the exception. `provenanceForBotOutput` stamps who
 * produced it and how many generations deep the chain is, and
 * `evaluateBotLoopGuard` refuses it unless the installation's own ceiling says
 * `allowSelfTriggering`, or the depth cap has been reached.
 *
 * Ids, never heuristics. Matching on a display name or a bot account breaks
 * the moment a workspace renames something, and what breaks is the only thing
 * standing between a Bot and answering itself forever.
 */

import { buildBotEventEnvelope } from "@/lib/bot/events/envelope"
import { dispatchBotEvent, type DispatchBotEventResult } from "@/lib/bot/events/dispatch"
import { provenanceForBotOutput } from "@/lib/bot/events/provenance"
import type { BotEventEnvelopeV1 } from "@/types/bot/event"

/** Dotted type a `source: "bot"` trigger matches. */
export function botRunEventType(status: "completed" | "failed"): string {
  return `bot.run.${status}`
}

export interface DispatchBotRunToBotsInput {
  runId: string
  installationId: string
  botId: string
  status: "completed" | "failed"
  summary?: string
  /** The envelope that started the finished run, for the causation chain. */
  cause: BotEventEnvelopeV1
}

/** Project one settled Bot run onto the Bot plane. */
export async function dispatchBotRunToBots(
  input: DispatchBotRunToBotsInput
): Promise<DispatchBotEventResult> {
  const now = Date.now()
  const type = botRunEventType(input.status)
  const envelope = buildBotEventEnvelope({
    source: "bot",
    sourceRecordId: input.runId,
    type,
    installationId: "",
    triggerId: "",
    occurredAt: now,
    receivedAt: now,
    payload: {
      runId: input.runId,
      botId: input.botId,
      installationId: input.installationId,
      status: input.status,
      ...(input.summary ? { summary: input.summary } : {}),
    },
    provenance: provenanceForBotOutput({
      runId: input.runId,
      installationId: input.installationId,
      cause: input.cause,
    }),
    actor: { kind: "bot", id: input.botId },
    resource: { kind: "bot_run", id: input.runId, scope: input.installationId },
  })

  const { installationId: _i, triggerId: _t, deliveryId: _d, ...routable } = envelope

  return dispatchBotEvent({ envelope: routable, query: { source: "bot", type }, now })
}
