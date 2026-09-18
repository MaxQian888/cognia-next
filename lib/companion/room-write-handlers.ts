/**
 * `room_send` and `room_stop`: the host side of a companion driving a team
 * room (ADR-0177, batch 1).
 *
 * Both arms run on whichever host installed `desktop-write-source.ts`, the
 * desktop renderer or the headless brain, against the process-wide runner
 * from `lib/chat/room/runner-host.ts`. That sharing is the point: a phone's
 * turn and a local turn on one room go through one steer queue and one
 * interrupt set.
 *
 * `room_send` returns once the turn is *accepted*, not once it finishes. A
 * team turn can run for minutes, the bridge request times out at 30s, and a
 * companion learns the outcome from the member events it already streams.
 *
 * `callerDeviceId` is injected by the Rust RPC layer from the verified DPoP
 * device context and never read from the raw client payload. Pairing is
 * same-person by design, so the author stamped on the user row is the host's
 * bound person with the device recorded as provenance, which is what lets
 * `resolveMessageSpeaker` name who wrote a turn instead of collapsing every
 * remote write into an anonymous `User:`.
 */

import { readChatTemplateRun } from "@/lib/chat/template/run"
import type { SendContent, SendOptions } from "@cognia/agent-config-types"
import { parseReplyToPayload } from "@/lib/chat/reply-to"
import { isContextRef } from "@/lib/chat/mentions/read"
import { readPromptPreambleSummary } from "@/lib/chat/prompt-preamble"
import type { ContextRef } from "@/lib/chat/mentions/types"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import { getHostRoomRunner } from "@/lib/chat/room/runner-host"
import type { RoomRunner, RoomSendOptions } from "@/lib/chat/room/runner"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { readHostPerson } from "@/lib/identity/host-person"
import { getPairedDevice } from "@/lib/db/paired-devices"

export interface RoomWriteHandlerDeps {
  runner?: () => RoomRunner
  /** The person this host is bound to, or `null` off a bound host. */
  hostUserId?: () => Promise<string | null>
  deviceLabel?: (deviceId: string) => Promise<string | undefined>
}

const defaultDeps: Required<RoomWriteHandlerDeps> = {
  runner: () => getHostRoomRunner(),
  hostUserId: async () => {
    try {
      const person = await readHostPerson(getActiveAccountId())
      return person?.canonicalUserId ?? person?.userId ?? null
    } catch {
      return null
    }
  },
  deviceLabel: async (deviceId) => {
    try {
      return (await getPairedDevice(deviceId))?.label
    } catch {
      return undefined
    }
  },
}

function requireString(payload: Record<string, unknown>, key: string, command: string): string {
  const value = payload[key]
  if (typeof value !== "string" || !value) throw new Error(`${command}.${key} is required`)
  return value
}

function isSendContent(value: unknown): value is SendContent {
  if (typeof value === "string") return true
  return (
    Array.isArray(value) &&
    value.every((block) => block && typeof block === "object" && typeof block.type === "string")
  )
}

/** Who a companion write is attributed to. Exported for the test and the arm. */
export async function resolveRoomAuthor(
  callerDeviceId: string,
  deps: RoomWriteHandlerDeps = {}
): Promise<NonNullable<RoomSendOptions["author"]>> {
  const hostUserId = await (deps.hostUserId ?? defaultDeps.hostUserId)()
  const label = await (deps.deviceLabel ?? defaultDeps.deviceLabel)(callerDeviceId)
  return {
    kind: "human",
    // A host with no bound person still has one local person, its account.
    id: hostUserId ?? getActiveAccountId(),
    ...(label ? { displayName: label } : {}),
    source: `device:${callerDeviceId}`,
  }
}

/** Report admission separately from the potentially minutes-long generation. */
function awaitRoomAdmission(
  start: (onAccepted: () => void) => Promise<void>
): Promise<{ accepted: boolean }> {
  return new Promise((resolve, reject) => {
    let accepted = false
    const completion = start(() => {
      accepted = true
      resolve({ accepted: true })
    })
    void completion.then(
      () => resolve({ accepted: false }),
      (error) => {
        if (accepted) console.error("room turn failed after admission", error)
        else reject(error)
      }
    )
  })
}

