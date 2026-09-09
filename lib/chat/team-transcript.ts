/**
 * The conversation context every member of a character team reads before it
 * answers.
 *
 * # Why this is its own module
 *
 * This rendering used to live inside `hooks/chat/use-team-chat.ts`, a 1700
 * line React hook whose Jest suite cannot currently be loaded at all. That
 * made the one piece of the team runtime with no React, no Dexie and no Tauri
 * in it the one piece nobody could test. It is pure, so it belongs out here.
 *
 * Not to be confused with `lib/chat/transcript/`, which is the render/transport
 * projection from ADR-0127. This module writes prompt text for a model. That
 * one ships message rows to a renderer.
 *
 * # What each member sees
 *
 *   1. `## Shared scratchpad` when the session has one.
 *   2. `## Who is in this room`, the roster, so a member can address somebody
 *      who has not spoken yet and can tell a person from a teammate.
 *   3. `## Conversation context`, one line per turn, labelled by speaker.
 *
 * # Humans are named, agents keep their bare name
 *
 * Every human turn used to render as `User:`. That is right for the one room
 * shape this started with (one person, several agents) and wrong for the two
 * it grew into: a shared session has several people in it, and an IM-bound
 * session has a whole group chat behind it. `resolveMessageSpeaker` names them
 * when the message carries authorship and returns null when it does not, so a
 * plain local conversation renders exactly the bytes it did before.
 *
 * Agents deliberately keep their bare character name, because that name is the
 * token `lib/claude/team-router.ts:parseMentions` routes on. Decorating it here
 * would teach members to write an address the router reads differently.
 */

import {
  buildRoomRosterSection,
  collectRoomParticipants,
  mergeRoomParticipants,
  type RoomParticipant,
} from "./room-roster"
import {
  makeSpeaker,
  resolveMessageSpeaker,
  speakerTranscriptName,
  type SpeakerSource,
} from "./speaker"

/** A team member as the transcript needs it: identity, name, and its role in THIS team. */
export interface TeamTranscriptMember {
  id: string
  name: string
  /** The member slot's free-text role ("Critic"), when the team assigns one. */
  role?: string | undefined
}

/** The message fields this renderer reads. Structural, so `UIMessage` and `StoredMessage` both fit. */
export interface TeamTranscriptMessage extends SpeakerSource {
  role: string
  parts: readonly unknown[]
}

export interface BuildTeamTranscriptInput {
  messages: readonly TeamTranscriptMessage[]
  /** The member this prompt is being built for. Its own turns render as `You:`. */
  respondingCharacterId: string
  members: readonly TeamTranscriptMember[]
  scratchpad?: string | undefined
}

/** Concatenate the text parts of a message. Non-text parts carry no transcript line. */
export function textFromParts(parts: readonly unknown[]): string {
  const out: string[] = []
  for (const part of parts) {
    if ((part as { type?: string }).type === "text") {
      out.push((part as { text?: string }).text ?? "")
    }
  }
  return out.join("")
}

export function buildTeamTranscript(input: BuildTeamTranscriptInput): string {
  const { messages, respondingCharacterId, members, scratchpad } = input
  const sections: string[] = []

  if (scratchpad && scratchpad.trim()) {
    sections.push(["## Shared scratchpad", "", scratchpad.trim()].join("\n"))
  }

  const roster = buildRoomRosterSection(rosterFor(messages, respondingCharacterId, members))
  if (roster) sections.push(roster)

  const lines = transcriptLines(messages, respondingCharacterId, members)
  if (lines.length > 0) {
    sections.push(
      [
        "## Conversation context",
        "",
        "You are participating in a multi-agent group chat. The transcript so far is below. " +
          "Every line begins with the label of whoever said it: `You:` is your own prior turn, " +
          "`User:` is the person you are talking to when nobody else is named, and every other " +
          "label names a participant from the roster above. " +
          "Reply only with your next turn (no transcript, no prefix).",
        "",
        lines.join("\n"),
      ].join("\n")
    )
  }

  return sections.join("\n\n")
}

/**
 * Declared members first, then whoever else has spoken.
 *
 * The declared side wins on conflict because a member who has not spoken yet
 * is still in the room and still addressable, and because only that side knows
 * the roles and which member is reading.
 */
function rosterFor(
  messages: readonly TeamTranscriptMessage[],
  respondingCharacterId: string,
  members: readonly TeamTranscriptMember[]
): RoomParticipant[] {
  const declared: RoomParticipant[] = members.map((member) => ({
    speaker: makeSpeaker("agent", member.id, member.name),
    ...(member.role?.trim() ? { role: member.role.trim() } : {}),
    isSelf: member.id === respondingCharacterId,
  }))
  const humans = collectRoomParticipants(messages.filter((message) => message.role === "user"))
  return mergeRoomParticipants(declared, humans)
}

function transcriptLines(
  messages: readonly TeamTranscriptMessage[],
  respondingCharacterId: string,
  members: readonly TeamTranscriptMember[]
): string[] {
  const nameById = new Map(members.map((member) => [member.id, member.name]))
  const lines: string[] = []

  for (const message of messages) {
    const text = textFromParts(message.parts)
    if (!text.trim()) continue

    if (message.role === "user") {
      const speaker = resolveMessageSpeaker(message)
      lines.push(`${speaker ? speakerTranscriptName(speaker) : "User"}: ${text}`)
      continue
    }

    const senderId = senderIdOf(message)
    if (senderId && senderId === respondingCharacterId) {
      lines.push(`You: ${text}`)
      continue
    }
    lines.push(`${(senderId && nameById.get(senderId)) || senderId || "Assistant"}: ${text}`)
  }

  return lines
}

/** `lib/db/messages.ts` hoists `senderId` into `metadata` for the UI layer, so both are read. */
function senderIdOf(message: TeamTranscriptMessage): string | undefined {
  if (message.senderId) return message.senderId
  const fromMetadata = message.metadata?.senderId
  return typeof fromMetadata === "string" && fromMetadata.length > 0 ? fromMetadata : undefined
}
