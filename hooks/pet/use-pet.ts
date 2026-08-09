// Reactive read model for the pet. Subscribes to the Dexie profile + the active
// character's binding via `useLiveQuery`, then derives the view (bones, decayed
// needs, mood) with the pure `computePetView`. Also exposes the direct-interaction
// actions, which simply emit user events onto the bus (the controller persists).

"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { useMemo } from "react"
import { getDb } from "@/lib/db/schema"
import { computePetView, type PetView } from "@/lib/pet/runtime/pet-view"
import { emitPetEvent } from "@/lib/pet/events/pet-event-bus"
import type { PetCharacterBinding, PetProfile } from "@/types/pet"
import { migrateLegacyPetBinding } from "@/lib/pet/binding/resolve-skin"

export interface UsePetResult {
  profile: PetProfile | undefined
  view: PetView | undefined
  loading: boolean
  binding: PetCharacterBinding | undefined
  feed: () => void
  play: () => void
  petStroke: () => void
  /** Talk to the pet. With text → LLM speak (when opted in); bare → template. */
  talk: (text?: string) => void
  sleep: () => void
  clean: () => void
  treat: () => void
}

export function usePet(activeCharacterId?: string | null): UsePetResult {
  const profile = useLiveQuery(() => getDb().petProfile.get("global"), [])
  const binding = useLiveQuery(async () => {
    if (!activeCharacterId) return undefined
    const stored = await getDb().petCharacterBindings.get(activeCharacterId)
    if (!stored) return undefined
    const migrated = migrateLegacyPetBinding(stored)
    if (migrated !== stored) await getDb().petCharacterBindings.put(migrated)
    return migrated
  }, [activeCharacterId])

  const view = useMemo(
    // eslint-disable-next-line react-hooks/purity -- need-decay is computed against the wall clock captured when profile/binding change; an effect-based clock would add a render and shift timing.
    () => (profile ? computePetView(profile, binding ?? null, Date.now()) : undefined),
    [profile, binding]
  )

  return {
    profile,
    view,
    loading: profile === undefined,
    binding: binding ?? undefined,
    feed: () => emitPetEvent({ source: "user", kind: "fed" }),
    play: () => emitPetEvent({ source: "user", kind: "played" }),
    petStroke: () => emitPetEvent({ source: "user", kind: "petted" }),
    talk: (text?: string) => {
      const userText = text?.trim()
      emitPetEvent({
        source: "user",
        kind: "talked",
        meta: userText ? { userText } : undefined,
      })
    },
    sleep: () => emitPetEvent({ source: "user", kind: "slept" }),
    clean: () => emitPetEvent({ source: "user", kind: "cleaned" }),
    treat: () => emitPetEvent({ source: "user", kind: "treated" }),
  }
}
