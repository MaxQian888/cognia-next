"use client"

import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { cn } from "@/lib/utils"
import { avatarColor, avatarGlyph } from "@/lib/avatar"
import { listCharactersByIds } from "@/lib/db/characters"
import { getSession, updateSession } from "@/lib/db/sessions"
import { getTeam } from "@/lib/db/teams"
import { useUIStore, type MemberStatus } from "@/stores/ui-store"
import type { Character } from "@/lib/claude/types"
import { useLiveQuery } from "dexie-react-hooks"
import { ChevronDownIcon, ChevronRightIcon, StickyNoteIcon, UsersIcon } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

interface Props {
  /** Currently active team session id; member list is hidden if null. */
  teamSessionId: string | null
  teamId: string | null
  /**
   * Click handler for "@mention" — caller injects `@CharacterName ` into the
   * composer for the active session.
   */
  onMention: (character: Character) => void
}

/**
 * Right rail (220px). Visible only in team sessions. Shows each team member's
 * avatar, name, and live status dot. Clicking a row inserts the character's
 * `@mention` into the composer.
 */
export function MemberList({ teamSessionId, teamId, onMention }: Props) {
  const showMemberList = useUIStore((s) => s.showMemberList)
  const setShowMemberList = useUIStore((s) => s.setShowMemberList)
  const memberStatus = useUIStore((s) => s.memberStatus)

  const team = useLiveQuery(() => {
    if (typeof window === "undefined") return Promise.resolve(undefined)
    if (!teamId) return Promise.resolve(undefined)
    return getTeam(teamId)
  }, [teamId])

  const memberIdsKey = team?.members.map((m) => m.characterId).join(",") ?? ""
  const members = useLiveQuery<Character[]>(() => {
    if (typeof window === "undefined") return Promise.resolve([])
    if (!team) return Promise.resolve([])
    return listCharactersByIds(team.members.map((m) => m.characterId))
  }, [team?.id, memberIdsKey])

  const orderedMembers = useMemo(() => {
    if (!team || !members) return []
    const byId = new Map(members.map((c) => [c.id, c]))
    return team.members
      .map((m) => byId.get(m.characterId))
      .filter((c): c is Character => Boolean(c))
  }, [team, members])

  if (!teamId || !teamSessionId) return null

  if (!showMemberList) {
    return (
      <div className="hidden border-l bg-muted/20 lg:flex">
        <Button
          variant="ghost"
          size="icon"
          className="m-2 size-8"
          onClick={() => setShowMemberList(true)}
          aria-label="Show member list"
          title="Show member list"
        >
          <UsersIcon className="size-4" />
        </Button>
      </div>
    )
  }

  return (
    <aside
      className="hidden h-full w-56 shrink-0 flex-col border-l bg-muted/20 lg:flex"
      aria-label="Team members"
    >
      <div className="flex items-center justify-between gap-2 px-3 py-3">
        <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Members — {orderedMembers.length}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={() => setShowMemberList(false)}
          aria-label="Hide member list"
          title="Hide member list"
        >
          <ChevronRightIcon className="size-4" />
        </Button>
      </div>

      <ScratchpadPanel teamSessionId={teamSessionId} />

      <ScrollArea className="flex-1">
        <ul className="flex flex-col gap-0.5 px-2 pb-2">
          {orderedMembers.map((member) => (
            <MemberRow
              key={member.id}
              teamSessionId={teamSessionId}
              character={member}
              status={memberStatus[`${teamSessionId}::${member.id}`] ?? "idle"}
              onMention={() => onMention(member)}
            />
          ))}
          {orderedMembers.length === 0 && (
            <li className="px-2 py-3 text-xs text-muted-foreground">No members.</li>
          )}
        </ul>
      </ScrollArea>
    </aside>
  )
}

function ScratchpadPanel({ teamSessionId }: { teamSessionId: string }) {
  const collapsed = useUIStore((s) => s.scratchpadCollapsed[teamSessionId] ?? false)
  const setCollapsed = useUIStore((s) => s.setScratchpadCollapsed)

  const session = useLiveQuery(() => {
    if (typeof window === "undefined") return Promise.resolve(undefined)
    return getSession(teamSessionId)
  }, [teamSessionId])

  const [draft, setDraft] = useState(session?.scratchpad ?? "")
  // Keep the textarea in sync when the session id changes (different team).
  // We intentionally don't sync on every Dexie update — the user is the
  // authoritative editor; reflecting remote writes would be racy.
  const lastSessionRef = useRef<string | null>(null)
  useEffect(() => {
    if (lastSessionRef.current === teamSessionId) return
    lastSessionRef.current = teamSessionId
    setDraft(session?.scratchpad ?? "")
  }, [teamSessionId, session?.scratchpad])

  // Debounced persist (500ms after the last keystroke).
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (lastSessionRef.current !== teamSessionId) return
    const persisted = session?.scratchpad ?? ""
    if (draft === persisted) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      void updateSession(teamSessionId, { scratchpad: draft }).catch(() => {})
    }, 500)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, teamSessionId])

  return (
    <div className="border-y bg-muted/10">
      <button
        type="button"
        onClick={() => setCollapsed(teamSessionId, !collapsed)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
        aria-expanded={!collapsed}
      >
        {collapsed ? (
          <ChevronRightIcon className="size-3" />
        ) : (
          <ChevronDownIcon className="size-3" />
        )}
        <StickyNoteIcon className="size-3" />
        Shared notes
        <span className="ml-auto font-normal normal-case text-muted-foreground">
          {draft.length > 0 ? `${draft.length} chars` : ""}
        </span>
      </button>
      {!collapsed && (
        <div className="px-3 pb-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            placeholder="Notes injected into every member's transcript on each turn…"
            className="text-xs"
          />
        </div>
      )}
    </div>
  )
}

function MemberRow({
  teamSessionId,
  character,
  status,
  onMention,
}: {
  teamSessionId: string
  character: Character
  status: MemberStatus
  onMention: () => void
}) {
  const requestStop = useUIStore((s) => s.requestStopMember)

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li className="rounded-md hover:bg-accent">
          <button
            type="button"
            onClick={onMention}
            className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm"
            title={`Mention ${character.name}`}
          >
            <span
              className="relative flex size-6 items-center justify-center rounded-full text-xs"
              style={{
                backgroundColor: avatarColor(character),
                color: "white",
              }}
              aria-hidden
            >
              {avatarGlyph(character)}
              <span
                className={cn(
                  "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-background",
                  status === "thinking" && "animate-pulse bg-amber-500",
                  status === "errored" && "bg-destructive",
                  status === "idle" && "bg-emerald-500"
                )}
                aria-label={`Status: ${status}`}
              />
            </span>
            <span className="min-w-0 flex-1 truncate" style={{ color: avatarColor(character) }}>
              {character.name}
            </span>
          </button>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          disabled={status !== "thinking"}
          onSelect={() => requestStop(teamSessionId, character.id)}
        >
          Stop this member
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
