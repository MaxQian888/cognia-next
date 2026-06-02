// Ephemeral speech bubbles. Subscribes to the pet event bus and, for kinds that
// have a template, shows a localized bubble for a few seconds. Separate from the
// controller because it needs the React i18n context and only affects transient
// UI. Honors the muted preference via `enabled`.

"use client"

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { getPetEventBus } from "@/lib/pet/events/pet-event-bus"
import { pickBubbleKey } from "@/lib/pet/bubbles/templates"
import { usePetStore } from "@/stores/pet/pet-store"

const BUBBLE_VISIBLE_MS = 4000

export function usePetBubbles(enabled: boolean): void {
  const t = useTranslations("pet")
  const setBubble = usePetStore((s) => s.setBubble)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!enabled) return
    const off = getPetEventBus().subscribe((event) => {
      const key = pickBubbleKey(event.kind, event.at)
      if (!key) return
      setBubble({ text: t(key), origin: "template" })
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setBubble(null), BUBBLE_VISIBLE_MS)
    })
    return () => {
      off()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [enabled, t, setBubble])
}