export async function roomSend(
  payload: Record<string, unknown>,
  deps: RoomWriteHandlerDeps = {}
): Promise<{ accepted: boolean }> {
  const sessionId = requireString(payload, "sessionId", "room_send")
  const callerDeviceId = requireString(payload, "callerDeviceId", "room_send")
  const runner = (deps.runner ?? defaultDeps.runner)()
  const author = await resolveRoomAuthor(callerDeviceId, deps)

  if (payload.regenerate === true) {
    return awaitRoomAdmission((onAccepted) => runner.regenerate(sessionId, onAccepted))
  }

  const content = payload.content
  if (!isSendContent(content)) throw new Error("room_send.content must be a string or blocks")
  const editMessageId = payload.editMessageId
  if (editMessageId !== undefined && typeof editMessageId !== "string") {
    throw new Error("room_send.editMessageId must be a string when present")
  }
  if (typeof editMessageId === "string") {
    return awaitRoomAdmission((onAccepted) =>
      runner.editAndResend(sessionId, editMessageId, content, { author, onAccepted })
    )
  }

  const attachmentManifest = Array.isArray(payload.attachmentManifest)
    ? (payload.attachmentManifest as AttachmentManifestEntry[])
    : undefined
  const webSearchContext =
    payload.webSearchContext && typeof payload.webSearchContext === "object"
      ? (payload.webSearchContext as SendOptions["webSearchContext"])
      : undefined

  // The schema already refuses a malformed value at the RPC edge. This second
  // read is what keeps a key the schema does not know from riding into the row.
  const replyTo =
    payload.replyTo === undefined ? undefined : (parseReplyToPayload(payload.replyTo) ?? undefined)
  if (payload.replyTo !== undefined && !replyTo) {
    throw new Error("room_send.replyTo must be { messageId, preview } when present")
  }

  const templateRun =
    payload.templateRun === undefined
      ? null
      : readChatTemplateRun({ templateRun: payload.templateRun })
  if (payload.templateRun !== undefined && !templateRun) {
    throw new Error("room_send.templateRun must be a valid template run when present")
  }
  const targetMemberIds = readTargetMemberIds(payload.targetMemberIds)

  // The reference fields a turn carries (ADR-0157). The citations are the only
  // record of what the turn's context chips named — the envelope in `content`
  // feeds the model but leaves no `metadata.mentions` on the persisted row.
  const citations = readCitations(payload.citations)
  const promptPreamble =
    payload.promptPreamble === undefined
      ? undefined
      : (readPromptPreambleSummary({ promptPreamble: payload.promptPreamble }) ?? undefined)
  if (payload.promptPreamble !== undefined && !promptPreamble) {
    throw new Error(
      "room_send.promptPreamble must be a preamble summary ({ sections, references }) when present"
    )
  }

  return awaitRoomAdmission((onAccepted) =>
    runner.send(content, {
      onAccepted,
      sessionId,
      attachmentManifest,
      webSearchContext,
      author,
      ...(templateRun ? { templateRun } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(targetMemberIds ? { targetMemberIds } : {}),
      ...(citations ? { citations } : {}),
      ...(promptPreamble ? { promptPreamble } : {}),
    })
  )
}

/**
 * `room_send.citations`: a list of `ContextRef`s, or absent. A present-but-
 * unparseable entry is rejected the way `replyTo` is — a malformed value must
 * not silently narrow to "no citations" and strip the turn's record of what
 * it referenced.
 */
function readCitations(value: unknown): ContextRef[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new Error("room_send.citations must be a list of context refs when present")
  }
  const refs = value.filter(isContextRef)
  if (refs.length !== value.length) {
    throw new Error("room_send.citations must be a list of context refs when present")
  }
  return refs.length > 0 ? refs : undefined
}

/** The composer's pick (ADR-0177 batch 3): member ids, or nothing. */
function readTargetMemberIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && id)) {
    throw new Error("room_send.targetMemberIds must be a list of member ids when present")
  }
  return value.length > 0 ? (value as string[]) : undefined
}

/**
 * Stop the room, or with `characterId` (ADR-0177 batch 3) one member of it
 * while the rest of the round goes on.
 */
export async function roomStop(
  payload: Record<string, unknown>,
  deps: RoomWriteHandlerDeps = {}
): Promise<null> {
  const sessionId = requireString(payload, "sessionId", "room_stop")
  requireString(payload, "callerDeviceId", "room_stop")
  const characterId = payload.characterId
  if (characterId !== undefined && (typeof characterId !== "string" || !characterId)) {
    throw new Error("room_stop.characterId must be a member id when present")
  }
  const runner = (deps.runner ?? defaultDeps.runner)()
  if (typeof characterId === "string") await runner.stopMember(sessionId, characterId)
  else await runner.stop(sessionId)
  return null
}
