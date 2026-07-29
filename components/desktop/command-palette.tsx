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
  FolderIcon,
  FolderOpenIcon,
  KeyRoundIcon,
  MailIcon,
  MessageSquareIcon,
  MoonIcon,
  PanelRightIcon,
  PencilRulerIcon,
  PlusIcon,
  PuzzleIcon,
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
import { useRouter } from "next/navigation"
import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { useSessions } from "@/hooks/chat"
import { usePlatform } from "@/hooks/use-platform"
import { getSidebarCatalog } from "@/lib/shell/sidebar-nav"
import {
  getActiveContextRevision,
  getActiveWorkbenchPanels,
  revealActiveWorkbenchPanel,
  subscribeActiveContext,
} from "@/lib/context-workbench/active-context"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { useUIStore } from "@/stores/ui"
import { useProjectStore } from "@/stores/project/project-store"
import { primaryRootOf } from "@/lib/workspace/roots"
import { openFolderAsWorkspace } from "@/lib/workspace/open-folder"
import { useClientLiveQuery } from "@/hooks/data"
import { listCharacters } from "@/lib/db/characters"
import { listTeams } from "@/lib/db/teams"
import { loggers } from "@cognia/logging"
import type { Character, Team } from "@cognia/agent-config-types"
import { messagesToMarkdown } from "@/components/ai-elements/conversation"
import { isTauri } from "@/lib/tauri"
import { checkForUpdate } from "@/lib/tauri/updater"
import { getPluginEventHooks } from "@/lib/plugin"
import { toast } from "sonner"
import { AvatarBadge } from "./avatar-badge"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { usePluginQuickActions } from "@/hooks/plugins/use-plugin-quick-actions"
import {
  runQuickAction,
  type QuickActionEntry,
} from "@/lib/plugin/registries/quick-action-registry"

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
  const workspaces = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const setActiveProject = useProjectStore((s) => s.setActiveProject)
  const { theme, setTheme } = useTheme()
  const pluginQuickActions = usePluginQuickActions("palette")
  const router = useRouter()
  const platform = usePlatform()
  const railT = useTranslations("desktop.guildRail")
  const workbenchT = useTranslations()

  // The whole nav catalog, including what the user hid from the rail: the
  // palette is the fallback route to a destination they took off the rail, and
  // the only one once the rail moved to the far edge.
  const navItems = useMemo(() => getSidebarCatalog(platform), [platform])

  // Panels of whichever workbench is in front. Empty on routes that mount none,
  // which drops the group entirely rather than listing dead entries.
  //
  // Subscribed to the active *context* rather than `subscribeActiveWorkbench`:
  // the latter also fires on every layout-store write, so dragging the dock's
  // divider would re-render this always-mounted component once per frame. The
  // snapshot is the revision counter — the panel accessor returns fresh clones,
  // which React would reject as an uncached snapshot.
  useSyncExternalStore(subscribeActiveContext, getActiveContextRevision, () => 0)
  const workbenchPanels = getActiveWorkbenchPanels()

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

  const handleQuickAction = (action: QuickActionEntry) => {
    log.info("command-palette quick-action", { id: action.fullId })
    close()
    runQuickAction(action).catch((err) => {
      log.warn("quick action dispatch failed", { id: action.fullId, error: String(err) })
    })
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
      const update = await checkForUpdate()
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

  const handleSwitchWorkspace = (id: string) => {
    log.info("command-palette switch-workspace", { projectId: id })
    close()
    setActiveProject(id)
  }

  const handleNavigate = (route: string) => {
    log.info("command-palette navigate", { route })
    close()
    router.push(route)
  }

  const handleSwitchGuild = (kind: "dm" | "canvas") => {
    log.info("command-palette switch-guild", { kind })
    close()
    setSelectedGuild({ kind })
    router.push("/")
  }

  const handleRevealPanel = (panelId: string) => {
    log.info("command-palette reveal-panel", { panelId })
    close()
    revealActiveWorkbenchPanel(panelId)
  }

  /** Plugin panels namespace their label key; native ones live under the app tree. */
  const panelLabel = (panel: (typeof workbenchPanels)[number]) => {
    if (!panel.pluginId) return workbenchT(panel.labelKey as never)
    const key = `plugin.${panel.pluginId}.${panel.labelKey}`
    const has = (workbenchT as typeof workbenchT & { has?: (candidate: string) => boolean }).has
    return typeof has === "function" && has(key)
      ? workbenchT(key as never)
      : (panel.label ?? panel.labelKey)
  }

  const handleOpenFolder = async () => {
    log.info("command-palette open-folder")
    close()
    if (!isTauri()) {
      toast.info(t("toasts.openFolderDesktopOnly"))
      return
    }
    await openFolderAsWorkspace()
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
          <CommandItem onSelect={() => void handleOpenFolder()}>
            <FolderOpenIcon className="size-4" />
            <span>{t("actions.openFolder")}</span>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        {/* Every destination the navigation rail can reach, hidden ones
            included. Without this the rail was the only route to 19 pages —
            and it now sits at the far edge, away from the conversation list it
            drives. Reuses the rail's own catalog and labels, so a new section
            appears here the moment it appears there. */}
        <CommandGroup heading={t("groups.navigate")}>
          <CommandItem
            value={`navigate ${railT("directMessages")}`}
            onSelect={() => handleSwitchGuild("dm")}
          >
            <MailIcon className="size-4" />
            <span>{railT("directMessages")}</span>
          </CommandItem>
          <CommandItem
            value={`navigate ${railT("canvas")}`}
            onSelect={() => handleSwitchGuild("canvas")}
          >
            <PencilRulerIcon className="size-4" />
            <span>{railT("canvas")}</span>
          </CommandItem>
          {navItems.map((item) => (
            <CommandItem
              key={item.id}
              value={`navigate ${railT(item.i18nKey)} ${item.route}`}
              onSelect={() => handleNavigate(item.route)}
            >
              <item.Icon className="size-4" />
              <span>{railT(item.i18nKey)}</span>
              <span className="ml-auto text-xs text-muted-foreground">{item.route}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        {workbenchPanels.length > 0 && (
          <>
            <CommandSeparator />
            {/* The right-hand workbench's panels. Reachable here even when the
                user has hidden that activity from its rail — which is what
                makes hiding safe to offer at all. */}
            <CommandGroup heading={t("groups.workbenchPanels")}>
              {workbenchPanels.map((panel) => (
                <CommandItem
                  key={panel.id}
                  value={`panel ${panelLabel(panel)}`}
                  onSelect={() => handleRevealPanel(panel.id)}
                >
                  <PanelRightIcon className="size-4" />
                  <span className="truncate">{panelLabel(panel)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

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

        {workspaces.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t("groups.workspaces")}>
              {workspaces
                .filter((p) => !p.isArchived)
                .map((p) => (
                  <CommandItem
                    key={p.id}
                    value={`workspace ${p.name} ${primaryRootOf(p)?.path ?? ""}`}
                    onSelect={() => handleSwitchWorkspace(p.id)}
                  >
                    <FolderIcon className="size-4" />
                    <span className="truncate">{p.name}</span>
                    {activeProjectId === p.id && (
                      <CheckIcon className="ml-auto size-3.5 text-muted-foreground" />
                    )}
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

        {pluginQuickActions.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t("groups.pluginActions")}>
              {pluginQuickActions.map((action) => (
                <CommandItem
                  key={action.fullId}
                  value={`plugin ${action.title} ${action.description ?? ""}`}
                  onSelect={() => handleQuickAction(action)}
                >
                  <PuzzleIcon className="size-4" />
                  <span className="truncate">{action.title}</span>
                  {action.description && (
                    <span className="ml-auto truncate text-xs text-muted-foreground">
                      {action.description}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        <PluginExtensionSlot point="command-palette" className="border-t pt-1 empty:hidden" />
      </CommandList>
    </CommandDialog>
  )
}
