"use client"

/**
 * Who else is in this conversation, on the header row.
 *
 * # Why one chip for three kinds of room
 *
 * A conversation becomes a room three different ways: a character team of
 * several agents, a shared session with several people, and an IM group where
 * a whole channel talks to one bot. Each of those keeps its membership
 * somewhere different, and none of them put it on screen. The chat header
 * could tell you what a conversation would cost and where it came from, and
 * not who was in it.
 *
 * So this asks the question the same way the prompt does. `lib/chat/speaker.ts`
 * resolves who wrote each message whatever plane it came from, and
 * `lib/chat/room-roster.ts` merges that with a declared member list. The chip
 * is those two functions with faces attached, which is what keeps the header
 * and the model looking at the same room.
 *
 * # Why it self-hides on a count rather than on a session kind
 *
 * Testing `kind === "team"` here would have needed a fourth answer for a
 * private IM chat, whose binding looks exactly like a group's until the
 * delivery target is unpacked. Counting participants needs no such guess: a
 * one-to-one conversation has one other party and no chip, a group has
 * several and gets one. It is the same threshold `buildRoomRosterSection`
 * uses, so the header appears exactly when the model is told there is a room.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { AvatarBadge } from "@/components/desktop/avatar-badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useTeamMemberRoles, useTeamMembers } from "@/hooks/use-team-members"
import {
  collectRoomParticipants,
  mergeRoomParticipants,
  MAX_ROSTER_PARTICIPANTS,
  type RoomParticipant,
} from "@/lib/chat/room-roster"
import { makeSpeaker, type SpeakerSource } from "@/lib/chat/speaker"
import { deterministicColor, type AvatarSubject } from "@/lib/ui/avatar"
import { cn } from "@/lib/utils"
import { useChatStore } from "@/stores/chat"
import type { Character, ChatSession } from "@cognia/agent-config-types"

/** Faces shown side by side before the rest collapse into the count. */
const STACKED_FACES = 3

interface Row {
  id: string
  subject: AvatarSubject
  label: string
  role?: string
}

export function RoomParticipantsChip({
  session,
  className,
}: {
  session: ChatSession
  className?: string
}) {
  const t = useTranslations("chatRoom")
  const teamId = session.kind === "team" ? session.teamId : undefined
  const members = useTeamMembers(teamId)
  const roles = useTeamMemberRoles(teamId)
  const messages = useChatStore((state) => state.sessions[session.id]?.messages)

  const rows = useMemo(
    // `UIMessage.metadata` is `unknown` by construction, while `SpeakerSource`
    // wants the record it actually holds. The resolver reads that field
    // defensively at every step, so the widening is safe and the same one
    // `use-team-chat.ts` makes when it feeds these rows to the prompt.
    () => buildRows(members, roles, (messages ?? []) as unknown as readonly SpeakerSource[]),
    [members, roles, messages]
  )

  if (rows.length < 2) return null

  const label = t("participants", { count: rows.length })
  const stacked = rows.slice(0, STACKED_FACES)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={label}
          aria-label={label}
          data-testid="room-participants-chip"
          className={cn(
            "flex min-w-0 shrink items-center gap-1 rounded px-1 text-[11px] text-muted-foreground hover:text-foreground",
            className
          )}
        >
          <span className="flex shrink-0 items-center">
            {stacked.map((row, index) => (
              <AvatarBadge
                key={row.id}
                subject={row.subject}
                size={16}
                className={cn("ring-1 ring-background", index > 0 && "-ml-1.5")}
              />
            ))}
          </span>
          <span className="truncate tabular-nums">{rows.length}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-[18rem]">
        <DropdownMenuLabel className="text-xs">{t("listLabel")}</DropdownMenuLabel>
        {rows.slice(0, MAX_ROSTER_PARTICIPANTS).map((row) => (
          <DropdownMenuItem key={row.id} className="gap-2" data-testid="room-participant-row">
            <AvatarBadge subject={row.subject} size={18} />
            <span className="min-w-0 flex-1 truncate">{row.label}</span>
            {row.role ? (
              <span className="shrink-0 text-[11px] text-muted-foreground">{row.role}</span>
            ) : null}
          </DropdownMenuItem>
        ))}
        {rows.length > MAX_ROSTER_PARTICIPANTS ? (
          <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
            {t("andMore", { count: rows.length - MAX_ROSTER_PARTICIPANTS })}
          </DropdownMenuLabel>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Declared members first, then whoever else has spoken.
 *
 * Same precedence as the prompt roster, and for the same reason: a member who
 * has not said anything yet is still in the room, and only the declared side
 * knows the roles. A character that has spoken is matched back to its row by
 * id, so a member keeps its own avatar instead of the colour its id hashes to.
 */
function buildRows(
  members: readonly Character[],
  roles: ReadonlyMap<string, string>,
  messages: readonly SpeakerSource[]
): Row[] {
  const declared: RoomParticipant[] = members.map((member) => ({
    speaker: makeSpeaker("agent", member.id, member.name),
    ...(roles.get(member.id) ? { role: roles.get(member.id)! } : {}),
  }))
  const merged = mergeRoomParticipants(declared, collectRoomParticipants(messages))
  const characterById = new Map(members.map((member) => [member.id, member]))

  return merged.map((participant) => {
    const character = characterById.get(participant.speaker.id)
    return {
      id: participant.speaker.id,
      // `label` is always the safe form: `safeSpeakerLabel` has already run the
      // redaction gate over it and fallen back to the stable pseudonym when
      // the whole display name was personal data. Reaching past it to the raw
      // name would put on screen the very text that gate rejected.
      label: participant.speaker.label,
      subject: character ?? {
        name: participant.speaker.label,
        avatarColor: deterministicColor(participant.speaker.id),
      },
      ...(participant.role ? { role: participant.role } : {}),
    }
  })
}
