"use client"

import { createContext, useContext, useEffect, useRef, type ReactNode } from "react"
import { createPortal } from "react-dom"
import {
  ListTodoIcon,
  UsersIcon,
  LayersIcon,
  BotIcon,
  LaptopIcon,
  FolderIcon,
  Settings2Icon,
  type LucideIcon,
} from "lucide-react"
import type { ChatSession } from "@cognia/agent-config-types"
import { useTranslations } from "next-intl"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { avatarColor, avatarGlyph } from "@/lib/ui/avatar"
import { cn } from "@/lib/utils"
import { useCharacter } from "@/lib/data-hooks/context"
import { useBreakpoint } from "@/hooks/ui"
import { Button } from "@/components/ui/button"
import { CompositionChip } from "@/components/agent/composition/composition-chip"
import { AgentRuntimeSelector } from "@/components/agent/mode/runtime-selector"
import { SessionEnvironmentChip } from "@/components/chat/session-environment-chip"
import { SharedSessionPanel } from "@/components/chat/shared-session-panel"
import { RoomParticipantsChip } from "@/components/chat/room-participants-chip"
import { useChatStore, useSessionMessages } from "@/stores/chat"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useEdgePanelTransition } from "@/hooks/shell/use-edge-panel-transition"
import { revealSessionPanel } from "@/lib/artifacts/reveal"
import { SHELL_DOCK_TIMING_CLASS } from "@/lib/ui/shell-dock-motion"
import { SessionCapabilitiesSection } from "./session-capabilities-section"
import { SessionResultsSection } from "./session-results-section"
import { SessionOpenItems } from "./session-open-items"
import { SessionStatusRail } from "./session-status-rail"
import { useSessionOverviewState } from "./session-overview-panel"

interface Props {
  session: ChatSession
  onManage: () => void
}

/** The desktop shell supplies the reserved region; other hosts use a Sheet. */
export const SessionSummaryDockContext = createContext<HTMLElement | null>(null)

/** The toolbar controls the existing shell's compact summary state. */
export function SessionSummaryPopover({ session, onManage }: Props) {
  const t = useTranslations("contextWorkbench.taskOverview")
  const host = useContext(SessionSummaryDockContext)
  const breakpoint = useBreakpoint()
  const open = useArtifactDockLayoutStore((state) => state.summarySessionId === session.id)
  const openSummary = useArtifactDockLayoutStore((state) => state.openSummary)
  const closeSummary = useArtifactDockLayoutStore((state) => state.closeSummary)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const desktop = breakpoint === "desktop" && host !== null
  // The host aside clips while its width animates back to zero, so the card
  // has to stay mounted for the length of that transition — unmounting on the
  // same commit left an empty column shrinking over ~300ms. Same clock and
  // token as the aside itself (`useEdgePanelTransition`), and only on the
  // desktop path: the Sheet fallback owns its own exit animation.
  const dockMoving = useEdgePanelTransition(open, { element: contentRef, enabled: desktop })
  const close = () => {
    closeSummary()
    triggerRef.current?.focus()
  }
  useEffect(() => {
    if (!open || !desktop) return
    contentRef.current?.focus()
    const escape = (event: KeyboardEvent) => {
      // Nested menus/dialogs handle Escape first; leave their dismissal alone.
      if (event.key !== "Escape" || event.defaultPrevented) return
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return
      closeSummary()
      triggerRef.current?.focus()
    }
    document.addEventListener("keydown", escape)
    return () => document.removeEventListener("keydown", escape)
  }, [open, desktop, closeSummary])
  const navigate = (panelId: string) => {
    closeSummary()
    revealSessionPanel(session.id, panelId)
  }
  const manage = () => {
    closeSummary()
    onManage()
  }
  const content = (
    <div
      ref={contentRef}
      tabIndex={-1}
      data-testid="session-summary-card"
      className={cn(
        "outline-none",
        desktop
          ? // The aside around this clips while it grows, so the card slides out
            // from the window edge on its own; only the fade is added here.
            `max-h-full w-full overflow-y-auto rounded-2xl border border-border/60 bg-popover p-2.5 shadow-lg animate-in fade-in-0 ${SHELL_DOCK_TIMING_CLASS}`
          : "h-full overflow-y-auto p-2.5"
      )}
    >
      <SessionSummaryContent session={session} onNavigate={navigate} onManage={manage} />
    </div>
  )
  return (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
        title={t("summaryTitle")}
        aria-label={t("summaryTitle")}
        aria-expanded={open}
        aria-controls={desktop ? "session-summary-dock" : undefined}
        onClick={() => {
          if (open) close()
          else {
            const chat = useChatStore.getState()
            if (chat.activeSessionId !== session.id) chat.setActiveSession(session.id)
            openSummary(session.id)
          }
        }}
      >
        <ListTodoIcon className="size-4" aria-hidden />
      </Button>
      {desktop ? (
        (open || dockMoving) && createPortal(content, host)
      ) : (
        <Sheet
          open={open}
          onOpenChange={(next) => {
            if (!next) close()
          }}
        >
          <SheetContent
            side="right"
            showCloseButton={false}
            className="w-[min(360px,100vw)] gap-0 p-0"
            aria-describedby={undefined}
          >
            <SheetTitle className="sr-only">{t("summaryTitle")}</SheetTitle>
            {content}
          </SheetContent>
        </Sheet>
      )}
    </>
  )
}

