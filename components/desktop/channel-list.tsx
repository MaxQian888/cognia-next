"use client"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { useIsNarrow } from "@/hooks/use-media-query"
import { listCharacters } from "@/lib/db/characters"
import { listSessionStates } from "@/lib/db/session-state"
import { getTeam } from "@/lib/db/teams"
import { useUIStore } from "@/stores/ui-store"
import type { Character, ChatSession, Team } from "@/lib/claude/types"
import { useLiveQuery } from "dexie-react-hooks"
import { MailIcon, MenuIcon, PlusIcon, UsersIcon } from "lucide-react"
import { useMemo, useState } from "react"
import { SessionRow } from "./session-row"
import { avatarColor, avatarGlyph } from "@/lib/avatar"

interface Props {
  sessions: ChatSession[]
  activeSessionId: string | null
  onSelect: (id: string) => void
  onNewDirect: () => void
  onNewTeamConversation: (teamId: string) => void
  onDelete: (id: string) => void | Promise<void>
  onRename: (id: string, title: string) => void | Promise<void>
}

/**
 * The mid sidebar (~260px). Lists sessions filtered by the currently selected
 * guild from `useUIStore`. On narrow viewports it collapses to a sheet
 * triggered by a hamburger button at the very top-left.
 */
export function ChannelList(props: Props) {
  const isNarrow = useIsNarrow()
  const [openMobile, setOpenMobile] = useState(false)

  const handleSelect = (id: string) => {
    props.onSelect(id)
    if (isNarrow) setOpenMobile(false)
  }

  if (isNarrow) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile}>
        <SheetTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open sessions"
            className="absolute top-2 left-2 z-10 md:hidden"
          >
            <MenuIcon className="size-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-72 p-0">
          <SheetHeader className="px-3 pt-3 pb-1">
            <SheetTitle className="text-sm">Conversations</SheetTitle>
          </SheetHeader>
          <ChannelListBody {...props} onSelect={handleSelect} />
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <aside
      className="hidden h-full w-64 shrink-0 flex-col border-r bg-background md:flex"
      aria-label="Conversations"
    >
      <ChannelListBody {...props} onSelect={handleSelect} />
    </aside>
  )
}

function ChannelListBody({
  sessions,
  activeSessionId,
  onSelect,
  onNewDirect,
  onNewTeamConversation,
  onDelete,
  onRename,
}: Props) {
  const selectedGuild = useUIStore((s) => s.selectedGuild)
  const characters = useLiveQuery<Character[]>(
    () => (typeof window === "undefined" ? Promise.resolve([]) : listCharacters()),
    []
  )
  const characterById = useMemo(() => {
    const map = new Map<string, Character>()
    for (const c of characters ?? []) map.set(c.id, c)
    return map
  }, [characters])

  const sessionStates = useLiveQuery(
    () => (typeof window === "undefined" ? Promise.resolve([]) : listSessionStates()),
    []
  )
  const unreadById = useMemo(() => {
    const map = new Map<string, number>()
    for (const s of sessionStates ?? []) {
      if (s.unreadCount > 0) map.set(s.sessionId, s.unreadCount)
    }
    return map
  }, [sessionStates])

  const team = useLiveQuery<Team | undefined>(() => {
    if (typeof window === "undefined") return Promise.resolve(undefined)
    if (selectedGuild.kind !== "team") return Promise.resolve(undefined)
    return getTeam(selectedGuild.teamId)
  }, [selectedGuild])

  // Filter the session list by selected guild.
  const filtered = useMemo(() => {
    if (selectedGuild.kind === "team") {
      return sessions.filter((s) => s.kind === "team" && s.teamId === selectedGuild.teamId)
    }
    // DM bucket: anything that isn't a team session.
    return sessions.filter((s) => s.kind !== "team")
  }, [sessions, selectedGuild])

  // For DMs, group by character; legacy sessions land under "Other".
  const dmGroups = useMemo(() => {
    if (selectedGuild.kind !== "dm") return null
    const groups = new Map<string | null, ChatSession[]>()
    for (const s of filtered) {
      const key = s.characterId ?? null
      const arr = groups.get(key) ?? []
      arr.push(s)
      groups.set(key, arr)
    }
    return groups
  }, [filtered, selectedGuild])

  return (
    <div className="flex h-full flex-col">
      <Header
        selectedGuild={selectedGuild}
        team={team ?? null}
        onNewDirect={onNewDirect}
        onNewTeamConversation={onNewTeamConversation}
      />
      <Separator />
      <ScrollArea className="flex-1">
        {filtered.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">
            {selectedGuild.kind === "team"
              ? "No conversations yet. Start one above."
              : "No chats yet. Pick a character to begin."}
          </p>
        ) : selectedGuild.kind === "team" ? (
          <ul className="flex flex-col gap-0.5 p-2">
            {filtered.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                active={s.id === activeSessionId}
                accentColor={team ? avatarColor(team) : undefined}
                unread={unreadById.get(s.id)}
                onSelect={onSelect}
                onDelete={onDelete}
                onRename={onRename}
              />
            ))}
          </ul>
        ) : (
          <DmGroupedList
            groups={dmGroups!}
            characterById={characterById}
            activeSessionId={activeSessionId}
            unreadById={unreadById}
            onSelect={onSelect}
            onDelete={onDelete}
            onRename={onRename}
          />
        )}
      </ScrollArea>
    </div>
  )
}

