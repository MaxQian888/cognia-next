"use client"

/**
 * Main-window half of the selection toolbar.
 *
 * Three of the six actions are prompts and land in the composer with the window
 * raised. The other two run here *without* raising the window — stashing a note
 * or reading text aloud must not interrupt whatever the user is doing in
 * another app — and report back to the overlay, which stays on screen showing a
 * spinner, a ✓, a PII warning, or a player until they settle.
 *
 * The memory path in particular has to report: `storeExternalMemory` *returns*
 * `{ok: false, reason: "pii_blocked"}` rather than throwing, so a fire-and-
 * forget write would be a silent no-op whenever the main window is in the tray.
 */

import { useEffect, useRef } from "react"
import { emitTo, listen } from "@tauri-apps/api/event"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"

import { startNewSession } from "@/lib/chat/start-session"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"
import { storeExternalMemory } from "@/lib/memory/api/store-memory"
import {
  speakSelection,
  stopSelectionSpeech,
  watchSelectionSpeech,
} from "@/lib/tts/speak-selection"
import {
  SELECTION_RESULT_EVENT,
  SELECTION_SPEECH_EVENT,
  SELECTION_SPEECH_STOP_EVENT,
  SELECTION_STAGE_EVENT,
  SELECTION_TOOLBAR_LABEL,
  takePendingSelectionStage,
  type ExternalSelectionCandidate,
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
    case "remember":
    case "speak":
    // `launch` actions never reach the composer — Rust hands them to the
    // browser or the mail client and the toolbar leaves.
    case "openLink":
    case "composeEmail":
    case "searchWeb":
      return null
    case "explain":
      return t("prompts.explain")
    case "translate":
      return t("prompts.translate", {
        language: t(`languages.${action.targetLocale}` as never),
      })
    case "convertUnit":
      return t("prompts.convertUnit")
  }
}

async function reportResult(candidateId: string, ok: boolean, reason?: string): Promise<void> {
  await emitTo(SELECTION_TOOLBAR_LABEL, SELECTION_RESULT_EVENT, { candidateId, ok, reason })
}

async function rememberSelection(candidate: ExternalSelectionCandidate): Promise<void> {
  try {
    const result = await storeExternalMemory(
      {
        text: candidate.text,
        tags: ["selection", candidate.sourceApp].filter(Boolean),
        source: {},
      },
      { channel: "selection" }
    )
    await reportResult(candidate.id, result.ok, result.ok ? undefined : result.reason)
  } catch {
    await reportResult(candidate.id, false)
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
    const unlistens: Array<() => void | Promise<void>> = []
    // One playback subscription at a time — a second `speak` supersedes the
    // first, exactly as the single orchestrator does.
    let stopWatching: (() => void) | null = null

    const beginSpeaking = (candidate: ExternalSelectionCandidate) => {
      stopWatching?.()
      stopWatching = watchSelectionSpeech(candidate.id, (update) => {
        void emitTo(SELECTION_TOOLBAR_LABEL, SELECTION_SPEECH_EVENT, {
          candidateId: candidate.id,
          playing: update.playing,
          progress: update.progress,
        })
        if (!update.playing) {
          stopWatching?.()
          stopWatching = null
        }
      })
      void speakSelection({ candidateId: candidate.id, text: candidate.text }).catch(() => {
        void emitTo(SELECTION_TOOLBAR_LABEL, SELECTION_SPEECH_EVENT, {
          candidateId: candidate.id,
          playing: false,
        })
      })
    }

    const stageIntoComposer = async (payload: SelectionStagePayload) => {
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

    const consumePendingStage = async () => {
      const payload = await takePendingSelectionStage()
      if (!alive || !payload) return
      switch (payload.action.kind) {
        case "remember":
          await rememberSelection(payload.candidate)
          return
        case "speak":
          beginSpeaking(payload.candidate)
          return
        default:
          await stageIntoComposer(payload)
      }
    }

    void Promise.all([
      listen(SELECTION_STAGE_EVENT, () => {
        if (alive) void consumePendingStage()
      }).then((dispose) => {
        if (!alive) {
          safeUnlisten(dispose)
          return
        }
        unlistens.push(dispose)
        // Drain anything staged while this window was still booting.
        void consumePendingStage()
      }),
      listen<{ candidateId: string }>(SELECTION_SPEECH_STOP_EVENT, (event) => {
        if (alive) stopSelectionSpeech(event.payload.candidateId)
      }).then((dispose) => {
        if (alive) unlistens.push(dispose)
        else safeUnlisten(dispose)
      }),
    ])

    return () => {
      alive = false
      stopWatching?.()
      unlistens.forEach(safeUnlisten)
    }
  }, [router])

  return null
}

export default SelectionToolbarInitializer
