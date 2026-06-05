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

"use client"

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"

import { getPetEventBus } from "@/lib/pet/events/pet-event-bus"
import { pickTalkedBubbleKey } from "@/lib/pet/bubbles/templates"
import { speakAsPet } from "@/lib/pet/bubbles/speak"
import { getSpeakLimiter } from "@/lib/pet/bubbles/speak-limiter"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { usePetStore, type PetBubble } from "@/stores/pet/pet-store"
import { useSettingsStore } from "@/stores/settings"
import type { PetProfile } from "@/types/pet"
import type { PetView } from "@/lib/pet/runtime/pet-view"

/** Template acknowledgements clear like normal bubbles; LLM replies linger. */
const TEMPLATE_BUBBLE_MS = 4000
const LLM_BUBBLE_MS = 7000

export interface UsePetSpeakArgs {
  profile: PetProfile | undefined
  view: PetView | undefined
  /** Same gate as `usePetBubbles` — pet enabled and bubbles not muted. */
  enabled: boolean
}

export function usePetSpeak({ profile, view, enabled }: UsePetSpeakArgs): void {
  const t = useTranslations("pet")
  const setBubble = usePetStore((s) => s.setBubble)
  const appSettings = useSettingsStore((s) => s.settings)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlight = useRef(false)

  // The bus subscription is long-lived; read the freshest props through a ref
  // so a profile/settings change doesn't churn the subscription.
  const latest = useRef({ profile, view, appSettings })
  useEffect(() => {
    latest.current = { profile, view, appSettings }
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

      inFlight.current = true
      void speakAsPet(client, {
        soul,
        bones: current.view.effectiveBones,
        userText,
      })
        .then((reply) => {
          if (reply) show(reply, "llm", LLM_BUBBLE_MS)
          else fallback()
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
  }, [enabled, t, setBubble])
}
