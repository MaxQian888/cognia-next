"use client"

/**
 * Turn a chosen `GlobalSearchItem` into an effect (ADR-0129).
 *
 * This is where the two palettes' duplicated store logic now lives once:
 * follow a conversation into its workspace and guild before focusing it, jump
 * to a message with the cross-session primitive, run built-in commands, route
 * navigation, switch workspaces / guilds, run plugin quick actions. Shell
 * specifics (settings routing, mobile's picker-based "new chat", mobile's
 * drawer-closing session select) come in through `host`.
 */

import { useTheme } from "next-themes"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { useCallback } from "react"
import { toast } from "sonner"
import type { ChatSession } from "@cognia/agent-config-types"
import { loggers } from "@cognia/logging"

import { messagesToMarkdown } from "@/components/ai-elements/conversation"
import { jumpToSessionMessage } from "@/lib/chat/cross-session-jump"
import { guildFromSession } from "@/lib/claude/guild"
import { revealActiveWorkbenchPanel } from "@/lib/context-workbench/active-context"
import { inboxConversationHref } from "@/lib/inbox/conversation-href"
import type { BuiltinCommandId } from "@/lib/global-search/providers/actions"
import { clearAllGlobalSearchRecents, recordRecentItem } from "@/lib/global-search/recents"
import type { GlobalSearchAction, GlobalSearchItem } from "@/lib/global-search/types"
import { piPackageInstallHref } from "@/lib/pi-packages/deep-link"
import { getQuickAction, runQuickAction } from "@/lib/plugin/registries/quick-action-registry"
import { trackEvent } from "@/lib/telemetry/events/track-event"
import { isTauri } from "@/lib/tauri"
import { checkForUpdate } from "@/lib/tauri/updater"
import { openFolderAsWorkspace } from "@/lib/workspace/open-folder"
import { openRecorder } from "@/stores/skills/recorder-store"
import { useChatStore } from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"
import { useUIStore } from "@/stores/ui"
import { requestComposerReference } from "@/lib/chat/composer-reference-request"

const log = loggers.ui

/** Shell-specific behaviour the dialog cannot decide on its own. */
export interface GlobalSearchHost {
  onOpenSettings: (tab?: string, focus?: string) => void
  /** Mobile opens its character picker; desktop creates a session directly. */
  onNewChat?: () => void
  /** Mobile closes its drawer after selecting; desktop just selects. */
  onSelectSession?: (id: string) => void
}

export interface UseGlobalSearchActionsOptions {
  host: GlobalSearchHost
  sessions: readonly ChatSession[]
  select: (id: string) => void
  create: (init?: {
    title?: string
    kind?: "direct" | "team"
    characterId?: string
  }) => Promise<{ id: string }>
  /** Called before the effect runs — the dialog closes itself here. */
  close: () => void
}

/**
 * Follow a session into its workspace + guild, then focus it. Shared by the
 * conversation rows and message hits (both palettes had a private copy).
 */
export function focusSession(
  session: ChatSession | undefined,
  id: string,
  select: (id: string) => void
): void {
  if (session?.projectId) {
    const projectState = useProjectStore.getState()
    if (session.projectId !== projectState.activeProjectId) {
      projectState.setActiveProject(session.projectId)
    }
  }
  if (session) useUIStore.getState().setSelectedGuild(guildFromSession(session))
  select(id)
}

