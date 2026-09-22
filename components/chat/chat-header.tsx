"use client"

import { WebSessionStatus } from "@/components/shell/web-status"
import { useState } from "react"
import { createPortal } from "react-dom"
import { cn } from "@/lib/utils"
import {
  useTitleBarProjection,
  useTitleBarProjectionScope,
} from "@/components/shell/title-bar-outlets"
import { useTranslations } from "next-intl"
import { Columns2Icon, ExternalLinkIcon, PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react"
import { toast } from "sonner"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { ArtifactDockToggle } from "@/components/artifacts/artifact-dock-toggle"
import { useCharacter } from "@/lib/data-hooks/context"
import { avatarColor, avatarGlyph } from "@/lib/ui/avatar"
import { PlanModeTasksSheet } from "@/components/chat/plan-mode-tasks-sheet"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { SessionSummaryPopover } from "@/components/context-workbench/session-summary-popover"
import { SessionSettingsSheet } from "@/components/chat/session-settings-sheet"
import { BranchLineageChip } from "@/components/chat/branch-lineage-chip"
import { ImportedOriginChip } from "@/components/chat/imported-origin-chip"
import { BranchChildrenChip } from "@/components/chat/branch-children-chip"
import { MentionBacklinksChip } from "@/components/chat/mention-backlinks-chip"
import { sessionBacklinkTarget } from "@/lib/chat/mentions/backlinks"
import { dispatchSessionToCodexApp } from "@/lib/chat/dispatch-to-codex-app"
import { PlatformConversationHeader } from "@/components/inbox/platform-conversation-context"
import { PlatformBadge } from "@/components/inbox/platform-badge"
import { isTauri } from "@/lib/tauri"
import { useChatStore } from "@/stores/chat"
import { useUIStore } from "@/stores/ui"
import type { ChatSession } from "@cognia/agent-config-types"

/**
 * Every icon button on this row, one tone. The header sits on the title bar
 * (`title-bar-outlets.tsx`) beside the bar's own controls, which are drawn
 * `text-muted-foreground` and brighten on hover — a full-strength glyph among
 * them read as the odd one out (the sidebar and dock toggles were).
 */
const HEADER_ICON_BUTTON = "size-7 text-muted-foreground hover:text-foreground"

interface Props {
  session: ChatSession
  onSplitView?: () => void
  onExitSplit?: () => void
}

/**
 * One title-bar row. A floating action at the pane's top-right opens a
 * lightweight summary; environment, sharing and settings live there, keeping
 * the two pane toggles as the default header's only other controls. Contextual
 * lineage and plugin controls still appear when this conversation needs them.
 *
 * The summary mounts its data readers only when opened and never expands the
 * dock until the user follows a result or chooses View details. Runtime and
 * cost controls remain on the composer's status line.
 */
export function ChatHeader({ session, onSplitView, onExitSplit }: Props) {
  const t = useTranslations("chat.header")
  const tConcurrent = useTranslations("chat.concurrent")
  const character = useCharacter(session.characterId)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [codexDispatching, setCodexDispatching] = useState(false)

  const handleOpenInCodexApp = async () => {
    setCodexDispatching(true)
    try {
      await dispatchSessionToCodexApp(session)
      toast.success(t("openedInCodexApp"))
    } catch {
      toast.error(t("openInCodexAppFailed"))
    } finally {
      setCodexDispatching(false)
    }
  }

  const characterTooltip = character
    ? character.description
      ? `${character.name} · ${character.description}`
      : character.name
    : undefined

  // Inside the chat workspace this header renders into the title bar's centre
  // outlet (`title-bar-outlets.tsx`): the bar is the one 40px row above the
  // columns and the conversation title belongs on it. Anywhere else — the
  // mobile shell, a host outside the projection scope — it draws its own row.
  const outlet = useTitleBarProjection("center")
  // The `toolbar.*` plugin slots normally live in the title bar's zones. When
  // this header draws inline *inside the workspace scope* — the bar-less web
  // shell (`webTitleBarEnabled` off) — it is the column header that hosts them
  // instead. Outside the scope (inbox detail, Canvas sidechat, mobile Sheet)
  // the header is not the shell's chrome and stays plain.
  const inScope = useTitleBarProjectionScope()
  const hostsToolbarSlots = inScope && !outlet
  const activeSessionId = useChatStore((state) => state.activeSessionId)
  const ownsActions = !outlet || !activeSessionId || activeSessionId === session.id
  const actionsOutlet = useTitleBarProjection("actions", { active: ownsActions })
  const paneActions = (
    <>
      {onSplitView && (
        <Button
          variant="ghost"
          size="icon"
          className={HEADER_ICON_BUTTON}
          aria-label={tConcurrent("splitView")}
          onClick={onSplitView}
        >
          <Columns2Icon className="size-4" />
        </Button>
      )}

      {onExitSplit && (
        <Button
          variant="ghost"
          size="icon"
          className={HEADER_ICON_BUTTON}
          aria-label={tConcurrent("exitSplit")}
          onClick={onExitSplit}
        >
          <Columns2Icon className="size-4" />
        </Button>
      )}

      {/* The summary opener left the title bar. The workspace floats it at the
          pane's top-right (see `chat-surface-stage` in `chat-view.tsx`); only a
          host outside the projection scope — an embedded chat surface — still
          keeps it on this row. The card itself is unchanged either way. */}
      {inScope ? null : (
        <SessionSummaryPopover
          key={session.id}
          session={session}
          onManage={() => setSettingsOpen(true)}
        />
      )}
    </>
  )

  const content = (
    <>
      {/* Inline only. Projected, the bar keeps its own `primarySidebarToggle`
          and `secondarySidebarToggle` segments a few pixels to the right —
          those are on every route, so they own the two actions there and this
          row would only double them up. */}
      {outlet ? null : <ConversationListToggle />}

      {/* `toolbar.left` — the bar's start-zone slot. Inline it follows the
          list toggle, the row's own start chrome. */}
      {hostsToolbarSlots ? (
        <PluginExtensionSlot
          point="toolbar.left"
          className="flex items-center gap-1 empty:hidden"
        />
      ) : null}

      <div className="flex flex-1 items-center gap-2 truncate">
        {character && (
          <Avatar className="size-6 shrink-0" title={characterTooltip}>
            <AvatarFallback
              className="text-[10px] text-white"
              style={{ backgroundColor: avatarColor(character) }}
              aria-hidden
            >
              {avatarGlyph(character)}
            </AvatarFallback>
          </Avatar>
        )}
        {/* One line, not two. The character name and description were a second
            row of permanent text that repeated what the avatar already signals
            and pushed the header to 48px; they are the title's tooltip now. */}
        <span
          className="truncate text-sm font-medium"
          title={characterTooltip ? `${session.title} — ${characterTooltip}` : session.title}
        >
          {session.title || t("untitledSession")}
        </span>
        {session.platformBinding && (
          <PlatformBadge platform={session.platformBinding.platform} fullName />
        )}
        {/* Self-hides unless this session was branched from another one. */}
        <BranchLineageChip session={session} />
        {/* The reverse direction: self-hides unless this session HAS branches.
            Both can show at once on a branch that was itself branched. */}
        <BranchChildrenChip sessionId={session.id} />
        {/* Self-hides unless this conversation came from an external agent's
            on-disk history (ADR-0062). Also carries the "the source moved on"
            warning for a frozen import — the badge `lib/data/import-merge.ts`
            promised while nothing in the app read `importFrozen` at all. */}
        <ImportedOriginChip session={session} />
        {/* Self-hides unless another conversation has referenced this one with
            `@chat:`. The fourth provenance question in this row: where did this
            come from, what came out of it, and who else reached for it. */}
        <MentionBacklinksChip
          target={sessionBacklinkTarget(session.id)}
          excludeSessionId={session.id}
        />
      </div>

      {/* `toolbar.center` — in the bar it trails the centre outlet (this
          title); inline it keeps that same position. */}
      {hostsToolbarSlots ? (
        <PluginExtensionSlot
          point="toolbar.center"
          className="flex items-center gap-1 empty:hidden"
        />
      ) : null}

      {/* Plan-mode tasks for a non-team chat. Self-hides (returns null) when the
          synthetic `solo:<sessionId>` team has no tasks, so it only appears once
          the plan-mode bridge has emitted a plan for this session. */}
      <PlanModeTasksSheet sessionId={session.id} />

      <PluginExtensionSlot point="chat.header" className="flex items-center gap-1 empty:hidden" />

      {session.platformBinding && <PlatformConversationHeader session={session} />}

      {/* `toolbar.right` — in the bar it heads the right chrome, ahead of the
          end-zone items and the actions outlet (the summary controls below). */}
      {hostsToolbarSlots ? (
        <PluginExtensionSlot
          point="toolbar.right"
          className="flex items-center gap-1 empty:hidden"
        />
      ) : null}

      {isTauri() ? (
        <Button
          variant="ghost"
          size="icon"
          className={HEADER_ICON_BUTTON}
          aria-label={t("openInCodexApp")}
          title={t("openInCodexApp")}
          disabled={codexDispatching}
          onClick={() => void handleOpenInCodexApp()}
        >
          {codexDispatching ? (
            <Spinner className="size-4" />
          ) : (
            <ExternalLinkIcon className="size-4" />
          )}
        </Button>
      ) : null}

      {ownsActions
        ? actionsOutlet
          ? createPortal(paneActions, actionsOutlet)
          : paneActions
        : null}

      {/* Inline only, for the same reason as the conversation-list toggle
          above: the bar's `secondarySidebarToggle` drives the same dock.
          Pointer-width only — below `md` the dock is a Sheet whose opener lives
          in the mobile shell's own top bar, and this header is suppressed
          there anyway (`showHeader={false}`). */}
      {outlet ? null : (
        <ArtifactDockToggle className={cn(HEADER_ICON_BUTTON, "hidden md:inline-flex")} />
      )}

      <WebSessionStatus host="header" />

      {/* The settings sheet backs the inline summary opener above, so it mounts
          only on the same non-workspace surfaces; inside the scope the pane's
          own trigger (`chat-view.tsx`) hosts its sheet instead. */}
      {inScope ? null : (
        <SessionSettingsSheet
          session={session}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
        />
      )}
    </>
  )

  if (outlet) {
    return createPortal(
      <div data-testid="chat-header" className="flex h-full min-w-0 flex-1 items-center gap-2 px-2">
        {content}
      </div>,
      outlet
    )
  }

  return (
    <header
      data-testid="chat-header"
      // `h-10` is the shared column-header height: the conversation rail's
      // header (`channel-list.tsx`) and the right-hand workbench header
      // (`context-workbench.tsx`) draw the same 40px with the same bottom rule,
      // so the three columns read as one bar rather than three stepped ones.
      className="flex h-[var(--chrome-h)] shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur"
      // Opt the bar into the shared wallpaper-aware tonality system
      // (app/globals.css §5), same tier as the conversation rail. Without it
      // the hardcoded `bg-background/80` stayed an opaque slab while the
      // message area a pixel below showed the wallpaper — the seam this header
      // is supposed to sit flush against. `bg-background/80` remains the
      // no-wallpaper fallback; the tonality rules only fire under
      // `body[data-bg-enabled="true"]` and honour prefers-reduced-transparency.
      data-tonality="translucent"
    >
      {content}
    </header>
  )
}

/**
 * The conversation-list collapse toggle — the header's first control when it
 * draws its own row.
 *
 * Not rendered while the header is projected into the title bar: the bar keeps
 * its own `primarySidebarToggle` segment there and the two would sit a few
 * pixels apart driving the same `sidebarCollapsed` field. The bar's copy wins
 * because it is the one that is always present, on every route.
 */
function ConversationListToggle() {
  const tChannelList = useTranslations("desktop.channelList")
  const sidebarCollapsed = useUIStore((state) => state.sidebarCollapsed)
  const toggleSidebar = useUIStore((state) => state.toggleSidebar)

  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn(HEADER_ICON_BUTTON, "hidden shrink-0 md:inline-flex")}
      aria-label={tChannelList(sidebarCollapsed ? "expandSidebar" : "collapseSidebar")}
      aria-controls="conversation-sidebar"
      aria-expanded={!sidebarCollapsed}
      data-testid="chat-sidebar-toggle"
      onClick={toggleSidebar}
    >
      {sidebarCollapsed ? (
        <PanelLeftOpenIcon className="size-4" />
      ) : (
        <PanelLeftCloseIcon className="size-4" />
      )}
    </Button>
  )
}
