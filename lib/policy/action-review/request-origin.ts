/**
 * Who asked for an outbound action, where they asked, and which instruction
 * of theirs is current (ADR-0239).
 *
 * The engine needs three facts about a run besides its targets:
 *
 * - the **requester**, the person the run is acting for;
 * - the **origin thread**, the conversation the request came from, which it
 *   may deliver to without asking because that is replying to the person who
 *   asked;
 * - the **instruction epoch**, the id of the requester's latest instruction.
 *   A human denial fences the same recipient for the rest of the epoch, and
 *   an instruction grant lasts for it.
 *
 * Only the requester's own new message advances the epoch. A trigger, the
 * model, a subagent, a teammate, a peer session, an external app and another
 * member of a group are not the requester, so their messages leave it where
 * it was: none of them can lift a fence or end a grant by talking.
 *
 * Pure: every input is passed in. `resolve-request-origin.ts` reads them for a
 * session; a scheduled task or a Bot carries its own.
 */

import type { UIMessage } from "ai"

import { isAutomatedTurnMetadata } from "@cognia/agent-config-types/automated-turn"

import { readScheduleProvenance } from "@/lib/scheduler/schedule-provenance"
import type { ScheduledTaskPayload } from "@/types/scheduler"

import { conversationTarget, type OutboundTarget } from "./outbound-targets"

/**
 * - `local`: the person at this app or one of their paired devices.
 * - `im`: the IM sender whose inbound message is driving the turn.
 * - `member`: the organization member whose queued request a shared
 *   (collaboration) session run is serving.
 */
export type ActionRequester =
  | { kind: "local" }
  | { kind: "im"; remoteUserId: string; platformIdentityId?: string }
  | { kind: "member"; userId: string }

/**
 * Metadata keys an existing producer already sets on the `role: "user"` rows
 * it writes, each naming something other than a person giving an instruction
 * now. Producers that had no marker stamp `automatedTurn`
 * (`@cognia/agent-config-types/automated-turn`) instead. Pinned by
 * `request-origin.test.ts`.
 */
export const NON_INSTRUCTION_METADATA_KEYS = [
  // A Lark chat's history imported into the conversation
  // (`lib/connectors/adapters/lark/message-import.ts`).
  "larkImport",
  // A transcript imported from another agent tool (`lib/session-import/`).
  "importSourceOwned",
  // A run submitted through the gateway API by a program holding a key
  // (`lib/router-fusion/db/session-transcript.ts`).
  "routerFusion",
] as const

/**
 * A message another session sent (`lib/chat/session-peer-delivery.ts`). One
 * the person wrote in the communication sheet (`origin: "user"`) is theirs;
 * one an agent sent is not.
 */
function isAgentPeerMessage(meta: Record<string, unknown>): boolean {
  const peer = meta.sessionPeerMessage
  if (peer === undefined) return false
  return !(peer && typeof peer === "object" && (peer as { origin?: unknown }).origin === "user")
}

type MessageMetadata = Record<string, unknown> & {
  platformMessage?: { sender?: { id?: unknown; remoteUserId?: unknown } }
  collaboration?: { author?: { kind?: unknown; id?: unknown } }
}

function metadataOf(message: Pick<UIMessage, "metadata">): MessageMetadata {
  const meta = message.metadata
  return meta && typeof meta === "object" ? (meta as MessageMetadata) : {}
}

/** True when `message` is an instruction `requester` gave. */
export function isRequesterInstruction(
  message: Pick<UIMessage, "role" | "metadata">,
  requester: ActionRequester
): boolean {
  if (message.role !== "user") return false
  const meta = metadataOf(message)
  if (isAutomatedTurnMetadata(meta) || isAgentPeerMessage(meta)) return false
  if (NON_INSTRUCTION_METADATA_KEYS.some((key) => meta[key] !== undefined)) return false
  const sender = meta.platformMessage?.sender
  const author = meta.collaboration?.author

  switch (requester.kind) {
    case "im": {
      if (!sender) return false
      if (requester.platformIdentityId && sender.id === requester.platformIdentityId) return true
      return sender.remoteUserId === requester.remoteUserId
    }
    case "member":
      return !sender && author?.kind === "human" && author.id === requester.userId
    case "local":
      // An IM sender, a shared-session member and a room participant written
      // in by another principal all carry their own author; the local person's
      // composer rows carry neither.
      return !sender && !author
  }
}

/** A scheduled task's unattended runs: one epoch per person edit. */
export function taskInstructionEpoch(task: { id: string; humanRevision?: number }): string {
  return `task:${task.id}@${task.humanRevision ?? 0}`
}

/** A Bot installation's runs: one epoch per person change. */
export function botInstructionEpoch(installation: { id: string; humanRevision?: number }): string {
  return `bot:${installation.id}@${installation.humanRevision ?? 0}`
}

/**
 * The origin thread of a session bound to an IM conversation. A session with
 * no binding has none: its requester is the local person, and an IM
 * conversation is somebody else's thread.
 */
export function sessionOriginThread(session: {
  platformBinding?: { conversationKey: string }
}): OutboundTarget | undefined {
  const key = session.platformBinding?.conversationKey
  return key ? conversationTarget(key) : undefined
}

/**
 * The origin thread of a scheduled task: the conversation its `/schedule`
 * command came from. A task authored anywhere else has none and needs a
 * `policy` grant for every recipient.
 */
export function taskOriginThread(task: {
  payload?: ScheduledTaskPayload
}): OutboundTarget | undefined {
  const provenance = readScheduleProvenance(task)
  return provenance ? conversationTarget(provenance.conversationKey) : undefined
}

/** The requester of a scheduled task's runs: who typed `/schedule`, else the local person. */
export function taskRequester(task: { payload?: ScheduledTaskPayload }): ActionRequester {
  const provenance = readScheduleProvenance(task)
  return provenance ? { kind: "im", remoteUserId: provenance.senderId } : { kind: "local" }
}
