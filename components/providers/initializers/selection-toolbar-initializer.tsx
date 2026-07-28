"use client"

import { useEffect, useRef } from "react"
import { listen } from "@tauri-apps/api/event"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"

import { startNewSession } from "@/lib/chat/start-session"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"
import {
  SELECTION_STAGE_EVENT,
  takePendingSelectionStage,
  type SelectionStagePayload,
} from "@/lib/tauri/selection-toolbar"
import { useChatStore } from "@/stores/chat"
import { useComposerIntentStore } from "@/stores/chat/composer-intent-store"
import type { ExternalSelectionRef } from "@/types/artifact/artifact"

function promptForAction(
  action: SelectionStagePayload["action"],
  t: ReturnType<typeof useTranslations<"selectionToolbar">>
): string | null {
  switch (action.kind) {
    case "copy":
    case "ask":
      return null
    case "explain":
      return t("prompts.explain")
    case "translate":
      return t("prompts.translate", {
        language: t(`languages.${action.targetLocale}` as never),
      })
  }
}

export function SelectionToolbarInitializer() {
  const router = useRouter()
  const t = useTranslations("selectionToolbar")
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

  useEffect(() => {
    let alive = true
    let unlisten: (() => void | Promise<void>) | undefined
    const consumePendingStage = async () => {
      const payload = await takePendingSelectionStage()
      if (!alive || !payload) return
      const { candidate, action } = payload
      const current = useChatStore.getState().activeSessionId
      const sessionId = current ?? (await startNewSession()).id
      if (!alive) return

      const chat = useChatStore.getState()
      const alreadyStaged = chat.contextSelections.some(
        (selection) => selection.kind === "external" && selection.candidateId === candidate.id
      )
      if (!alreadyStaged) {
        const selection: ExternalSelectionRef = {
          kind: "external",
          candidateId: candidate.id,
          title: candidate.sourceTitle ?? candidate.sourceApp,
          snapshot: candidate.text,
          comment: "",
          sourceApp: candidate.sourceApp,
          sourceTitle: candidate.sourceTitle,
          origin: candidate.origin,
          truncated: candidate.truncated,
        }
        chat.addContextSelection(selection)
      }

      useComposerIntentStore.getState().stage(sessionId, {
        candidateId: candidate.id,
        prompt: promptForAction(action, tRef.current),
      })
      router.push("/")
    }
    void listen(SELECTION_STAGE_EVENT, () => {
      if (alive) void consumePendingStage()
    }).then((dispose) => {
      if (alive) unlisten = dispose
      else safeUnlisten(dispose)
      if (alive) void consumePendingStage()
    })
    return () => {
      alive = false
      safeUnlisten(unlisten)
    }
  }, [router])

  return null
}

export default SelectionToolbarInitializer
