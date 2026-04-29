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
import { useEffect, useState } from "react"
import { useSessions } from "@/hooks/use-sessions"
import { useChatStore } from "@/stores/chat-store"
import { useSettingsStore } from "@/stores/settings-store"
import { useUIStore } from "@/stores/ui-store"
import { listCharacters } from "@/lib/db/characters"
import { listTeams } from "@/lib/db/teams"
import { useLiveQuery } from "dexie-react-hooks"
import type { Character, Team } from "@/lib/claude/types"
import { messagesToMarkdown } from "@/components/ai-elements/conversation"
import { avatarColor, avatarGlyph } from "@/lib/avatar"
import { isTauri } from "@/lib/tauri"
import { toast } from "sonner"

interface Props {
  onOpenSettings: (tab?: string) => void
}

export function CommandPalette({ onOpenSettings }: Props) {
  const [open, setOpen] = useState(false)
  const { sessions, select, create } = useSessions()
  const messages = useChatStore((s) => s.messages)
  const settings = useSettingsStore((s) => s.settings)
  const setSelectedGuild = useUIStore((s) => s.setSelectedGuild)
  const characters = useLiveQuery<Character[]>(
    () => (typeof window === "undefined" ? Promise.resolve([]) : listCharacters()),
    []
  )
  const teams = useLiveQuery<Team[]>(
    () => (typeof window === "undefined" ? Promise.resolve([]) : listTeams()),
    []
  )
  const { theme, setTheme } = useTheme()

  // Global Cmd/Ctrl+K trigger.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMac =
        typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac")
      const meta = isMac ? e.metaKey : e.ctrlKey
      if (meta && e.key.toLowerCase() === "k" && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const close = () => setOpen(false)

  const handleNewChat = async () => {
    close()
    await create()
  }

  const handleSelect = (id: string) => {
    close()
    select(id)
  }

  const handleSettings = (tab?: string) => {
    close()
    onOpenSettings(tab)
  }

  const handleExport = () => {
    close()
    if (messages.length === 0) {
      toast.info("Nothing to export — start a conversation first.")
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
    close()
    const id = useChatStore.getState().activeSessionId
    if (!id) return
    const { clearMessages } = await import("@/lib/db/messages")
    await clearMessages(id)
    useChatStore.getState().replaceMessages([])
    toast.success("Conversation cleared.")
  }

  const handleCheckUpdate = async () => {
    close()
    if (!isTauri()) {
      toast.info("Updates are only available in the desktop build.")
      return
    }
    try {
      const { check } = await import("@tauri-apps/plugin-updater")
      const update = await check()
      if (!update) {
        toast.success("You're on the latest version.")
        return
      }
      toast.success(`Update available: ${update.version}`)
      onOpenSettings("about")
    } catch (err) {
      toast.error(`Update check failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const toggleTheme = () => {
    close()
    setTheme(theme === "dark" ? "light" : "dark")
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Search for commands and sessions"
    >
      <CommandInput placeholder="Type a command or session name…" />
      <CommandList>
        <CommandEmpty>No matches found.</CommandEmpty>

        <CommandGroup heading="Actions">
          <CommandItem onSelect={handleNewChat}>
            <PlusIcon className="size-4" />
            <span>New chat</span>
            <span className="ml-auto text-xs text-muted-foreground">new</span>
          </CommandItem>
          <CommandItem onSelect={handleExport}>
            <DownloadIcon className="size-4" />
            <span>Export current chat as Markdown</span>
          </CommandItem>
          <CommandItem onSelect={() => void handleClearMessages()}>
            <Trash2Icon className="size-4" />
            <span>Clear current conversation</span>
          </CommandItem>
          <CommandItem onSelect={toggleTheme}>
            {theme === "dark" ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
            <span>Toggle theme</span>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Settings">
          <CommandItem onSelect={() => handleSettings("general")}>
            <SettingsIcon className="size-4" />
            <span>Open settings</span>
          </CommandItem>
          <CommandItem onSelect={() => handleSettings("api-key")}>
            <KeyRoundIcon className="size-4" />
            <span>Manage API key</span>
            {settings?.apiKey && <CheckIcon className="ml-auto size-3.5 text-muted-foreground" />}
          </CommandItem>
          <CommandItem onSelect={() => handleSettings("characters")}>
            <UsersRoundIcon className="size-4" />
            <span>Manage characters</span>
          </CommandItem>
          <CommandItem onSelect={() => handleSettings("skills")}>
            <SparklesIcon className="size-4" />
            <span>Manage skills</span>
          </CommandItem>
          <CommandItem onSelect={() => handleSettings("teams")}>
            <UsersIcon className="size-4" />
            <span>Manage teams</span>
          </CommandItem>
          <CommandItem onSelect={() => handleSettings("mcp")}>
            <ServerIcon className="size-4" />
            <span>Manage MCP servers</span>
          </CommandItem>
          <CommandItem onSelect={() => void handleCheckUpdate()}>
            <RefreshCwIcon className="size-4" />
            <span>Check for updates</span>
          </CommandItem>
        </CommandGroup>

        {(characters?.length ?? 0) > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="New chat with character">
              {characters!.map((c) => (
                <CommandItem
                  key={c.id}
                  value={`character ${c.name} ${c.description ?? ""}`}
                  onSelect={async () => {
                    close()
                    const s = await create({
                      title: `Chat with ${c.name}`,
                      kind: "direct",
                      characterId: c.id,
                    })
                    select(s.id)
                    setSelectedGuild({ kind: "dm" })
                  }}
                >
                  <span
                    className="flex size-5 items-center justify-center rounded-full text-[10px]"
                    style={{
                      backgroundColor: avatarColor(c),
                      color: "white",
                    }}
                    aria-hidden
                  >
                    {avatarGlyph(c)}
                  </span>
                  <span className="truncate">{c.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {(teams?.length ?? 0) > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Switch to team">
              {teams!.map((t) => (
                <CommandItem
                  key={t.id}
                  value={`team ${t.name} ${t.description ?? ""}`}
                  onSelect={() => {
                    close()
                    setSelectedGuild({ kind: "team", teamId: t.id })
                  }}
                >
                  <span
                    className="flex size-5 items-center justify-center rounded-full text-[10px]"
                    style={{
                      backgroundColor: avatarColor(t),
                      color: "white",
                    }}
                    aria-hidden
                  >
                    {avatarGlyph(t)}
                  </span>
                  <span className="truncate">{t.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {sessions.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Sessions">
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
