"use client"

/**
 * Choose part of one message on a phone, and act on it.
 *
 * On desktop a passage is selected where it sits and the selection capsule
 * floats over it. On a phone the same press that would select a word opens the
 * message's action sheet, so rows in the transcript select no text at all; this
 * sheet, reached from that action sheet's "Select text", is where a passage is
 * chosen instead. It lays the message's words out as plain selectable text —
 * the system's own handles and magnifier do the choosing — with the capsule's
 * actions floating at its foot.
 *
 * With nothing selected the actions take the whole message, and the bar says
 * so: summarizing or translating one reply is the common case on a small
 * screen, and making someone drag handles to the end first would be busywork.
 *
 * No "Ask in an aside": the aside lives in the desktop workbench dock, which the
 * phone shell does not have.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { motion } from "motion/react"
import { toast } from "sonner"
import type { UIMessage } from "ai"
import { LanguagesIcon, QuoteIcon, ScrollTextIcon, SparklesIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Surface } from "@/components/surface/surface"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHandle,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  FLOATING_BAR_BUTTON_CLASS,
  FLOATING_BAR_CLASS,
  FloatingBarAction,
} from "@/components/chat/floating-action-bar"
import { MessageSelectionResultPanel } from "@/components/chat/message-selection-result-panel"
import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import {
  TARGET_LOCALES,
  type TargetLocale,
} from "@/components/selection-toolbar/selection-toolbar-actions"
import {
  useMessageSelectionActions,
  type SelectionPassage,
} from "@/hooks/chat/use-message-selection-actions"
import { useBackDismiss } from "@/hooks/ui/use-back-dismiss"
import { selectionFeedback } from "@/lib/capacitor/haptics"
import { typedPromptOf } from "@/lib/chat/mentions/prompt-reference"
import { buildMessageSetReference } from "@/lib/chat/selection/message-set-reference"
import { isDeliberateSelection, selectionTitleFor } from "@/lib/chat/selection/selection-text"
import type { SelectionAction } from "@/lib/chat/selection/run-selection-action"
import { MOBILE_SPRING } from "@/lib/ui/motion"
import { cn } from "@/lib/utils"
import { useChatStore } from "@/stores/chat/chat-store"

export interface MessageTextSelectionSheetProps {
  /** The message to select from, or null when the sheet is closed. */
  message: UIMessage | null
  /** The conversation it belongs to: references stage into its composer. */
  sessionId: string | null
  onOpenChange: (open: boolean) => void
}

