"use client"

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { ListTodoIcon } from "lucide-react"
import { create } from "zustand"
import type { ChatSession } from "@cognia/agent-config-types"

import {
  SessionSettingsSheet,
  type SessionSettingsSectionId,
} from "@/components/chat/session-settings-sheet"
import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { useSessionNeedsYou } from "@/hooks/chat/use-session-needs-you"
import { useAppShortcut } from "@/hooks/shortcuts/use-app-shortcut"
import { useElementAxisSize } from "@/hooks/use-element-axis-size"
import { cn } from "@/lib/utils"
import { useChatStore } from "@/stores/chat"

import { SessionSummaryCard } from "./session-summary-card"
import {
  CHAT_COLUMN_MAX_REM,
  SUMMARY_CARD_MARGIN_PX,
  SUMMARY_CARD_WIDTH_PX,
  summaryCardPlacement,
  type SummaryCardPlacement,
} from "./summary-card-placement"

/**
 * Runtime state the summary button (title bar or header row) and the stage
 * host (on the chat pane) share for one conversation.
 *
 * - `placement`: what the stage host measured. A conversation with no stage
 *   host on screen (an embedded chat surface) has none, and its button falls
 *   back to the popover.
 * - `hidden`: floating cards the user put away. Runtime-only on purpose:
 *   hiding is "not now", and a restart showing the card again is the safe
 *   default — the per-row visibility *preference* is what persists
 *   (`settings.sessionSummaryCard`).
 */
interface SummaryCardRuntimeState {
  placement: Record<string, SummaryCardPlacement>
  hidden: Record<string, true>
  setPlacement: (sessionId: string, placement: SummaryCardPlacement | null) => void
  setHidden: (sessionId: string, hidden: boolean) => void
}

export const useSummaryCardRuntime = create<SummaryCardRuntimeState>()((set) => ({
  placement: {},
  hidden: {},
  setPlacement: (sessionId, placement) =>
    set((state) => {
      const current = state.placement[sessionId]
      if (!placement) {
        if (!current) return state
        const next = { ...state.placement }
        delete next[sessionId]
        return { placement: next }
      }
      if (current && current.mode === placement.mode && current.width === placement.width) {
        return state
      }
      return { placement: { ...state.placement, [sessionId]: placement } }
    }),
  setHidden: (sessionId, hidden) =>
    set((state) => {
      if (hidden === Boolean(state.hidden[sessionId])) return state
      const next = { ...state.hidden }
      if (hidden) next[sessionId] = true
      else delete next[sessionId]
      return { hidden: next }
    }),
}))

const POPOVER_PLACEMENT: SummaryCardPlacement = { mode: "popover", width: SUMMARY_CARD_WIDTH_PX }

function remPx(): number {
  if (typeof document === "undefined") return 16
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
}

/** Session settings sheet state, opened whole or at one section. */
function useSettingsSheet() {
  const [state, setState] = useState<{ open: boolean; focus?: SessionSettingsSectionId }>({
    open: false,
  })
  return {
    state,
    openWhole: () => setState({ open: true }),
    openSources: () => setState({ open: true, focus: "power" }),
    onOpenChange: (open: boolean) => setState((current) => ({ ...current, open })),
  }
}

function SettingsSheetFor({
  session,
  sheet,
}: {
  session: ChatSession
  sheet: ReturnType<typeof useSettingsSheet>
}) {
  if (!sheet.state.open) return null
  return (
    <SessionSettingsSheet
      session={session}
      open={sheet.state.open}
      focusSection={sheet.state.focus}
      onOpenChange={sheet.onOpenChange}
    />
  )
}

export interface SessionSummaryButtonProps {
  session: ChatSession
  className?: string
}

/**
 * The summary card's opener.
 *
 * In the chat workspace it sits in the title bar's actions slot, beside the
 * layout toggles (`ChatHeader` projects it for the focused pane only); an
 * embedded chat surface draws it on its own header row. When the stage host
 * reports that the card floats beside the conversation, the button shows and
 * hides that card; otherwise it opens the card as a popover under itself.
 */
