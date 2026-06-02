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
import type { PetProfile } from "@/types/pet"

export interface UsePetResult {
  profile: PetProfile | undefined
  view: PetView | undefined
  loading: boolean
  feed: () => void
  play: () => void
  petStroke: () => void
  talk: () => void
}

export function usePet(activeCharacterId?: string | null): UsePetResult {
  const profile = useLiveQuery(() => getDb().petProfile.get("global"), [])
  const binding = useLiveQuery(
    () => (activeCharacterId ? getDb().petCharacterBindings.get(activeCharacterId) : undefined),
    [activeCharacterId]
  )

  const view = useMemo(
    // eslint-disable-next-line react-hooks/purity -- need-decay is computed against the wall clock captured when profile/binding change; an effect-based clock would add a render and shift timing.
    () => (profile ? computePetView(profile, binding ?? null, Date.now()) : undefined),
    [profile, binding]
  )

  return {
    profile,
    view,
    loading: profile === undefined,
    feed: () => emitPetEvent({ source: "user", kind: "fed" }),
    play: () => emitPetEvent({ source: "user", kind: "played" }),
    petStroke: () => emitPetEvent({ source: "user", kind: "petted" }),
    talk: () => emitPetEvent({ source: "user", kind: "talked" }),
  }
}
