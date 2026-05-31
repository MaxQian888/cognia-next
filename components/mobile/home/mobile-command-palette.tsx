"use client"

/**
 * Mobile global search / quick-jump. Mirrors the desktop `CommandPalette`
 * (`components/desktop/command-palette.tsx`) but is controlled by the shell
 * (opened from the home search bar / top-bar button) and adds a Workflows
 * group (jump to `/workflows/[id]`) the desktop palette lacks.
 *
 * Built on the shared cmdk primitives (`components/ui/command.tsx`).
 */

import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  MessageSquareIcon,
  PlusIcon,
  SettingsIcon,
  UsersIcon,
  UsersRoundIcon,
  WorkflowIcon,
} from "lucide-react"

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import { AvatarBadge } from "@/components/desktop/avatar-badge"
import { useSessions } from "@/hooks/chat"
import { useClientLiveQuery } from "@/hooks/data"
import { useUIStore } from "@/stores/ui"
import { listCharacters } from "@/lib/db/characters"
import { listTeams } from "@/lib/db/teams"
import { listWorkflows } from "@/lib/db/workflows"
import { loggers } from "@/lib/logging"
import type { Character, Team } from "@/lib/claude/types"
import type { WorkflowRow } from "@/types/workflow/visual"

const log = loggers.ui

export interface MobileCommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Start a new chat (opens the shell's character picker). */
  onNewChat: () => void
  /** Resume a session by id. */
  onSelectSession: (id: string) => void
  /** Open settings (optionally a section). */
  onOpenSettings: (tab?: string) => void
}

export function MobileCommandPalette({
  open,
  onOpenChange,
  onNewChat,
  onSelectSession,
  onOpenSettings,
}: MobileCommandPaletteProps) {
  const t = useTranslations("mobile.search")
  const router = useRouter()
  const { sessions, create, select } = useSessions()
  const setSelectedGuild = useUIStore((s) => s.setSelectedGuild)
  const characters = useClientLiveQuery<Character[]>(() => listCharacters(), [], [])
  const teams = useClientLiveQuery<Team[]>(() => listTeams(), [], [])
  const workflows = useClientLiveQuery<WorkflowRow[]>(() => listWorkflows(), [], [])

  const close = () => onOpenChange(false)

  const handleNewChat = () => {
    log.info("mobile-search new-chat")
    close()
    onNewChat()
  }

  const handleSettings = (tab?: string) => {
    close()
    onOpenSettings(tab)
  }

  const handleSession = (id: string) => {
    log.info("mobile-search select-session", { sessionId: id })
    close()
    onSelectSession(id)
  }

  const handleCharacter = async (c: Character) => {
    log.info("mobile-search new-chat-with-character", { characterId: c.id })
    close()
    const s = await create({
      title: t("titles.chatWith", { name: c.name }),
      kind: "direct",
      characterId: c.id,
    })
    select(s.id)
    setSelectedGuild({ kind: "dm" })
  }

  const handleTeam = (team: Team) => {
    log.info("mobile-search switch-to-team", { teamId: team.id })
    close()
    setSelectedGuild({ kind: "team", teamId: team.id })
  }

  const handleWorkflow = (wf: WorkflowRow) => {
    log.info("mobile-search open-workflow", { workflowId: wf.id })
    close()
    router.push(`/workflows/${encodeURIComponent(wf.id)}`)
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("title")}
      description={t("description")}
    >
      <CommandInput placeholder={t("placeholder")} />
      <CommandList>
        <CommandEmpty>{t("empty")}</CommandEmpty>

        <CommandGroup heading={t("groups.actions")}>
          <CommandItem onSelect={handleNewChat} value="action new chat">
            <PlusIcon className="size-4" />
            <span>{t("actions.newChat")}</span>
          </CommandItem>
          <CommandItem onSelect={() => handleSettings()} value="action settings">
            <SettingsIcon className="size-4" />
            <span>{t("actions.openSettings")}</span>
          </CommandItem>
        </CommandGroup>

        {(workflows?.length ?? 0) > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading={t("groups.workflows")}>
              {workflows!.slice(0, 12).map((wf) => (
                <CommandItem
                  key={wf.id}
                  value={`workflow ${wf.name} ${wf.description ?? ""}`}
                  onSelect={() => handleWorkflow(wf)}
                >
                  <WorkflowIcon className="size-4" />
                  <span className="truncate">{wf.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        {(characters?.length ?? 0) > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading={t("groups.characters")}>
              {characters!.map((c) => (
                <CommandItem
                  key={c.id}
                  value={`character ${c.name} ${c.description ?? ""}`}
                  onSelect={() => void handleCharacter(c)}
                >
                  <AvatarBadge subject={c} size={20} />
                  <span className="truncate">{c.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        {(teams?.length ?? 0) > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading={t("groups.teams")}>
              {teams!.map((team) => (
                <CommandItem
                  key={team.id}
                  value={`team ${team.name} ${team.description ?? ""}`}
                  onSelect={() => handleTeam(team)}
                >
                  <UsersRoundIcon className="size-4" />
                  <span className="truncate">{team.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        {sessions.length > 0 ? (
          <>
            <CommandSeparator />
            <CommandGroup heading={t("groups.sessions")}>
              {sessions.slice(0, 12).map((s) => (
                <CommandItem
                  key={s.id}
                  value={`session ${s.title}`}
                  onSelect={() => handleSession(s.id)}
                >
                  {s.kind === "team" ? (
                    <UsersIcon className="size-4" />
                  ) : (
                    <MessageSquareIcon className="size-4" />
                  )}
                  <span className="truncate">{s.title}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}
      </CommandList>
    </CommandDialog>
  )
}
