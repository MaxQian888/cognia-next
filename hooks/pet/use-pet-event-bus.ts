// Mounts the pet's event plumbing for the lifetime of the widget: subscribes the
// controller (persistence/progression) to the bus and wires every source into
// it. Disabled state tears everything down. Mount this once (via PetMount).

"use client"

import { useEffect } from "react"
import { getPetEventBus } from "@/lib/pet/events/pet-event-bus"
import { DEFAULT_PET_SOURCES, wirePetSources } from "@/lib/pet/events/wire-sources"
import { wireTwinActivitySource } from "@/lib/pet/events/sources/twin-activity-source"
import { handlePetEvent } from "@/lib/pet/runtime/pet-controller"
import type { PetTwinAwarenessSettings } from "@/types/pet"

export function usePetEventBus(enabled: boolean, twinAwareness?: PetTwinAwarenessSettings): void {
  const twinId = twinAwareness?.enabled ? (twinAwareness.twinId ?? null) : null

  useEffect(() => {
    if (!enabled) return
    const offController = getPetEventBus().subscribe((event) => {
      void handlePetEvent(event)
    })
    const sources = twinId ? [...DEFAULT_PET_SOURCES, wireTwinActivitySource(twinId)] : undefined
    const offSources = wirePetSources(undefined, sources)
    return () => {
      offController()
      offSources()
    }
  }, [enabled, twinId])
}
