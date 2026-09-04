// The action buttons' view of the interaction cooldown.
//
// This used to BE the cooldown: it kept "ready at" deadlines in the per-window
// pet store, which meant the gate reset on every reload and the main window,
// the overlay and the popup each enforced their own. Anything that did not go
// through a button (a hotkey, the tray, the overlay's body-tap, a plugin) was
// not gated at all.
//
// The deadline now lives on the persisted profile row and the controller
// enforces it, so this hook is a projection: it reads the same state the
// controller writes, and every surface agrees because they are all reading one
// row. `useLiveQuery` re-renders each of them when the controller writes.

"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { useEffect, useMemo, useState } from "react"
import { getDb } from "@/lib/db/schema"
import { normalizeInteractionGate, remainingCooldownMs } from "@/lib/pet/interaction/gate"

export interface ActionCooldown {
  /** Remaining cooldown for `kind` in ms (0 = ready). */
  remaining: (kind: string) => number
}

export function useActionCooldown(): ActionCooldown {
  const profile = useLiveQuery(() => getDb().petProfile.get("global"), [])
  const gate = useMemo(
    () => normalizeInteractionGate(profile?.interactionGate),
    [profile?.interactionGate]
  )
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const active = Object.keys(gate.lastAtByKind).some(
      (kind) => remainingCooldownMs(gate, kind, Date.now()) > 0
    )
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [gate])

  return {
    remaining: (kind) => remainingCooldownMs(gate, kind, now),
  }
}
