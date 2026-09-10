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

import { buildRoomRosterSection, type RoomParticipant } from "./room-roster"
import { projectRoomParticipants } from "./room/participants"
import { HANDOFF_STOP_TOKEN } from "@/lib/claude/team-router"
import { formatReactionSummary, type MessageReaction } from "@cognia/agent-config-types"
import { readReplyTo, replyContextLine } from "./reply-to"
import { bareToolName } from "./tool-summary"
import { resolveMessageSpeaker, speakerTranscriptName, type SpeakerSource } from "./speaker"

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

/**
 * How much history a member is allowed to read.
 *
 * A team turn costs one rendered transcript PER MEMBER, so the unbounded
 * version was O(members x whole conversation) every turn, growing forever. The
 * documented failure mode for the supervisor pattern is exactly this: past
 * eight to twelve round trips the history crowds the current task out of the
 * window and routing accuracy falls off. A ceiling is the fix, and saying how
 * many turns were dropped is what keeps it honest.
 */
export interface TeamTranscriptBudget {
  /** Newest turns kept. Older ones collapse into one elision line. */
  maxTurns?: number
  /**
   * Hard ceiling on the rendered turn block. Applied after `maxTurns`, newest
   * first, because a single pasted stack trace can be larger than the rest of
   * the conversation put together.
   */
  maxChars?: number
}

export const DEFAULT_TEAM_TRANSCRIPT_BUDGET: Required<TeamTranscriptBudget> = {
  maxTurns: 40,
  maxChars: 24_000,
}

export interface BuildTeamTranscriptInput {
  messages: readonly TeamTranscriptMessage[]
  /** The member this prompt is being built for. Its own turns render as `You:`. */
  respondingCharacterId: string
  members: readonly TeamTranscriptMember[]
  scratchpad?: string | undefined
  /** Omitted means {@link DEFAULT_TEAM_TRANSCRIPT_BUDGET}. */
  budget?: TeamTranscriptBudget | undefined
  /**
   * Whether this team runs extra rounds on its own (`Team.maxAutoRounds`).
   *
   * Gates the paragraph that teaches the handoff protocol. Teaching it to a
   * room where it does nothing would be worse than saying nothing: a member
   * would address a teammate, believe the floor was passed, and end its turn
   * on a question no one is going to answer.
   */
  handoffEnabled?: boolean | undefined
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

/**
 * One-line markers for the parts that are not prose.
 *
 * Members could previously only see what their teammates SAID, never what they
 * DID: a turn that ran three tools and attached a screenshot rendered as an
 * empty line and was dropped. That is the difference between a room where
 * agents build on each other's work and one where they repeat it. The markers
 * are deliberately terse, since a full tool result would blow the budget above
 * on its own.
 */
export function nonTextPartMarkers(parts: readonly unknown[]): string[] {
  const markers: string[] = []
  const toolCounts = new Map<string, number>()
  for (const part of parts) {
    const type = (part as { type?: string }).type
    if (!type || type === "text" || type === "step-start" || type === "reasoning") continue
    if (type.startsWith("tool-") || type === "dynamic-tool") {
      const name = bareToolName((part as { toolName?: string }).toolName ?? type)
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1)
      continue
    }
    if (type === "file") {
      const file = part as { filename?: string; mediaType?: string }
      const kind = file.mediaType?.startsWith("image/") ? "image" : "file"
      markers.push(file.filename ? `[${kind}: ${file.filename}]` : `[${kind}]`)
    }
  }
  for (const [name, count] of toolCounts) {
    markers.push(count > 1 ? `[used ${name} x${count}]` : `[used ${name}]`)
  }
  return markers
}

/**
 * How a member passes the floor, and how the room agrees it is finished.
 *
 * Written from `HANDOFF_STOP_TOKEN` rather than repeating the literal, because
 * a prompt that teaches one spelling while the parser accepts another is a
 * failure nothing would catch: the member does as it was told, the chain runs
 * to its ceiling anyway, and the transcript reads as if it worked.
 */
const HANDOFF_PROTOCOL =
  "This room continues on its own for a few rounds. Address a teammate by name with " +
  "`@Name` to hand them the floor and they will answer next. When the group has " +
  `finished, write ${HANDOFF_STOP_TOKEN} anywhere in your reply and no further rounds ` +
  "run. The tag is removed before anyone reads the message, so write your answer normally " +
  "around it. Do not use it to end your own turn early, only to end the group's work."

