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

import type { SendContent, SendOptions } from "@cognia/agent-config-types"
import { parseReplyToPayload } from "@/lib/chat/reply-to"
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

export async function roomSend(
  payload: Record<string, unknown>,
  deps: RoomWriteHandlerDeps = {}
): Promise<{ accepted: boolean }> {
  const sessionId = requireString(payload, "sessionId", "room_send")
  const callerDeviceId = requireString(payload, "callerDeviceId", "room_send")
  const runner = (deps.runner ?? defaultDeps.runner)()
  const author = await resolveRoomAuthor(callerDeviceId, deps)

  if (payload.regenerate === true) {
    void runner.regenerate(sessionId).catch((err) => console.error("room regenerate failed", err))
    return { accepted: true }
  }

  const content = payload.content
  if (!isSendContent(content)) throw new Error("room_send.content must be a string or blocks")
  const editMessageId = payload.editMessageId
  if (editMessageId !== undefined && typeof editMessageId !== "string") {
    throw new Error("room_send.editMessageId must be a string when present")
  }
  if (typeof editMessageId === "string") {
    void runner
      .editAndResend(sessionId, editMessageId, content)
      .catch((err) => console.error("room edit failed", err))
    return { accepted: true }
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

  const targetMemberIds = readTargetMemberIds(payload.targetMemberIds)

  void runner
    .send(content, {
      sessionId,
      attachmentManifest,
      webSearchContext,
      author,
      ...(replyTo ? { replyTo } : {}),
      ...(targetMemberIds ? { targetMemberIds } : {}),
    })
    .catch((err) => console.error("room send failed", err))
  return { accepted: true }
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
