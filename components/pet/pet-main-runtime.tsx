// The main desktop window's pet runtime: everything that produces what the
// pet says and how it looks, independent of which surface shows it.
//
// These hooks used to live inside `PetWidget`, which tied the pet's voice to
// the in-app widget being mounted. That made it impossible to hide the widget
// while the pet is out on the desktop (two pets on screen at once, the one in
// the app window plus the one on the desktop): unmounting the widget would
// have silenced every bubble, reminder and insight the overlay relays over
// the cross-window bridge, and frozen the appearance it mirrors. The runtime
// renders nothing and is mounted by `PetMount` whenever the pet is available,
// whether the widget, the overlay, or both are showing.

"use client"

import { useEffect } from "react"
import type { PetSettings } from "@/types/pet"
import { usePet } from "@/hooks/pet/use-pet"
import { usePetBubbles } from "@/hooks/pet/use-pet-bubbles"
import { usePetSpeak } from "@/hooks/pet/use-pet-speak"
import { usePetProactive } from "@/hooks/pet/use-pet-proactive"
import { usePetInsight } from "@/hooks/pet/use-pet-insight"
import { usePetScheduledReminder } from "@/hooks/pet/use-pet-scheduled-reminder"
import { useActiveLive2dModel } from "@/hooks/pet/use-active-live2d-model"
import { useActiveSpritePack } from "@/hooks/pet/use-active-sprite-pack"
import { usePetStore } from "@/stores/pet/pet-store"
import { resolveCharacterSkinSelection } from "@/lib/pet/binding/resolve-skin"
import { resolveEffectiveSkin, selectionFromEffectiveSkin } from "./skins/resolve-effective-skin"

export interface PetMainRuntimeProps {
  settings: PetSettings
  activeCharacterId?: string | null
}

export function PetMainRuntime({ settings, activeCharacterId }: PetMainRuntimeProps) {
  const { profile, view, binding } = usePet(activeCharacterId)
  const speaking = settings.enabled && !settings.mutedBubbles

  usePetBubbles(speaking, view?.effectiveStats.snark ?? 0)
  // Owns every `talked` bubble (LLM side channel + template fallback). Main
  // window only — overlay and popup talk replays here through the bridge.
  usePetSpeak({ profile, view, enabled: speaking, activeCharacterId })
  // Proactive speech (opt-in): event comments / idle chatter / time greetings.
  usePetProactive({ profile, view, enabled: speaking })
  // Attention Radar: one bubble, with an "open Insights" action, per report.
  usePetInsight(speaking)
  // Scheduled-task reminders: flourish + Notification-Center alert when a task
  // is due. Gated only on `enabled` — a reminder is real, not idle chatter.
  usePetScheduledReminder(settings.enabled)

  // The character-bound appearance, resolved the way the widget renders it,
  // published to the per-window store so the bridge mirrors it to the
  // overlay and popup (which cannot resolve a character binding themselves).
  const preferredSelection = resolveCharacterSkinSelection(settings, binding)
  const {
    modelId,
    row: activeModel,
    coreReady,
  } = useActiveLive2dModel(settings, preferredSelection)
  const { row: activeSpritePack } = useActiveSpritePack(settings, preferredSelection)
  const skinId = resolveEffectiveSkin(preferredSelection.skinId, {
    coreReady,
    hasActiveModel: Boolean(modelId),
    modelReady: activeModel?.compatibility?.status !== "invalid",
    hasActiveSpritePack: Boolean(activeSpritePack),
  })
  const packId = activeSpritePack?.id
  useEffect(() => {
    usePetStore
      .getState()
      .setAppearanceSelection(selectionFromEffectiveSkin(skinId, { modelId, packId }))
  }, [skinId, modelId, packId])

  return null
}
