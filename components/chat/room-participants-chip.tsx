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
 * So this asks the question the same way the prompt does. `lib/chat/room/
 * participants.ts` (ADR-0177) reads the declared membership from whichever
 * store the room's kind keeps (team slots, the collab membership mirror) and
 * merges it with whoever `lib/chat/speaker.ts` says has spoken. The chip is
 * that projection with faces attached, which is what keeps the header and the
 * model looking at the same room. The projection also says how complete it
 * is, and an IM group, which declares no members at all, gets a line saying
 * only those who have spoken are listed.
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
import { useClientLiveQuery } from "@/hooks/data"
import { useTeamMemberRoles, useTeamMembers } from "@/hooks/use-team-members"
import { roomKindOf } from "@/lib/chat/room/kind"
import { projectRoomParticipants, type RoomRosterCompleteness } from "@/lib/chat/room/participants"
import { MAX_ROSTER_PARTICIPANTS } from "@/lib/chat/room-roster"
import type { SpeakerSource } from "@/lib/chat/speaker"
import { deterministicColor, type AvatarSubject } from "@/lib/ui/avatar"
import { cn } from "@/lib/utils"
import { useChatStore } from "@/stores/chat"
import { useUIStore } from "@/stores/ui"
import type { Character, ChatSession } from "@cognia/agent-config-types"
import type { SessionMembership } from "@cognia/agent-config-types/collaboration"

/** Faces shown side by side before the rest collapse into the count. */
const STACKED_FACES = 3

interface Row {
  id: string
  subject: AvatarSubject
  label: string
  role?: string
  /** What the member is doing right now, for a team room (ADR-0177 batch 2). */
  activity?: string
}

export function RoomParticipantsChip({
  session,
  className,
}: {
  session: ChatSession
  className?: string
}) {
  const t = useTranslations("chatRoom")
  const kind = roomKindOf(session)
  const teamId = kind === "team" ? session.teamId : undefined
  const members = useTeamMembers(teamId)
  const roles = useTeamMemberRoles(teamId)
  const memberships = useSharedRoomMemberships(kind === "shared" ? session.id : null)
  const messages = useChatStore((state) => state.sessions[session.id]?.messages)
  const memberActivity = useUIStore((state) => state.memberActivity)

  const { rows, completeness } = useMemo(
    // `UIMessage.metadata` is `unknown` by construction, while `SpeakerSource`
    // wants the record it actually holds. The resolver reads that field
    // defensively at every step, so the widening is safe and the same one
    // the room runner makes when it feeds these rows to the prompt.
    () =>
      buildRows({
        kind,
        members,
        roles,
        memberships,
        messages: (messages ?? []) as unknown as readonly SpeakerSource[],
        activityFor: (id) => memberActivity[`${session.id}::${id}`],
      }),
    [kind, members, roles, memberships, messages, memberActivity, session.id]
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
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{row.label}</span>
              {row.activity ? (
                <span
                  className="truncate text-[11px] text-amber-600 dark:text-amber-400"
                  aria-label={t("working", { activity: row.activity })}
                  data-testid={`room-participant-activity-${row.id}`}
                >
                  {row.activity}
                </span>
              ) : null}
            </span>
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
        {completeness === "observed" ? (
          <DropdownMenuLabel
            className="text-[11px] font-normal text-muted-foreground"
            data-testid="room-participants-observed"
          >
            {t("observedOnly")}
          </DropdownMenuLabel>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * A shared room's members, from the collab membership mirror. Read only for a
 * shared session, and read lazily so a chip on a team or IM room never touches
 * the mirror at all.
 */
function useSharedRoomMemberships(sessionId: string | null): readonly SessionMembership[] {
  return (
    useClientLiveQuery<readonly SessionMembership[]>(
      () =>
        sessionId
          ? import("@/lib/db/schema").then(({ getDb }) =>
              getDb().collabChatMemberships.where("sessionId").equals(sessionId).toArray()
            )
          : Promise.resolve([]),
      [sessionId],
      []
    ) ?? []
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
function buildRows(input: {
  kind: ReturnType<typeof roomKindOf>
  members: readonly Character[]
  roles: ReadonlyMap<string, string>
  memberships: readonly SessionMembership[]
  messages: readonly SpeakerSource[]
  activityFor?: (characterId: string) => string | undefined
}): { rows: Row[]; completeness: RoomRosterCompleteness } {
  const { kind, members, roles, memberships, messages, activityFor } = input
  const { participants, completeness } = projectRoomParticipants({
    kind,
    characters: members,
    members: [...roles].map(([characterId, role]) => ({ characterId, role })),
    memberships,
    messages,
  })
  const characterById = new Map(members.map((member) => [member.id, member]))

  const rows = participants.map((participant) => {
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
      ...(activityFor?.(participant.speaker.id)
        ? { activity: activityFor(participant.speaker.id) }
        : {}),
    }
  })
  return { rows, completeness }
}
