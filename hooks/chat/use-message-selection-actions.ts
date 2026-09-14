"use client"

/**
 * What can be done with a passage of a conversation: reference it, or have it
 * summarized, explained or translated and reference the answer.
 *
 * Two surfaces offer this. On desktop the passage is text selected in the
 * transcript and the actions float over it (`message-selection-toolbar.tsx`);
 * on a phone a long press cannot select a word without opening the message's
 * sheet, so the passage is chosen in a sheet of its own
 * (`components/mobile/chat/message-text-selection-sheet.tsx`). Where the actions
 * appear differs; what they do must not, so both take them from here — the chip
 * a reference stages, the run that answers, the language a translation goes
 * into (one preference, shared with the desktop selection toolbar).
 */

import { useCallback, useEffect, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"
import { createLogger } from "@cognia/logging"

import {
  SELECTION_TRANSLATE_LOCALE_PREF,
  TARGET_LOCALES,
  initialTargetLocale,
  type TargetLocale,
} from "@/components/selection-toolbar/selection-toolbar-actions"
import {
  useSelectionActionRun,
  type SelectionRunRequest,
  type SelectionRunState,
} from "@/hooks/chat/use-selection-action-run"
import { buildMessageExcerptSelection } from "@/lib/chat/selection/message-excerpt"
import type { SelectionAction } from "@/lib/chat/selection/run-selection-action"
import { getPref, setPref } from "@/lib/tauri/store"
import type { EntityExcerptDerivation } from "@/types/artifact/artifact"
import { useChatStore } from "@/stores/chat/chat-store"

const log = createLogger("chat-selection")

/** The passage an action is about. */
export interface SelectionPassage {
  /** The words chosen. */
  text: string
  /** Every message they come from, in transcript order. */
  messageIds: readonly string[]
  /** Those messages' text, which an explanation reads around the passage. */
  context: string
}

const DERIVATIONS: Record<SelectionAction, EntityExcerptDerivation> = {
  summarize: "summary",
  explain: "explanation",
  translate: "translation",
}

export interface MessageSelectionActions {
  run: SelectionRunState
  /** Answer about `passage`. A translation goes into `locale`, or the chosen language. */
  start: (action: SelectionAction, passage: SelectionPassage, locale?: TargetLocale) => void
  retry: () => void
  stop: () => void
  close: () => void
  targetLocale: TargetLocale
  /** Remember a translation language, for this surface and the desktop toolbar. */
  chooseLocale: (next: string) => void
  /** The language's own name in the UI locale, or the tag when it is not one of ours. */
  languageLabel: (tag: string | undefined) => string | undefined
  /** Stage the passage itself as a chip. False when nothing was staged. */
  referencePassage: (passage: SelectionPassage) => Promise<boolean>
  /** Stage the current answer as a chip. False when nothing was staged. */
  referenceResult: (text: string) => Promise<boolean>
  /** An answer is being staged. */
  referencing: boolean
}

export function useMessageSelectionActions({
  sessionId,
}: {
  /** The conversation the passage is from: chips stage into its composer. */
  sessionId: string
}): MessageSelectionActions {
  const t = useTranslations("chat.selection")
  const tLanguage = useTranslations("selectionToolbar.languages")
  const locale = useLocale()
  const { state: run, run: begin, stop, close } = useSelectionActionRun()
  const [targetLocale, setTargetLocale] = useState<TargetLocale>(() => initialTargetLocale(locale))
  const [referencing, setReferencing] = useState(false)

  // The desktop selection toolbar's choice, so the surfaces agree. Outside Tauri
  // there is no store and the UI locale's default stands.
  useEffect(() => {
    let alive = true
    void getPref<string>(SELECTION_TRANSLATE_LOCALE_PREF).then((saved) => {
      if (alive && TARGET_LOCALES.includes(saved as TargetLocale)) {
        setTargetLocale(saved as TargetLocale)
      }
    })
    return () => {
      alive = false
    }
  }, [])

  const chooseLocale = useCallback((next: string) => {
    if (!TARGET_LOCALES.includes(next as TargetLocale)) return
    setTargetLocale(next as TargetLocale)
    void setPref(SELECTION_TRANSLATE_LOCALE_PREF, next)
  }, [])

  const languageLabel = useCallback(
    (tag: string | undefined) =>
      tag && TARGET_LOCALES.includes(tag as TargetLocale) ? tLanguage(tag as TargetLocale) : tag,
    [tLanguage]
  )

  const stage = useCallback(
    async (input: {
      messageIds: readonly string[]
      text: string
      quote: string
      derivation: EntityExcerptDerivation
      language?: string
    }): Promise<boolean> => {
      const selection = await buildMessageExcerptSelection({
        sessionId,
        messageIds: input.messageIds,
        text: input.text,
        excerpt: {
          derivation: input.derivation,
          quote: input.quote,
          ...(input.language ? { language: input.language } : {}),
        },
      })
      if (!selection) {
        toast.error(t("referenceError"))
        return false
      }
      useChatStore.getState().addContextSelection(selection, sessionId)
      toast.success(t("referenced", { title: selection.title }))
      return true
    },
    [sessionId, t]
  )

  const referencePassage = useCallback(
    async (passage: SelectionPassage): Promise<boolean> => {
      try {
        return await stage({
          messageIds: passage.messageIds,
          text: passage.text,
          quote: passage.text,
          derivation: "quote",
        })
      } catch (err) {
        log.error("selection-reference-failed", { sessionId, error: String(err) })
        toast.error(t("referenceError"))
        return false
      }
    },
    [sessionId, stage, t]
  )

  const start = useCallback(
    (action: SelectionAction, passage: SelectionPassage, chosen?: TargetLocale) => {
      const request: SelectionRunRequest = {
        action,
        quote: passage.text,
        sessionId,
        messageIds: passage.messageIds,
        context: passage.context,
        ...(action === "translate" ? { targetLocale: chosen ?? targetLocale } : {}),
      }
      void begin(request)
    },
    [begin, sessionId, targetLocale]
  )

  const retry = useCallback(() => {
    if (run.status !== "idle") void begin(run.request)
  }, [begin, run])

  const referenceResult = useCallback(
    async (text: string): Promise<boolean> => {
      if (run.status === "idle" || referencing) return false
      setReferencing(true)
      try {
        const { request } = run
        const staged = await stage({
          messageIds: request.messageIds,
          text,
          quote: request.quote,
          derivation: DERIVATIONS[request.action],
          ...(request.targetLocale ? { language: request.targetLocale } : {}),
        })
        if (staged) close()
        return staged
      } catch (err) {
        log.error("selection-result-reference-failed", { sessionId, error: String(err) })
        toast.error(t("referenceError"))
        return false
      } finally {
        setReferencing(false)
      }
    },
    [close, referencing, run, sessionId, stage, t]
  )

  return {
    run,
    start,
    retry,
    stop,
    close,
    targetLocale,
    chooseLocale,
    languageLabel,
    referencePassage,
    referenceResult,
    referencing,
  }
}
