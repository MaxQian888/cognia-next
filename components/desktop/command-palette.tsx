"use client"

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import {
  CheckIcon,
  DownloadIcon,
  KeyRoundIcon,
  MessageSquareIcon,
  MoonIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  SettingsIcon,
  SparklesIcon,
  SunIcon,
  Trash2Icon,
  UsersIcon,
  UsersRoundIcon,
} from "lucide-react"
import { useTheme } from "next-themes"
import { useTranslations } from "next-intl"
import { useEffect, useState } from "react"
import { useSessions } from "@/hooks/chat"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { useUIStore } from "@/stores/ui"
import { useClientLiveQuery } from "@/hooks/data"
import { listCharacters } from "@/lib/db/characters"
import { listTeams } from "@/lib/db/teams"
import { loggers } from "@/lib/logger"
import type { Character, Team } from "@/lib/claude/types"
import { messagesToMarkdown } from "@/components/ai-elements/conversation"
import { isTauri } from "@/lib/tauri"
import { getPluginEventHooks } from "@/lib/plugin"
import { toast } from "sonner"
import { AvatarBadge } from "./avatar-badge"

const log = loggers.ui

interface Props {
  onOpenSettings: (tab?: string) => void
}

export function CommandPalette({ onOpenSettings }: Props) {
  const t = useTranslations("desktop.commandPalette")
  const [open, setOpen] = useState(false)
  const { sessions, select, create } = useSessions()
  const messages = useChatStore((s) => s.messages)
  const settings = useSettingsStore((s) => s.settings)
  const setSelectedGuild = useUIStore((s) => s.setSelectedGuild)
  const characters = useClientLiveQuery<Character[]>(() => listCharacters(), [], [])
  const teams = useClientLiveQuery<Team[]>(() => listTeams(), [], [])
  const { theme, setTheme } = useTheme()

  // Global Cmd/Ctrl+K trigger.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMac =
        typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac")
      const meta = isMac ? e.metaKey : e.ctrlKey
      if (meta && e.key.toLowerCase() === "k" && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        // Plugin host: announce the global Ctrl/Cmd+K shortcut so plugins can
        // observe / extend the command palette opening flow.
        void getPluginEventHooks().dispatchShortcut("command-palette.toggle")
        setOpen((v) => {
          log.info("command-palette toggle", { next: !v, source: "shortcut" })
          return !v
        })
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const close = () => setOpen(false)

  const handleNewChat = async () => {
    log.info("command-palette new-chat")
    close()
    await create()
  }

  const handleSelect = (id: string) => {
    log.info("command-palette select session", { sessionId: id })
    close()
    select(id)
  }

  const handleSettings = (tab?: string) => {
    log.info("command-palette open-settings", { tab })
    close()
    onOpenSettings(tab)
  }

  const handleExport = () => {
    log.info("command-palette export-md", { messageCount: messages.length })
    close()
    if (messages.length === 0) {
      toast.info(t("toasts.nothingToExport"))
      return
    }
    const md = messagesToMarkdown(messages)
    const blob = new Blob([md], { type: "text/markdown" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    const ts = new Date().toISOString().replaceAll(/[:.]/g, "-")
    link.href = url
    link.download = `cognia-chat-${ts}.md`
    document.body.append(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  const handleClearMessages = async () => {
    log.info("command-palette clear-messages")
    close()
    const id = useChatStore.getState().activeSessionId
    if (!id) return
    try {
      const { clearMessages } = await import("@/lib/db/messages")
      await clearMessages(id)
      useChatStore.getState().replaceMessages([])
      toast.success(t("toasts.conversationCleared"))
    } catch (err) {
      log.error("command-palette clear-messages failed", err, { sessionId: id })
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleCheckUpdate = async () => {
    log.info("command-palette check-update")
    close()
    if (!isTauri()) {
      toast.info(t("toasts.updatesDesktopOnly"))
      return
    }
    try {
      const { check } = await import("@tauri-apps/plugin-updater")
      const update = await check()
      if (!update) {
        toast.success(t("toasts.upToDate"))
        return
      }
      log.info("command-palette update-available", { version: update.version })
      toast.success(t("toasts.updateAvailable", { version: update.version }))
      onOpenSettings("about")
    } catch (err) {
      log.error("command-palette update-check failed", err)
      toast.error(
        t("toasts.updateFailed", { message: err instanceof Error ? err.message : String(err) })
      )
    }
  }

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark"
    log.info("command-palette toggle-theme", { from: theme, to: next })
    close()
    setTheme(next)
  }

  const handleNewChatWithCharacter = async (c: Character) => {
    log.info("command-palette new-chat-with-character", { characterId: c.id })
    close()
    const s = await create({
      title: t("titles.chatWith", { name: c.name }),
      kind: "direct",
      characterId: c.id,
    })
    select(s.id)
    setSelectedGuild({ kind: "dm" })
  }

  const handleSwitchToTeam = (team: Team) => {
    log.info("command-palette switch-to-team", { teamId: team.id })
    close()
    setSelectedGuild({ kind: "team", teamId: team.id })
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title={t("title")}
      description={t("description")}
    >
      <CommandInput placeholder={t("placeholder")} />
      <CommandList>
        <CommandEmpty>{t("empty")}</CommandEmpty>

        <CommandGroup heading={t("groups.actions")}>
          <CommandItem onSelect={handleNewChat}>
            <PlusIcon className="size-4" />
            <span>{t("actions.newChat")}</span>
            <span className="ml-auto text-xs text-muted-foreground">
              {t("actions.newChatHint")}
            </span>
          </CommandItem>
          <CommandItem onSelect={handleExport}>
            <DownloadIcon className="size-4" />
            <span>{t("actions.exportMd")}</span>
          </CommandItem>
          <CommandItem onSelect={() => void handleClearMessages()}>
            <Trash2Icon className="size-4" />
            <span>{t("actions.clearChat")}</span>
          </CommandItem>
          <CommandItem onSelect={toggleTheme}>
            {theme === "dark" ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
            <span>{t("actions.toggleTheme")}</span>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading={t("groups.settings")}>
          <CommandItem onSelect={() => handleSettings("general")}>
            <SettingsIcon className="size-4" />
            <span>{t("actions.openSettings")}</span>
          </CommandItem>
          <CommandItem onSelect={() => handleSettings("api-key")}>
            <KeyRoundIcon className="size-4" />
            <span>{t("actions.manageApiKey")}</span>
            {settings?.apiKey && <CheckIcon className="ml-auto size-3.5 text-muted-foreground" />}
          </CommandItem>
          <CommandItem onSelect={() => handleSettings("characters")}>
            <UsersRoundIcon className="size-4" />
            <span>{t("actions.manageCharacters")}</span>
          </CommandItem>
          <CommandItem onSelect={() => handleSettings("skills")}>
            <SparklesIcon className="size-4" />
            <span>{t("actions.manageSkills")}</span>
          </CommandItem>
          <CommandItem onSelect={() => handleSettings("teams")}>
            <UsersIcon className="size-4" />
            <span>{t("actions.manageTeams")}</span>
          </CommandItem>
          <CommandItem onSelect={() => handleSettings("mcp")}>
            <ServerIcon className="size-4" />
            <span>{t("actions.manageMcp")}</span>
          </CommandItem>
          <CommandItem onSelect={() => void handleCheckUpdate()}>
            <RefreshCwIcon className="size-4" />
            <span>{t("actions.checkUpdates")}</span>
          </CommandItem>
        </CommandGroup>

        {(characters?.length ?? 0) > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t("groups.newChat")}>
              {characters!.map((c) => (
                <CommandItem
                  key={c.id}
                  value={`character ${c.name} ${c.description ?? ""}`}
                  onSelect={() => void handleNewChatWithCharacter(c)}
                >
                  <AvatarBadge subject={c} size={20} />
                  <span className="truncate">{c.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {(teams?.length ?? 0) > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t("groups.switchTeam")}>
              {teams!.map((team) => (
                <CommandItem
                  key={team.id}
                  value={`team ${team.name} ${team.description ?? ""}`}
                  onSelect={() => handleSwitchToTeam(team)}
                >
                  <AvatarBadge subject={team} size={20} />
                  <span className="truncate">{team.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {sessions.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t("groups.sessions")}>
              {sessions.slice(0, 12).map((s) => (
                <CommandItem
                  key={s.id}
                  onSelect={() => handleSelect(s.id)}
                  value={`session ${s.title}`}
                >
                  <MessageSquareIcon className="size-4" />
                  <span className="truncate">{s.title}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  )
}
