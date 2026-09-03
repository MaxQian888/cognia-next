/**
 * The client half of a host-driven external agent run.
 *
 * The turn does not come back through the RPC that started it. It arrives as
 * frames on `external-agent://session-event`, which rides the companion event
 * bus — so reconnects, replay and ordering are the bus's problem, already
 * solved, and this module only has to do the part the bus cannot: decide which
 * frames belong to THIS run and which of them it has already applied.
 *
 * Dedup is by the frame's per-run `seq` rather than by the bus cursor. The bus
 * cursor is global across every topic a client subscribes to, so after a replay
 * a client cannot tell from it whether a given external-agent frame is new.
 * The per-run sequence can answer that, and it also makes a *gap* visible —
 * which matters, because silently rendering a turn with a hole in it looks
 * exactly like a turn that went quiet.
 */

import { transport } from "@/lib/tauri"
import type { AcpElicitationResponse, ExternalAgentEvent } from "@/types/agent/external-agent"
import type { ApprovalDecision } from "@cognia/agent-config-types"
import type { ExternalAgentConfigStamp } from "@/types/agent/external-agent-config-store"

import type { RunAdmissionRefusal } from "./run-admission"
import { EXTERNAL_RUN_EVENT_TOPIC, type RemoteRunFrame } from "./remote-run-service"
import {
  HOST_CONFIG_COMMANDS,
  callApprovedHostConfigCommand,
  callHostConfigCommand,
} from "./remote-host-configs"

export { EXTERNAL_RUN_EVENT_TOPIC }
export type { RemoteRunFrame }

/**
 * Named from the shared table rather than re-spelled, so the run plane and the
 * configuration plane cannot drift on a command name — and so every call below
 * goes through `callHostConfigCommand`, which checks the host handshake for
 * this operation before it reaches the transport. Calling `transport.call`
 * directly would answer a host too old to run turns with an "unknown command"
 * instead of the structured "this host does not support it" every sibling
 * operation gives.
 */
export const REMOTE_RUN_COMMANDS = Object.freeze({
  run: HOST_CONFIG_COMMANDS.run,
  cancel: HOST_CONFIG_COMMANDS.cancel,
  resolve: HOST_CONFIG_COMMANDS.resolve,
} as const)

export type RemoteTurnStart =
  | { started: true; runId: string; agentId: string }
  | { started: false; refusal: RunAdmissionRefusal }

export interface RemoteRunSubscription {
  onEvent: (event: ExternalAgentEvent, frame: RemoteRunFrame) => void
  /** Called once, with how the run ended. */
  onTerminal: (terminal: NonNullable<RemoteRunFrame["terminal"]>, error: string | undefined) => void
  /**
   * A frame arrived out of order and the ones between were never seen.
   *
   * Reported rather than papered over: the client that owns the transcript is
   * the only thing that can decide whether to re-read or to mark the turn
   * incomplete, and rendering the later frame as if nothing were missing is the
   * one option that is always wrong.
   */
  onGap?: (expected: number, received: number) => void
}

/**
 * Watch one run. Returns an unsubscribe function.
 *
 * Subscribe BEFORE starting the turn: the host begins streaming the moment it
 * accepts, and a subscription opened afterwards would miss the opening frames.
 */
export function subscribeRemoteExternalRun(
  runId: string,
  handlers: RemoteRunSubscription
): () => void {
  let lastSeq = 0
  let settled = false

  return transport.subscribe<RemoteRunFrame>(EXTERNAL_RUN_EVENT_TOPIC, (frame) => {
    if (!frame || frame.runId !== runId) return
    // A terminal frame is authoritative and singular. Anything after it is a
    // replay of a run this client has already finished rendering.
    if (settled) return
    if (frame.seq <= lastSeq) return
    if (frame.seq > lastSeq + 1) handlers.onGap?.(lastSeq + 1, frame.seq)
    lastSeq = frame.seq

    handlers.onEvent(frame.event, frame)
    if (frame.terminal) {
      settled = true
      handlers.onTerminal(frame.terminal, frame.error)
    }
  })
}

export async function startRemoteExternalTurn(input: {
  runId: string
  chatSessionId: string
  stamp: ExternalAgentConfigStamp
  prompt: string
  externalSessionId?: string
}): Promise<RemoteTurnStart> {
  // Starting a turn is an interactive approval, like the configuration writes
  // beside it. `callHostConfigCommand` checks the handshake but attaches no
  // lease, and the host refuses an interactive command that arrives without
  // one, so this is the only call shape that can actually start a run.
  const result = await callApprovedHostConfigCommand<{
    started: boolean
    runId?: string
    agentId?: string
    refusal?: RunAdmissionRefusal
  }>(REMOTE_RUN_COMMANDS.run, {
    runId: input.runId,
    chatSessionId: input.chatSessionId,
    prompt: input.prompt,
    stamp: { ...input.stamp },
    ...(input.externalSessionId ? { externalSessionId: input.externalSessionId } : {}),
  })

  if (result.started && result.runId) {
    return { started: true, runId: result.runId, agentId: result.agentId ?? "" }
  }
  return {
    started: false,
    refusal: result.refusal ?? { kind: "config", reason: "unknown-config" },
  }
}

/**
 * Ask the host to stop a run.
 *
 * `true` means this call ended it — a terminal frame is on its way *because of
 * it*. `false` means the host had nothing to stop, which is the ordinary answer
 * when the turn finished a moment earlier.
 */
export async function cancelRemoteExternalTurn(runId: string): Promise<boolean> {
  const result = await callHostConfigCommand<{ cancelled: boolean }>(REMOTE_RUN_COMMANDS.cancel, {
    runId,
  })
  return result.cancelled === true
}

export type RemoteDecisionOutcome =
  { resolved: true } | { resolved: false; reason: "unknown" | "wrong-device" }

/** Answer a permission the running agent is blocked on. */
export async function resolveRemotePermission(
  decisionId: string,
  decision: ApprovalDecision
): Promise<RemoteDecisionOutcome> {
  return resolve({ decisionId, decision })
}

/** Answer an elicitation. The host stamps the request id, so it is not sent. */
export async function resolveRemoteElicitation(
  decisionId: string,
  response: AcpElicitationResponse
): Promise<RemoteDecisionOutcome> {
  return resolve({ decisionId, elicitation: response })
}

async function resolve(payload: Record<string, unknown>): Promise<RemoteDecisionOutcome> {
  const result = await callHostConfigCommand<{ resolved: boolean; reason?: string }>(
    REMOTE_RUN_COMMANDS.resolve,
    payload
  )
  if (result.resolved) return { resolved: true }
  return {
    resolved: false,
    reason: result.reason === "wrong-device" ? "wrong-device" : "unknown",
  }
}