function Header({
  selectedGuild,
  team,
  onNewDirect,
  onNewTeamConversation,
}: {
  selectedGuild: { kind: "dm" } | { kind: "team"; teamId: string }
  team: Team | null
  onNewDirect: () => void
  onNewTeamConversation: (teamId: string) => void
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-3">
      <div className="flex min-w-0 items-center gap-2">
        {selectedGuild.kind === "dm" ? (
          <MailIcon className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <UsersIcon
            className="size-4 shrink-0"
            style={{
              color: team ? avatarColor(team) : undefined,
            }}
          />
        )}
        <span className="truncate text-sm font-semibold tracking-tight">
          {selectedGuild.kind === "dm" ? "Direct Messages" : (team?.name ?? "Team")}
        </span>
      </div>
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        onClick={() => {
          if (selectedGuild.kind === "team") {
            onNewTeamConversation(selectedGuild.teamId)
          } else {
            onNewDirect()
          }
        }}
        aria-label={selectedGuild.kind === "team" ? "New conversation" : "New chat"}
        title={selectedGuild.kind === "team" ? "New conversation" : "New chat"}
      >
        <PlusIcon className="size-4" />
      </Button>
    </div>
  )
}

function DmGroupedList({
  groups,
  characterById,
  activeSessionId,
  unreadById,
  onSelect,
  onDelete,
  onRename,
}: {
  groups: Map<string | null, ChatSession[]>
  characterById: Map<string, Character>
  activeSessionId: string | null
  unreadById: Map<string, number>
  onSelect: (id: string) => void
  onDelete: (id: string) => void | Promise<void>
  onRename: (id: string, title: string) => void | Promise<void>
}) {
  // Sort: characters with sessions first (alphabetical by name), then "Other".
  const entries = [...groups.entries()].sort((a, b) => {
    if (a[0] === null) return 1
    if (b[0] === null) return -1
    const ca = characterById.get(a[0])?.name ?? ""
    const cb = characterById.get(b[0])?.name ?? ""
    return ca.localeCompare(cb)
  })

  return (
    <div className="flex flex-col gap-3 p-2">
      {entries.map(([characterId, list]) => {
        const character = characterId ? characterById.get(characterId) : null
        return (
          <section key={characterId ?? "other"} aria-label={character?.name ?? "Other"}>
            <div className="flex items-center gap-2 px-2 pb-1">
              {character ? (
                <span
                  className="flex size-4 items-center justify-center rounded-full text-[10px]"
                  style={{
                    backgroundColor: avatarColor(character),
                    color: "white",
                  }}
                  aria-hidden
                >
                  {avatarGlyph(character)}
                </span>
              ) : (
                <span className="size-2 rounded-full bg-muted-foreground/40" aria-hidden />
              )}
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {character?.name ?? "Other"}
              </span>
            </div>
            <ul className="flex flex-col gap-0.5">
              {list.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  active={s.id === activeSessionId}
                  accentColor={character ? avatarColor(character) : undefined}
                  unread={unreadById.get(s.id)}
                  onSelect={onSelect}
                  onDelete={onDelete}
                  onRename={onRename}
                />
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
