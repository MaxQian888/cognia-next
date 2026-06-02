// Mounts the pet's event plumbing for the lifetime of the widget: subscribes the
// controller (persistence/progression) to the bus and wires every source into
// it. Disabled state tears everything down. Mount this once (via PetMount).

"use client"

import { useEffect } from "react"
import { getPetEventBus } from "@/lib/pet/events/pet-event-bus"
import { wirePetSources } from "@/lib/pet/events/wire-sources"
import { handlePetEvent } from "@/lib/pet/runtime/pet-controller"

export function usePetEventBus(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const offController = getPetEventBus().subscribe((event) => {
      void handlePetEvent(event)
    })
    const offSources = wirePetSources()
    return () => {
      offController()
      offSources()
    }
  }, [enabled])
}