export function MessageTextSelectionSheet({
  message,
  sessionId,
  onOpenChange,
}: MessageTextSelectionSheetProps) {
  const t = useTranslations("mobile.messageTextSelection")
  const open = Boolean(message && sessionId)
  useBackDismiss(open, () => onOpenChange(false))

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      // Dragging across the text selects it. Anywhere-drag would pull the sheet
      // down instead, so only the handle moves it.
      handleOnly
    >
      <DrawerContent
        showHandle={false}
        className="data-[vaul-drawer-direction=bottom]:max-h-[88dvh]"
        data-testid="message-text-selection-sheet"
      >
        <DrawerHandle />
        <DrawerHeader className="pb-2 text-left group-data-[vaul-drawer-direction=bottom]/drawer-content:text-left">
          <DrawerTitle>{t("title")}</DrawerTitle>
          <DrawerDescription>{t("description")}</DrawerDescription>
        </DrawerHeader>
        {message && sessionId ? (
          // Keyed: a different message starts with no selection and no answer.
          <SelectionBody
            key={message.id}
            message={message}
            sessionId={sessionId}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DrawerContent>
    </Drawer>
  )
}

function SelectionBody({
  message,
  sessionId,
  onDone,
}: {
  message: UIMessage
  sessionId: string
  onDone: () => void
}) {
  const t = useTranslations("mobile.messageTextSelection")
  const tSelection = useTranslations("chat.selection")
  const tLanguage = useTranslations("selectionToolbar.languages")
  const { reduce } = useFlowMotion()
  // The words, without the context envelope a sent turn may carry in front of
  // them: that is the app's framing, not something anyone wrote.
  const text = useMemo(() => typedPromptOf(message.parts).text, [message.parts])
  const textRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const { selected, forget } = useSelectionWithin(textRef, barRef)
  const actions = useMessageSelectionActions({ sessionId })
  const [runScope, setRunScope] = useState<"selection" | "message">("selection")
  const [busy, setBusy] = useState(false)

  const passage: SelectionPassage = useMemo(
    () => ({ text: selected ?? text, messageIds: [message.id], context: text }),
    [message.id, selected, text]
  )

  const onReference = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      let staged = false
      if (selected) {
        staged = await actions.referencePassage(passage)
      } else {
        // The whole message is an ordinary message reference — the same chip
        // `@msg:` stages — not an excerpt that happens to be all of it.
        const reference = await buildMessageSetReference({ sessionId, messageIds: [message.id] })
        if (reference) {
          useChatStore.getState().addContextSelection(reference, sessionId)
          toast.success(tSelection("referenced", { title: reference.title }))
          staged = true
        } else {
          toast.error(tSelection("referenceError"))
        }
      }
      if (staged) {
        void selectionFeedback()
        forget()
        onDone()
      }
    } catch {
      toast.error(tSelection("referenceError"))
    } finally {
      setBusy(false)
    }
  }, [actions, busy, forget, message.id, onDone, passage, selected, sessionId, tSelection])

  const onRun = useCallback(
    (action: SelectionAction, locale?: TargetLocale) => {
      void selectionFeedback()
      setRunScope(selected ? "selection" : "message")
      actions.start(action, passage, locale)
    },
    [actions, passage, selected]
  )

  const onReferenceResult = useCallback(
    async (answer: string) => {
      if (await actions.referenceResult(answer)) {
        forget()
        onDone()
      }
    },
    [actions, forget, onDone]
  )

  const { run } = actions

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={textRef}
        // The one part of the page that selects: the rest of the app turns it off
        // for touch, and vaul must not read a drag here as a dismissal.
        data-vaul-no-drag=""
        className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 text-[15px] leading-relaxed break-words whitespace-pre-wrap select-text [-webkit-touch-callout:default]"
        data-testid="message-text-selection-text"
      >
        {text}
      </div>

      <div
        ref={barRef}
        className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        data-testid="message-text-selection-foot"
      >
        {run.status !== "idle" ? (
          <Surface layer="overlay" radius="panel" elevation={3} asChild>
            <motion.div
              className="border p-3 text-popover-foreground"
              initial={reduce ? false : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={MOBILE_SPRING}
            >
            <MessageSelectionResultPanel
              className="w-full max-h-[45dvh]"
              run={run}
              languageLabel={actions.languageLabel(run.request.targetLocale)}
              sourceLabel={runScope === "message" ? t("sourceMessage") : undefined}
              onStop={actions.stop}
              onRetry={actions.retry}
              onClose={actions.close}
              onReference={(answer) => void onReferenceResult(answer)}
              referencing={actions.referencing}
            />
            </motion.div>
          </Surface>
        ) : (
          <motion.div
            role="toolbar"
            aria-label={tSelection("toolbarLabel")}
            data-elevation="3"
            className={cn("flex flex-col gap-1 rounded-panel p-1.5", FLOATING_BAR_CLASS)}
            initial={reduce ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={MOBILE_SPRING}
          >
            <div className="flex min-h-9 items-center gap-1 px-2 text-xs">
              <span
                className="min-w-0 flex-1 truncate text-background/80"
                aria-live="polite"
                data-testid="message-text-selection-scope"
              >
                {selected
                  ? t("scopeSelection", { title: selectionTitleFor(selected) })
                  : t("scopeMessage")}
              </span>
              {selected ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={cn(FLOATING_BAR_BUTTON_CLASS, "h-8 shrink-0 gap-1 rounded-pill px-2.5 text-xs")}
                  onClick={forget}
                  data-testid="message-text-selection-clear"
                >
                  <XIcon className="size-3.5" aria-hidden />
                  {t("useWholeMessage")}
                </Button>
              ) : null}
            </div>
            <div className="grid grid-cols-4 gap-0.5">
              <FloatingBarAction
                label={tSelection("reference")}
                icon={QuoteIcon}
                disabled={busy || !text}
                onClick={() => void onReference()}
                data-testid="message-text-selection-reference"
              />
              <FloatingBarAction
                label={tSelection("summarize")}
                icon={ScrollTextIcon}
                disabled={!text}
                onClick={() => onRun("summarize")}
                data-testid="message-text-selection-summarize"
              />
              <FloatingBarAction
                label={tSelection("explain")}
                icon={SparklesIcon}
                disabled={!text}
                onClick={() => onRun("explain")}
                data-testid="message-text-selection-explain"
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <FloatingBarAction
                    label={tSelection("translate")}
                    icon={LanguagesIcon}
                    disabled={!text}
                    data-testid="message-text-selection-translate"
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="top"
                  align="end"
                  // Focus returning to the trigger would collapse a selection
                  // the menu was opened to translate.
                  onCloseAutoFocus={(event) => event.preventDefault()}
                >
                  <DropdownMenuLabel className="text-xs">{t("translateInto")}</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={actions.targetLocale}
                    onValueChange={(next) => {
                      actions.chooseLocale(next)
                      if (TARGET_LOCALES.includes(next as TargetLocale)) {
                        onRun("translate", next as TargetLocale)
                      }
                    }}
                  >
                    {TARGET_LOCALES.map((tag) => (
                      <DropdownMenuRadioItem key={tag} value={tag} className="min-h-10">
                        {tLanguage(tag)}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </motion.div>
        )}
      </div>
    </div>
  )
}

/** How long after a press on the bar a collapsing selection is taken as caused by it. */
const BAR_PRESS_GRACE_MS = 800

/**
 * The deliberate selection inside `containerRef`, held across a press on the
 * bar.
 *
 * Touching a button collapses the system selection on both iOS and Android
 * before the button's click arrives, so reading the selection at click time
 * finds nothing and the action would silently take the whole message. A
 * collapse that follows a press on `barRef` therefore keeps the last passage;
 * any other collapse — a tap in the text, a new drag — lets it go.
 */
export function useSelectionWithin(
  containerRef: React.RefObject<HTMLElement | null>,
  barRef: React.RefObject<HTMLElement | null>
): { selected: string | null; forget: () => void } {
  const [selected, setSelected] = useState<string | null>(null)
  const barPressedAt = useRef(0)

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (barRef.current?.contains(event.target as Node)) barPressedAt.current = Date.now()
    }
    const read = () => {
      const container = containerRef.current
      const selection = document.getSelection()
      const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
      const inside =
        container && range && !selection!.isCollapsed
          ? container.contains(range.commonAncestorContainer)
          : false
      if (!inside) {
        if (Date.now() - barPressedAt.current < BAR_PRESS_GRACE_MS) return
        setSelected(null)
        return
      }
      const value = selection!.toString().trim()
      setSelected(isDeliberateSelection(value) ? value : null)
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    document.addEventListener("selectionchange", read)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true)
      document.removeEventListener("selectionchange", read)
    }
  }, [barRef, containerRef])

  const forget = useCallback(() => {
    barPressedAt.current = 0
    const selection = document.getSelection()
    const container = containerRef.current
    if (
      selection &&
      selection.rangeCount > 0 &&
      container?.contains(selection.getRangeAt(0).commonAncestorContainer)
    ) {
      selection.removeAllRanges()
    }
    setSelected(null)
  }, [containerRef])

  return { selected, forget }
}
