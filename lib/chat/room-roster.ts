/**
 * The cast list a model reads before it reads the transcript.
 *
 * # Why a roster and not just per-line names
 *
 * `lib/chat/speaker.ts` makes every LINE attributable. That is enough to tell
 * two people apart, and not enough to hold a conversation with them: a model
 * that only ever sees who has already spoken cannot address a member who has
 * not, cannot tell a person from an agent, and has no way to know that
 * `Agent-91FZK2` is the reviewer it is supposed to defer to.
 *
 * So the room states its own membership. This is the same move AutoGen's
 * GroupChatManager makes when it hands each agent the participant
 * descriptions before selecting a speaker, and the same one ChatGPT's group
 * chats make by naming the people present.
 *
 * # Purity
 *
 * No Dexie, no React. Callers assemble the participant list from whatever
 * source they have (a team's declared members, a shared session's
 * `SessionMembership` rows, an IM group's roster) and this module renders it.
 * That is what lets one section serve three planes that store membership in
 * three different places.
 *
 * # Bounded on purpose
 *
 * A 500-person Slack channel must not become 500 prompt lines. The list is
 * capped and the remainder is counted, so the section stays a fixed cost.
 */

import {
  resolveMessageSpeaker,
  speakerTranscriptName,
  type MessageSpeaker,
  type SpeakerContext,
  type SpeakerSource,
} from "./speaker"

export interface RoomParticipant {
  speaker: MessageSpeaker
  /** A one-line qualifier: a team member's role, or a guest's origin. Display only. */
  role?: string
  /** The participant this prompt is being built for. */
  isSelf?: boolean
}

/** Participants listed by name before the section switches to a count. */
export const MAX_ROSTER_PARTICIPANTS = 24

/**
 * Who has spoken in `messages`, newest first, deduplicated by speaker id.
 *
 * Newest first because when a room has more participants than the cap, the
 * ones who just spoke are the ones the next turn is about.
 */
export function collectRoomParticipants(
  messages: readonly SpeakerSource[],
  ctx: SpeakerContext = {}
): RoomParticipant[] {
  const seen = new Set<string>()
  const participants: RoomParticipant[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const speaker = resolveMessageSpeaker(messages[i], ctx)
    if (!speaker || seen.has(speaker.id)) continue
    seen.add(speaker.id)
    participants.push({ speaker })
  }
  return participants
}

/**
 * Union `declared` (the room's membership of record) with `observed` (whoever
 * has actually spoken), keeping the declared entry when both name the same id.
 *
 * The declared side wins because it carries the role and the self marker, and
 * because a member who has not spoken yet is still in the room.
 */
export function mergeRoomParticipants(
  declared: readonly RoomParticipant[],
  observed: readonly RoomParticipant[]
): RoomParticipant[] {
  const byId = new Map<string, RoomParticipant>()
  for (const participant of declared) byId.set(participant.speaker.id, participant)
  for (const participant of observed) {
    if (!byId.has(participant.speaker.id)) byId.set(participant.speaker.id, participant)
  }
  return [...byId.values()]
}

/**
 * Render the roster section, or `""` when there is nobody worth naming.
 *
 * A single participant is not a room, so a one-entry roster renders empty and
 * a direct conversation keeps the prompt it had before.
 */
export function buildRoomRosterSection(participants: readonly RoomParticipant[]): string {
  if (participants.length < 2) return ""

  const listed = participants.slice(0, MAX_ROSTER_PARTICIPANTS)
  const remaining = participants.length - listed.length

  const lines = ["## Who is in this room", ""]
  for (const participant of listed) {
    lines.push(`- ${rosterLine(participant)}`)
  }
  if (remaining > 0) {
    lines.push(`- and ${remaining} more participant${remaining === 1 ? "" : "s"}`)
  }
  lines.push("")
  lines.push(
    "Each speaker label in the conversation below names one of these participants. " +
      "Address someone by their name when your reply is for them in particular."
  )
  return lines.join("\n")
}

function rosterLine(participant: RoomParticipant): string {
  const qualifiers = [participant.speaker.kind === "agent" ? "agent" : participant.speaker.kind]
  const role = participant.role?.trim()
  if (role) qualifiers.push(role)
  if (participant.isSelf) qualifiers.push("you")
  return `${speakerTranscriptName(participant.speaker)} (${qualifiers.join(", ")})`
}
