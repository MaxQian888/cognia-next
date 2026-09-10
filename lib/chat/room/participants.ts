/**
 * The roster projection: who is in a room, read from whichever membership
 * source the room's kind keeps, merged with whoever has actually spoken.
 *
 * # Why a projection and not a table
 *
 * Team rooms already have `Team.members`, shared rooms already mirror the
 * server's `collabChatMemberships`, and an IM group has no roster at all
 * until batch 4 teaches adapters to read one. A fourth table would be a
 * second writer for two of those and an empty one for the third. Deriving the
 * list keeps every plane's own store authoritative and gives the chip, the
 * prompt roster and the composer's `@` completion one answer.
 *
 * # Completeness is part of the answer
 *
 * A roster the UI cannot vouch for is worse than none: a Telegram group
 * whose only known members are the ones who have spoken must not render as a
 * three-person room. Every projection therefore says how it knows.
 */

import type { Character, TeamMember } from "@cognia/agent-config-types"
import type { SessionMembership } from "@cognia/agent-config-types/collaboration"
import {
  collectRoomParticipants,
  mergeRoomParticipants,
  type RoomParticipant,
} from "@/lib/chat/room-roster"
import { makeSpeaker, type SpeakerContext, type SpeakerSource } from "@/lib/chat/speaker"
import type { RoomKind, RoomRosterCompleteness } from "./types"

export type { RoomParticipant } from "@/lib/chat/room-roster"

export interface RoomRosterProjection {
  participants: RoomParticipant[]
  completeness: RoomRosterCompleteness
  /** Ids the declared source named, whether or not they have spoken. */
  declaredIds: ReadonlySet<string>
}

export interface ProjectRoomParticipantsInput {
  kind: RoomKind | null
  /** Team rooms: the resolved characters, in the team's reply order. */
  characters?: readonly Pick<Character, "id" | "name">[]
  /** Team rooms: the member slots, for the role label. */
  members?: readonly Pick<TeamMember, "characterId" | "role">[]
  /** Shared rooms: the server's membership rows. */
  memberships?: readonly Pick<SessionMembership, "userId" | "role" | "guest" | "displayName">[]
  /** Every message in the room, oldest first. */
  messages?: readonly SpeakerSource[]
  /** The participant this projection is built for (marks `isSelf`). */
  selfId?: string
  ctx?: SpeakerContext
}

export function projectRoomParticipants(input: ProjectRoomParticipantsInput): RoomRosterProjection {
  const declared = declaredParticipants(input)
  const observed = collectRoomParticipants(input.messages ?? [], input.ctx)
  const merged = mergeRoomParticipants(declared, observed).map((participant) =>
    input.selfId && participant.speaker.id === input.selfId
      ? { ...participant, isSelf: true }
      : participant
  )
  return {
    participants: merged,
    completeness: completenessFor(input.kind, declared.length),
    declaredIds: new Set(declared.map((participant) => participant.speaker.id)),
  }
}

function declaredParticipants(input: ProjectRoomParticipantsInput): RoomParticipant[] {
  switch (input.kind) {
    case "team": {
      const roleById = new Map(
        (input.members ?? []).flatMap((slot) =>
          slot.role?.trim() ? [[slot.characterId, slot.role.trim()] as const] : []
        )
      )
      return (input.characters ?? []).map((character) => ({
        speaker: makeSpeaker("agent", character.id, character.name),
        ...(roleById.has(character.id) ? { role: roleById.get(character.id) } : {}),
      }))
    }
    case "shared":
      return (input.memberships ?? []).map((membership) => ({
        speaker: makeSpeaker(
          membership.guest ? "guest" : "human",
          membership.userId,
          membership.displayName
        ),
        role: membership.role,
      }))
    case "im":
    case null:
    default:
      return []
  }
}

/**
 * Team and shared rosters are declared in full by their own store. An IM
 * group is observed only until an adapter can read its member list (batch 4
 * introduces `chat.members.read` with `partial` for platforms that only
 * expose a count and the admins).
 */
export function completenessFor(
  kind: RoomKind | null,
  declaredCount: number
): RoomRosterCompleteness {
  if (kind === "team" || kind === "shared") return declaredCount > 0 ? "full" : "observed"
  return "observed"
}