/**
 * One labelled control in the card's definition list.
 *
 * The label column used to be a hard `4.5rem`. At the dock aside's 320px, minus
 * its padding and the card's own, that left roughly 160px for the control —
 * enough to truncate every composition name and model id the card exists to
 * show. `max-content` sizes the column to the widest label across the whole
 * grid instead, so the labels still line up while the control keeps whatever is
 * left, and the value is pushed to the right edge where the eye can scan it.
 */
function SummaryRow({
  icon: Icon,
  label,
  accent,
  children,
}: {
  icon: LucideIcon
  label: string
  /** Icon tint. Colour is decorative here — the label always names the row. */
  accent?: string
  children: ReactNode
}) {
  return (
    <div className="grid min-h-6 grid-cols-[15px_minmax(0,max-content)_minmax(0,1fr)] items-center gap-x-2 text-xs">
      <Icon className={cn("size-3.5", accent ?? "text-muted-foreground")} aria-hidden />
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center justify-end gap-1 [&>button]:h-6 [&>button]:max-w-full [&>button]:px-1.5">
        {children}
      </dd>
    </div>
  )
}

function SessionSummaryContent({
  session,
  onNavigate,
  onManage,
}: {
  session: ChatSession
  onNavigate: (panelId: string) => void
  onManage: () => void
}) {
  const t = useTranslations("contextWorkbench.taskOverview")
  const { displayStatus, error, busy } = useSessionOverviewState(session.id)
  const messages = useSessionMessages(session.id)
  const character = useCharacter(session.characterId)
  const tSharing = useTranslations("chatCollaboration")
  return (
    <div className="space-y-2.5" data-testid="session-summary">
      {/* The card is portalled into a column of its own, several hundred pixels
          from the header that opened it, so it has to name its own subject. */}
      <div className="flex items-center gap-2">
        {character ? (
          <Avatar className="size-6 shrink-0" title={character.name}>
            <AvatarFallback
              className="text-[10px] text-white"
              style={{ backgroundColor: avatarColor(character) }}
              aria-hidden
            >
              {avatarGlyph(character)}
            </AvatarFallback>
          </Avatar>
        ) : null}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium" title={session.title || undefined}>
            {session.title || t("untitled")}
          </h2>
          {character ? (
            <p className="truncate text-[11px] text-muted-foreground">{character.name}</p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={t("manage")}
          onClick={onManage}
        >
          <Settings2Icon className="size-3.5" aria-hidden />
        </Button>
      </div>

      <SessionStatusRail displayStatus={displayStatus} error={error} />

      <dl className="space-y-0.5">
        {session.kind !== "workflow-editor" && (
          <>
            <SummaryRow icon={LayersIcon} label={t("rows.mode")} accent="text-info">
              <CompositionChip sessionId={session.id} disabled={busy} />
            </SummaryRow>
            <SummaryRow icon={BotIcon} label={t("rows.runtime")} accent="text-info">
              <AgentRuntimeSelector
                sessionId={session.id}
                providerId={session.providerOverride}
                disabled={busy}
              />
            </SummaryRow>
          </>
        )}
        <SummaryRow icon={LaptopIcon} label={t("rows.environment")} accent="text-success">
          <SessionEnvironmentChip executionContext={session.executionContext} onManage={onManage} />
        </SummaryRow>
        {!session.executionContext && session.workingDir ? (
          <SummaryRow icon={FolderIcon} label={t("rows.directory")} accent="text-success">
            <span className="truncate" title={session.workingDir}>
              {session.workingDir}
            </span>
          </SummaryRow>
        ) : null}
        <SummaryRow icon={UsersIcon} label={t("rows.sharing")} accent="text-warning">
          <RoomParticipantsChip session={session} />
          <span>{tSharing(session.collaboration ? "shared" : "private")}</span>
          <SharedSessionPanel session={session} />
        </SummaryRow>
      </dl>

      <SessionOpenItems
        entries={session.workingSet?.entries ?? []}
        onNavigate={onNavigate}
        compact
        className="border-t pt-2.5"
      />
      <SessionCapabilitiesSection session={session} onManage={onManage} compact />
      <SessionResultsSection
        session={session}
        messages={messages}
        onNavigate={onNavigate}
        compact
      />
      <Button
        variant="outline"
        size="sm"
        className="h-7 w-full text-xs"
        onClick={() => onNavigate("metadata")}
      >
        {t("viewDetails")}
      </Button>
    </div>
  )
}
