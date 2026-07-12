// Ephemeral speech bubbles. Subscribes to the pet event bus and, for kinds that
// have a template, shows a localized bubble for a few seconds. Separate from the
// controller because it needs the React i18n context and only affects transient
// UI. Honors the muted preference via `enabled`.

"use client"

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { getPetEventBus } from "@/lib/pet/events/pet-event-bus"
import { pickBubbleKey, pickCustomBubble } from "@/lib/pet/bubbles/templates"
import { isClaimed } from "@/lib/pet/llm/proactive/claim-registry"
import { usePetStore } from "@/stores/pet/pet-store"
import { useSettingsStore } from "@/stores/settings"

const BUBBLE_VISIBLE_MS = 4000

export function usePetBubbles(enabled: boolean, snark = 0): void {
  const t = useTranslations("pet")
  const setBubble = usePetStore((s) => s.setBubble)
  const customBubbles = useSettingsStore((s) => s.settings?.petSettings?.customBubbles)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Read through a ref so a slowly-growing snark stat never re-binds the bus
  // subscription.
  const snarkRef = useRef(snark)
  useEffect(() => {
    snarkRef.current = snark
  }, [snark])

  useEffect(() => {
    if (!enabled) return
    const off = getPetEventBus().subscribe((event) => {
      // While proactive speak is enabled it claims its milestone kinds — the
      // LLM hook owns those bubbles (with template fallback on failure).
      if (isClaimed(event.kind)) return
      const key = pickBubbleKey(event.kind, event.at, { snark: snarkRef.current })
      if (!key) return
      // A user catchphrase sprinkles in over the template ~1/3 of the time.
      const custom = pickCustomBubble(customBubbles, event.at)
      // Numeric meta rides into the template ({days} in streakDay pools);
      // next-intl ignores values a template doesn't reference.
      const days = typeof event.meta?.days === "number" ? event.meta.days : 0
      setBubble({ text: custom ?? t(key, { days }), origin: "template" })
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setBubble(null), BUBBLE_VISIBLE_MS)
    })
    return () => {
      off()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [enabled, t, setBubble, customBubbles])
}
