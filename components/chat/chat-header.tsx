"use client"

import { useMemo, useState } from "react"
import { createPortal } from "react-dom"
import { useTitleBarProjection } from "@/components/shell/title-bar-outlets"
import { useTranslations } from "next-intl"
import {
  Columns2Icon,
  ExternalLinkIcon,
  KeyRoundIcon,
  Loader2Icon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  Settings2Icon,
} from "lucide-react"
import { toast } from "sonner"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { ArtifactDockToggle } from "@/components/artifacts/artifact-dock-toggle"
import { Badge } from "@/components/ui/badge"
import {
  useCharacter,
  usePresets,
  useRecordPresetUsage,
  useUpdateSession,
} from "@/lib/data-hooks/context"
import { ChatHeaderPresetPill } from "@/components/chat/chat-header-preset-pill"
import { buildPresetApplicationPlan, detectPresetConflicts } from "@/lib/presets/apply-to-session"
import { loggers } from "@cognia/logging"
import type { SystemPromptPreset } from "@cognia/agent-config-types"
import { avatarColor, avatarGlyph } from "@/lib/ui/avatar"
import { useCredentialStatus } from "@/hooks/chat/use-credential-status"
import { SessionCostBadgeLive } from "@/components/chat/session-cost-badge-live"
import { PlanModeTasksSheet } from "@/components/agent/workspace/plan-mode-tasks-sheet"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { SessionSettingsSheet } from "@/components/chat/session-settings-sheet"
import { BranchLineageChip } from "@/components/chat/branch-lineage-chip"
import { BranchChildrenChip } from "@/components/chat/branch-children-chip"
import { dispatchSessionToCodexApp } from "@/lib/chat/dispatch-to-codex-app"
import { isTauri } from "@/lib/tauri"
import { useUIStore } from "@/stores/ui"
import type { ChatSession } from "@cognia/agent-config-types"

interface Props {
  session: ChatSession
  onOpenSettings?: () => void
  onSplitView?: () => void
  onExitSplit?: () => void
}

/**
 * Chat header — one 36px line: who you are talking to, what it is costing, and
 * two controls.
 *
 * It carried six icon buttons and a two-line title. Everything that was not
 * touched per turn moved to where it belongs: the browser-dock opener into the
 * artifact dock's own menu, the agent-flow density switch to the settings sheet
 * that already had a copy of it, and Insights to a row in the same sheet. The
 * conversation-list toggle stays first so it remains reachable after collapse.
 *
 * What stays is either ambient status that self-hides (live cost, plan-mode
 * tasks, the no-credential badge, the `chat.header` plugin slot) or the single
 * owner of a frequent action: session settings and the two pane toggles.
 */
export function ChatHeader({ session, onOpenSettings, onSplitView, onExitSplit }: Props) {
  const t = useTranslations("chat.header")
  const tConcurrent = useTranslations("chat.concurrent")
  const tChannelList = useTranslations("desktop.channelList")
  const character = useCharacter(session.characterId)
  const sidebarCollapsed = useUIStore((state) => state.sidebarCollapsed)
  const toggleSidebar = useUIStore((state) => state.toggleSidebar)
  // Reactive credential status (api key OR subscription bearer). Re-reads on
  // profile unlock and subscription-changed broadcasts, so the badge never
  // latches a stale "No API key" for a subscription-reuse user whose bearer
  // lands after boot.
  const { keyOk } = useCredentialStatus()
  const [settingsOpen, setSettingsOpen] = useState(false)
  // ADR-0127: the system-prompt preset pill was built for this header and
  // never mounted. It self-hides without presets. A conflict-free pick applies
  // in place (fill-empty); a pick that would overwrite session values opens
  // the settings sheet, which owns the conflict-resolution dialog.
  const presetsRaw = usePresets()
  const presets = useMemo(() => presetsRaw ?? [], [presetsRaw])
  const updateSession = useUpdateSession()
  const recordPresetUsage = useRecordPresetUsage()
  const handleSelectPreset = (preset: SystemPromptPreset) => {
    const conflicts = detectPresetConflicts(preset, session)
    if (conflicts.length > 0) {
      setSettingsOpen(true)
      return
    }
    const plan = buildPresetApplicationPlan(preset, session, "fill-empty")
    void updateSession(session.id, { ...plan.sessionPatch, activePresetId: preset.id }).catch(
      (err: unknown) => {
        loggers.chat.error("preset pill apply failed", err, {
          sessionId: session.id,
          presetId: preset.id,
        })
      }
    )
    void recordPresetUsage(preset.id).catch((err: unknown) => {
      loggers.chat.warn("recordPresetUsage failed", {
        presetId: preset.id,
        err: err instanceof Error ? err.message : String(err),
      })
    })
  }
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

  const content = (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="hidden size-7 shrink-0 md:inline-flex"
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
        {/* Self-hides unless this session was branched from another one. */}
        <BranchLineageChip session={session} />
        {/* The reverse direction: self-hides unless this session HAS branches.
            Both can show at once on a branch that was itself branched. */}
        <BranchChildrenChip sessionId={session.id} />
        {keyOk === false && (
          <Badge variant="destructive" className="cursor-pointer gap-1" onClick={onOpenSettings}>
            <KeyRoundIcon className="size-3" />
            {t("noApiKey")}
          </Badge>
        )}
      </div>

      <SessionCostBadgeLive
        sessionId={session.id}
        {presets.length > 0 && (
          <ChatHeaderPresetPill
            session={session}
            presets={presets}
            onSelectPreset={handleSelectPreset}
          />
        )}
        tokensLabel={(input, output) => t("tokensLabel", { input, output })}
      />

      {/* Plan-mode tasks for a non-team chat. Self-hides (returns null) when the
          synthetic `solo:<sessionId>` team has no tasks, so it only appears once
          the plan-mode bridge has emitted a plan for this session. */}
      <PlanModeTasksSheet sessionId={session.id} />

      <PluginExtensionSlot point="chat.header" className="flex items-center gap-1 empty:hidden" />

      {isTauri() ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={t("openInCodexApp")}
          title={t("openInCodexApp")}
          disabled={codexDispatching}
          onClick={() => void handleOpenInCodexApp()}
        >
          {codexDispatching ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <ExternalLinkIcon className="size-4" />
          )}
        </Button>
      ) : null}

      {onSplitView && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
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
          className="size-7"
          aria-label={tConcurrent("exitSplit")}
          onClick={onExitSplit}
        >
          <Columns2Icon className="size-4" />
        </Button>
      )}

      {/* Persistent end controls. The browser-dock opener moved into the
          artifact dock's own menu, the agent-flow density switch already had a
          copy in the settings sheet and the appearance settings, and Insights
          became a row inside the sheet — none of the three is touched per turn.
          What is left is the one place to configure this session and the one
          toggle for the pane beside it. */}
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label={t("ariaSettings")}
        onClick={() => setSettingsOpen(true)}
      >
        <Settings2Icon className="size-4" />
      </Button>

      {/* Pointer-width only: below `md` the dock is a Sheet whose opener lives
          in the mobile shell's own top bar, and this header is suppressed
          there anyway (`showHeader={false}`). */}
      <ArtifactDockToggle className="hidden md:inline-flex" />

      <SessionSettingsSheet session={session} open={settingsOpen} onOpenChange={setSettingsOpen} />
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
      className="flex h-10 shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur"
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
