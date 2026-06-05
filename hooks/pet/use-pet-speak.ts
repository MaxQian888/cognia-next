// The pet's LLM speak wiring — the counterpart of `usePetBubbles` for the
// `talked` interaction. Mounted ONLY in the main window (alongside the
// controller); overlay talk arrives here via the cross-window bridge replay.
//
// Ownership: this hook owns EVERY `talked` bubble. When LLM speak is enabled
// (PetSettings.llmSpeak, opt-in) and the user typed text, it runs the
// PII-gated `speakAsPet` side channel through `buildUtilityLlmClient`
// (rate-limited, in-flight-guarded); on any degradation — disabled, no text,
// rate-limited, no client, PII trip, model error — it falls back to a template
// acknowledgement so talk never feels dead. `usePetBubbles` stays silent for
// `talked` (the kind is absent from its VARIANTS table), so no double bubble.
//
// Prompt layers: live nurture state, rolling history (when pet memory is on),
// read-only recall from lib/memory, the inline [tag] emotion protocol, and the
// user's UI language. Replies are tag-parsed — the emotion plays as a one-shot
// and the clean text persists to `petConversation` (talk path ONLY; proactive
// speech is skip-memory by design).

"use client"

import { useEffect, useRef } from "react"
import { useLocale, useTranslations } from "next-intl"

import { getPetEventBus } from "@/lib/pet/events/pet-event-bus"
import { pickTalkedBubbleKey } from "@/lib/pet/bubbles/templates"
import { speakAsPet } from "@/lib/pet/bubbles/speak"
import { getSpeakLimiter } from "@/lib/pet/bubbles/speak-limiter"
import { EMOTION_TO_ONESHOT, parseEmotion } from "@/lib/pet/llm/emotion-tags"
import {
  formatHistoryLines,
  loadHistoryForPrompt,
  recordTurn,
  type PetHistoryDeps,
} from "@/lib/pet/llm/history"
import { recallAboutUser } from "@/lib/pet/llm/recall"
import { appendPetTurn, listRecentPetTurns } from "@/lib/db/pet-conversation"
import { resolveMemoryConfig } from "@/types/memory/memory"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { usePetStore, type PetBubble } from "@/stores/pet/pet-store"
import { useSettingsStore } from "@/stores/settings"
import type { PetProfile } from "@/types/pet"
import type { PetView } from "@/lib/pet/runtime/pet-view"
import type { ApplyMemoryContextDeps } from "@/lib/memory/runtime/apply-memory-context"

/** Template acknowledgements clear like normal bubbles; LLM replies linger. */
const TEMPLATE_BUBBLE_MS = 4000
const LLM_BUBBLE_MS = 7000

const HISTORY_DEPS: PetHistoryDeps = {
  append: appendPetTurn,
  listRecent: listRecentPetTurns,
}

export interface UsePetSpeakArgs {
  profile: PetProfile | undefined
  view: PetView | undefined
  /** Same gate as `usePetBubbles` — pet enabled and bubbles not muted. */
  enabled: boolean
}

export function usePetSpeak({ profile, view, enabled }: UsePetSpeakArgs): void {
  const t = useTranslations("pet")
  const locale = useLocale()
  const setBubble = usePetStore((s) => s.setBubble)
  const enqueueOneShot = usePetStore((s) => s.enqueueOneShot)
  const appSettings = useSettingsStore((s) => s.settings)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlight = useRef(false)
  /** Lazily-built memory retriever deps, cached after the first talk. */
  const memoryDeps = useRef<ApplyMemoryContextDeps | null | undefined>(undefined)

  // The bus subscription is long-lived; read the freshest props through a ref
  // so a profile/settings change doesn't churn the subscription.
  const latest = useRef({ profile, view, appSettings, locale })
  useEffect(() => {
    latest.current = { profile, view, appSettings, locale }
  })

  useEffect(() => {
    if (!enabled) return
    const off = getPetEventBus().subscribe((event) => {
      if (event.source !== "user" || event.kind !== "talked") return
      const current = latest.current

      const show = (text: string, origin: PetBubble["origin"], visibleMs: number) => {
        setBubble({ text, origin })
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setBubble(null), visibleMs)
      }
      const fallback = () => show(t(pickTalkedBubbleKey(event.at)), "template", TEMPLATE_BUBBLE_MS)

      const userText = typeof event.meta?.userText === "string" ? event.meta.userText.trim() : ""
      const llmSpeak = current.appSettings?.petSettings?.llmSpeak

      // Degradations that never reach the model: opt-out, bare talk (no text),
      // missing/unhatched pet state, an in-flight call, or the limiter saying no.
      const soul = current.profile?.soul
      if (!userText || !llmSpeak?.enabled || !soul || !current.view) {
        fallback()
        return
      }
      if (inFlight.current || !getSpeakLimiter().tryAcquire(Date.now())) {
        fallback()
        return
      }

      const client = buildUtilityLlmClient({
        session: null,
        appSettings: current.appSettings,
        override: llmSpeak,
        featureId: "pet-speak",
      })
      if (!client) {
        fallback()
        return
      }

      const memoryOn = current.appSettings?.petSettings?.petMemory?.enabled !== false
      const view = current.view
      const profileRow = current.profile

      inFlight.current = true
      void (async () => {
        // Assemble the optional prompt layers; each degrades independently.
        const historyText = memoryOn
          ? formatHistoryLines(await loadHistoryForPrompt(HISTORY_DEPS))
          : ""
        if (memoryDeps.current === undefined) {
          // Dynamic import keeps the twin/vector stack out of the widget's
          // module graph (same pattern as lib/claude/build-options.ts).
          memoryDeps.current =
            (await import("@/lib/memory/runtime/build-deps")
              .then((m) => m.tryBuildMemoryDeps(resolveMemoryConfig(current.appSettings?.memory)))
              .catch(() => null)) ?? null
        }
        const recallText = await recallAboutUser(memoryDeps.current ?? undefined, {
          queryText: userText,
        })

        return speakAsPet(client, {
          soul,
          bones: view.effectiveBones,
          userText,
          state: {
            mood: view.mood,
            energy: Math.round(view.needs.energy),
            bond: Math.round(view.needs.bond),
            level: profileRow?.level ?? 1,
          },
          historyText: historyText || undefined,
          recallText: recallText || undefined,
          emotionInstruction: true,
          locale: current.locale,
        })
      })()
        .then(async (raw) => {
          const parsed = raw ? parseEmotion(raw) : null
          if (!parsed || !parsed.cleanText) {
            fallback()
            return
          }
          show(parsed.cleanText, "llm", LLM_BUBBLE_MS)
          if (parsed.emotion) enqueueOneShot(EMOTION_TO_ONESHOT[parsed.emotion])
          if (memoryOn) {
            await recordTurn(HISTORY_DEPS, {
              userText,
              reply: parsed.cleanText,
              at: event.at,
            })
          }
        })
        .catch(() => fallback())
        .finally(() => {
          inFlight.current = false
        })
    })
    return () => {
      off()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [enabled, t, setBubble, enqueueOneShot])
}