export function useGlobalSearchActions({
  host,
  sessions,
  select,
  create,
  close,
}: UseGlobalSearchActionsOptions) {
  const t = useTranslations("globalSearch")
  const router = useRouter()
  const { theme, setTheme } = useTheme()

  const openSession = useCallback(
    (sessionId: string, messageId?: string) => {
      const target = sessions.find((s) => s.id === sessionId)
      if (host.onSelectSession) {
        // The host owns focusing (mobile also closes its drawer); we still
        // follow the workspace / guild first so its `select` lands correctly.
        focusSession(target, sessionId, host.onSelectSession)
      } else {
        focusSession(target, sessionId, select)
      }
      if (!messageId) return
      void jumpToSessionMessage(sessionId, messageId, { align: "center" }).then((landed) => {
        if (!landed) toast.error(t("jumpFailed"))
      })
    },
    [sessions, host, select, t]
  )

  const runCommand = useCallback(
    async (id: BuiltinCommandId | string) => {
      log.info("global-search command", { id })
      switch (id as BuiltinCommandId) {
        case "new-chat": {
          if (host.onNewChat) return host.onNewChat()
          await create()
          return
        }
        case "export-markdown": {
          const messages = useChatStore.getState().messages
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
          return
        }
        case "clear-conversation": {
          const sessionId = useChatStore.getState().activeSessionId
          if (!sessionId) return
          try {
            const { clearMessages } = await import("@/lib/db/messages")
            await clearMessages(sessionId)
            useChatStore.getState().replaceMessages([])
            toast.success(t("toasts.conversationCleared"))
          } catch (err) {
            log.error("global-search clear-conversation failed", err, { sessionId })
            toast.error(err instanceof Error ? err.message : String(err))
          }
          return
        }
        case "toggle-theme":
          setTheme(theme === "dark" ? "light" : "dark")
          return
        case "toggle-sidebar":
          useUIStore.getState().toggleSidebar()
          return
        case "open-folder": {
          if (!isTauri()) {
            toast.info(t("toasts.openFolderDesktopOnly"))
            return
          }
          await openFolderAsWorkspace()
          return
        }
        case "open-recorder":
          openRecorder("palette")
          return
        case "open-browser":
          router.push("/browser")
          return
        case "check-updates": {
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
            toast.success(t("toasts.updateAvailable", { version: update.version }))
            host.onOpenSettings("about")
          } catch (err) {
            log.error("global-search update-check failed", err)
            toast.error(
              t("toasts.updateFailed", {
                message: err instanceof Error ? err.message : String(err),
              })
            )
          }
          return
        }
        case "open-settings":
          host.onOpenSettings("general")
          return
        case "manage-api-key":
          host.onOpenSettings("api-key")
          return
        case "manage-characters":
          host.onOpenSettings("characters")
          return
        case "manage-skills":
          host.onOpenSettings("skills")
          return
        case "manage-teams":
          host.onOpenSettings("teams")
          return
        case "manage-mcp":
          host.onOpenSettings("mcp")
          return
        case "clear-recent-searches":
          clearAllGlobalSearchRecents()
          toast.success(t("toasts.recentsCleared"))
          return
        default:
          log.warn("global-search unknown command", { id })
      }
    },
    [host, create, router, t, theme, setTheme]
  )

  const runAction = useCallback(
    async (action: GlobalSearchAction) => {
      switch (action.type) {
        case "open-session":
          openSession(action.sessionId, action.messageId)
          return
        case "open-inbox-conversation":
          router.push(inboxConversationHref(action.conversationKey, action.messageId))
          return
        case "navigate":
          router.push(action.href)
          return
        case "open-settings":
          host.onOpenSettings(action.tab, action.focus)
          return
        case "command":
          await runCommand(action.id)
          return
        case "reveal-panel":
          revealActiveWorkbenchPanel(action.panelId)
          return
        case "quick-action":
          await runQuickAction(action.entry).catch((err) => {
            log.warn("global-search quick action failed", {
              id: action.entry.fullId,
              error: String(err),
            })
          })
          return
        case "switch-workspace":
          useProjectStore.getState().setActiveProject(action.projectId)
          return
        case "switch-guild": {
          const ui = useUIStore.getState()
          if (action.kind === "team" && action.teamId) {
            ui.setSelectedGuild({ kind: "team", teamId: action.teamId })
          } else {
            ui.setSelectedGuild({ kind: action.kind === "team" ? "dm" : action.kind })
            router.push("/")
          }
          return
        }
        case "new-chat-with-character": {
          const session = await create({
            title: t("titles.chatWith", { name: action.characterName }),
            kind: "direct",
            characterId: action.characterId,
          })
          select(session.id)
          useUIStore.getState().setSelectedGuild({ kind: "dm" })
          return
        }
        case "install":
          // Route to the owning surface with the spec pre-selected; it opens
          // its own pre-install gate. The palette never installs directly —
          // skipping that gate would skip the overlap and budget warnings,
          // which for Pi packages are the only warnings there are.
          router.push(piPackageInstallHref(action.spec))
          return
        case "reference-in-composer":
          // Handed to the composer through a window event rather than staged
          // here: staging is per entity kind and lives in the mention
          // registry, and the palette must not grow a second copy of it. See
          // `lib/chat/composer-reference-request.ts`.
          requestComposerReference(action.candidate)
          return
        case "callback":
          await action.run()
          return
      }
    },
    [openSession, router, host, runCommand, create, select, t]
  )

  /** Select an item from the list: close, remember, run. */
  const runItem = useCallback(
    (item: GlobalSearchItem) => {
      log.info("global-search select", { id: item.id, kind: item.kind })
      // Result *kinds*, never the row's label or the query behind it.
      void trackEvent("app.search.activated", {
        kind: item.kind,
        actionType: item.action.type,
      })
      close()
      recordRecentItem(item)
      void runAction(item.action).catch((err) => {
        log.error("global-search action failed", err, { id: item.id })
        toast.error(err instanceof Error ? err.message : String(err))
      })
    },
    [close, runAction]
  )

  /** Re-run a stored recent item (its action was serialised). */
  const runStoredAction = useCallback(
    (action: { type: string } & Record<string, unknown>) => {
      close()
      if (action.type === "quick-action-ref") {
        const entry = getQuickAction(String(action.fullId))
        if (!entry) {
          toast.error(t("recents.unavailable"))
          return
        }
        void runAction({ type: "quick-action", entry })
        return
      }
      void runAction(action as unknown as GlobalSearchAction).catch((err) => {
        log.error("global-search recent action failed", err)
        toast.error(err instanceof Error ? err.message : String(err))
      })
    },
    [close, runAction, t]
  )

  return { runItem, runAction, runCommand, runStoredAction }
}
