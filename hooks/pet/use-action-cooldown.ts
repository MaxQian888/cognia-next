// Transient per-interaction cooldown for the console action buttons. Keeps the
// "ready at" deadlines in the pet store (so they survive a re-render / tab
// switch) and ticks a local clock only while something is actually cooling down,
// exposing the remaining time + a trigger. UI-only — it gates spamming, it does
// not affect the persisted progression (the controller still processes every
// event that does get emitted).

"use client"

import { useEffect, useState } from "react"
import { usePetStore } from "@/stores/pet/pet-store"

export interface ActionCooldown {
  /** Remaining cooldown for `kind` in ms (0 = ready). */
  remaining: (kind: string) => number
  /** Start a cooldown of `durationMs` for `kind`. */
  trigger: (kind: string, durationMs: number) => void
}

export function useActionCooldown(): ActionCooldown {
  const cooldowns = usePetStore((s) => s.actionCooldowns)
  const setActionCooldown = usePetStore((s) => s.setActionCooldown)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const active = Object.values(cooldowns).some((until) => until > Date.now())
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [cooldowns])

  return {
    remaining: (kind) => Math.max(0, (cooldowns[kind] ?? 0) - now),
    trigger: (kind, durationMs) => setActionCooldown(kind, Date.now() + durationMs),
  }
}