export function buildTeamTranscript(input: BuildTeamTranscriptInput): string {
  const { messages, respondingCharacterId, members, scratchpad } = input
  const sections: string[] = []

  if (scratchpad && scratchpad.trim()) {
    sections.push(["## Shared scratchpad", "", scratchpad.trim()].join("\n"))
  }

  const roster = buildRoomRosterSection(rosterFor(messages, respondingCharacterId, members))
  if (roster) sections.push(roster)

  const lines = applyBudget(transcriptLines(messages, respondingCharacterId, members), input.budget)
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
        ...(input.handoffEnabled ? ["", HANDOFF_PROTOCOL] : []),
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
  // The same projection the header chip renders (ADR-0177), so the model and
  // the user are told about one room. Only user turns are observed here: a
  // member's own replies are already on the declared side.
  return projectRoomParticipants({
    kind: "team",
    characters: members,
    members: members.map((member) => ({ characterId: member.id, role: member.role })),
    messages: messages.filter((message) => message.role === "user"),
    selfId: respondingCharacterId,
  }).participants
}

function transcriptLines(
  messages: readonly TeamTranscriptMessage[],
  respondingCharacterId: string,
  members: readonly TeamTranscriptMember[]
): string[] {
  const nameById = new Map(members.map((member) => [member.id, member.name]))
  const lines: string[] = []

  for (const message of messages) {
    const body = [textFromParts(message.parts).trim(), ...nonTextPartMarkers(message.parts)]
      .filter(Boolean)
      .join(" ")
    // A turn that only ran tools still happened, and a member that cannot see
    // it will redo the work. Only a genuinely empty turn is skipped.
    if (!body) continue

    // A reply reference and the reactions on a turn are facts the room can
    // see, so a member reads them too (ADR-0177 batch 2): the reply line says
    // which message the user was answering, and the reaction tally says how
    // the room received a turn without naming who reacted.
    const replyTo = readReplyTo(message)
    const prefix = replyTo ? `${replyContextLine(replyTo)} ` : ""
    const reactions = formatReactionSummary(reactionsOf(message))
    const suffix = reactions ? ` [reactions: ${reactions}]` : ""

    if (message.role === "user") {
      const speaker = resolveMessageSpeaker(message)
      lines.push(`${speaker ? speakerTranscriptName(speaker) : "User"}: ${prefix}${body}${suffix}`)
      continue
    }

    const senderId = senderIdOf(message)
    if (senderId && senderId === respondingCharacterId) {
      lines.push(`You: ${prefix}${body}${suffix}`)
      continue
    }
    lines.push(
      `${(senderId && nameById.get(senderId)) || senderId || "Assistant"}: ${prefix}${body}${suffix}`
    )
  }

  return lines
}

function reactionsOf(message: TeamTranscriptMessage): MessageReaction[] | undefined {
  const value = message.metadata?.reactions
  return Array.isArray(value) ? (value as MessageReaction[]) : undefined
}

/**
 * Trim to the newest turns that fit, and say how many were dropped.
 *
 * Silently truncating would leave a member confidently answering from half a
 * conversation with no way to know it. The elision line is what turns that
 * into a fact it can account for.
 */
function applyBudget(lines: readonly string[], budget: TeamTranscriptBudget | undefined): string[] {
  const maxTurns = budget?.maxTurns ?? DEFAULT_TEAM_TRANSCRIPT_BUDGET.maxTurns
  const maxChars = budget?.maxChars ?? DEFAULT_TEAM_TRANSCRIPT_BUDGET.maxChars

  const kept: string[] = []
  let chars = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    if (kept.length >= maxTurns) break
    // Always keep the newest turn, however large: dropping the message being
    // answered leaves the member with nothing to answer.
    if (kept.length > 0 && chars + lines[i].length > maxChars) break
    kept.push(lines[i])
    chars += lines[i].length
  }
  kept.reverse()

  const dropped = lines.length - kept.length
  if (dropped <= 0) return kept
  return [`[${dropped} earlier turn${dropped === 1 ? "" : "s"} not shown]`, ...kept]
}

/** `lib/db/messages.ts` hoists `senderId` into `metadata` for the UI layer, so both are read. */
function senderIdOf(message: TeamTranscriptMessage): string | undefined {
  if (message.senderId) return message.senderId
  const fromMetadata = message.metadata?.senderId
  return typeof fromMetadata === "string" && fromMetadata.length > 0 ? fromMetadata : undefined
}
