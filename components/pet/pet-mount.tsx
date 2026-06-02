// App-wide mount point for the pet widget. Reads the pet settings, gates the
// whole subsystem on `enabled`, wires the event bus, and lazily ensures the
// profile exists (resolving / persisting the deterministic account seed). Mounted
// once in `app/layout.tsx`.

"use client"

import { useEffect } from "react"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_PET_SETTINGS } from "@/types/pet"
import { usePetEventBus } from "@/hooks/pet/use-pet-event-bus"
import { ensurePetAccountId } from "@/lib/pet/bones/account-id"
import { ensurePetProfile } from "@/lib/pet/runtime/init-pet"
import { PetWidget } from "./pet-widget"

export function PetMount() {
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const pet = settings?.petSettings ?? DEFAULT_PET_SETTINGS
  const enabled = pet.enabled

  usePetEventBus(enabled)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void (async () => {
      const accountId = await ensurePetAccountId(settings, save)
      if (cancelled) return
      await ensurePetProfile(accountId)
    })()
    return () => {
      cancelled = true
    }
  }, [enabled, settings, save])

  if (!enabled) return null
  return <PetWidget settings={pet} />
}