export function SessionSummaryButton({ session, className }: SessionSummaryButtonProps) {
  const t = useTranslations("contextWorkbench.summaryCard")
  const placement = useSummaryCardRuntime(
    (state) => state.placement[session.id] ?? POPOVER_PLACEMENT
  )
  const hidden = useSummaryCardRuntime((state) => Boolean(state.hidden[session.id]))
  const setHidden = useSummaryCardRuntime((state) => state.setHidden)
  const [popoverOpen, setPopoverOpen] = useState(false)
  const sheet = useSettingsSheet()
  const { items } = useSessionNeedsYou(session.id)
  const isActive = useChatStore((state) => state.activeSessionId === session.id)

  const floating = placement.mode === "float"
  const cardVisible = floating ? !hidden : popoverOpen

  const toggle = useCallback(() => {
    if (floating) setHidden(session.id, !hidden)
    else setPopoverOpen((open) => !open)
  }, [floating, hidden, session.id, setHidden])

  // Split panes and embedded hosts can each render one; only the focused
  // conversation's answers the shortcut.
  useAppShortcut("chat.summaryToggle", toggle, { enabled: isActive, preventDefault: true })

  const label =
    items.length > 0 && !cardVisible ? t("triggerPending", { count: items.length }) : t("trigger")

  return (
    <>
      <Popover open={!floating && popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverAnchor asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              "relative size-7 shrink-0 text-muted-foreground hover:text-foreground",
              cardVisible && "bg-accent text-foreground",
              className
            )}
            aria-label={label}
            title={label}
            aria-expanded={cardVisible}
            data-testid="session-summary-trigger"
            onClick={toggle}
          >
            <ListTodoIcon className="size-4" aria-hidden />
            {items.length > 0 && !cardVisible ? (
              <span
                className="absolute right-1 top-1 size-1.5 rounded-full bg-warning ring-2 ring-background"
                aria-hidden
              />
            ) : null}
          </Button>
        </PopoverAnchor>
        <PopoverContent
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="w-auto border-0 bg-transparent p-0 shadow-none"
          aria-label={t("trigger")}
        >
          <SessionSummaryCard
            session={session}
            width={placement.width}
            mode="popover"
            maxHeight="var(--radix-popover-content-available-height)"
            onNavigated={() => setPopoverOpen(false)}
            onManage={() => {
              setPopoverOpen(false)
              sheet.openWhole()
            }}
            onManageSources={() => {
              setPopoverOpen(false)
              sheet.openSources()
            }}
          />
        </PopoverContent>
      </Popover>
      <SettingsSheetFor session={session} sheet={sheet} />
    </>
  )
}

/** The chat pane's surface, which the floating card lives on. */
export const CHAT_SURFACE_STAGE_SELECTOR = '[data-slot="chat-surface-stage"]'

/**
 * Where the floating card's top edge sits inside the stage: its `top-3` inset.
 * The stage begins under any banner (restricted mode, archive), so the card
 * never covers one.
 */
const FLOAT_TOP_OFFSET_PX = 12

/**
 * Mounted inside a chat pane's stage: measures it, tells the button whether the
 * card floats, and draws the floating card at the stage's top-right — right
 * under the title bar's button, in the gutter beside the centred chat column.
 * Each split pane has one, so each summarises its own conversation.
 */
export function SessionSummaryStageHost({ session }: { session: ChatSession }) {
  const [stage, setStage] = useState<HTMLElement | null>(null)
  const stageWidth = useElementAxisSize(stage, "width")
  const stageHeight = useElementAxisSize(stage, "height")
  const placement = summaryCardPlacement(stageWidth, CHAT_COLUMN_MAX_REM * remPx())
  const hidden = useSummaryCardRuntime((state) => Boolean(state.hidden[session.id]))
  const setHidden = useSummaryCardRuntime((state) => state.setHidden)
  const setPlacement = useSummaryCardRuntime((state) => state.setPlacement)
  const sheet = useSettingsSheet()

  // Publish only a measured stage, and withdraw it on unmount so a button left
  // behind (the pane closed) falls back to the popover.
  const measured = stageWidth > 0
  const { mode, width } = placement
  useEffect(() => {
    setPlacement(session.id, measured ? { mode, width } : null)
  }, [measured, mode, width, session.id, setPlacement])
  useEffect(() => () => setPlacement(session.id, null), [session.id, setPlacement])

  const bindStage = useCallback((element: HTMLDivElement | null) => {
    setStage(element?.closest<HTMLElement>(CHAT_SURFACE_STAGE_SELECTOR) ?? null)
  }, [])

  return (
    <div ref={bindStage} className="contents" data-testid="session-summary-stage-host">
      {placement.mode === "float" && !hidden ? (
        <div className="absolute right-3 top-3 z-20 animate-in fade-in-0 slide-in-from-top-1 sm:right-4">
          <SessionSummaryCard
            session={session}
            width={placement.width}
            mode="float"
            maxHeight={Math.max(0, stageHeight - FLOAT_TOP_OFFSET_PX - SUMMARY_CARD_MARGIN_PX)}
            onNavigated={() => {}}
            onManage={sheet.openWhole}
            onManageSources={sheet.openSources}
            onHide={() => setHidden(session.id, true)}
          />
        </div>
      ) : null}
      <SettingsSheetFor session={session} sheet={sheet} />
    </div>
  )
}
