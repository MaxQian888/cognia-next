"use client"

/**
 * Wires `useDirtyDraft` to a persist call and drives the `UnsavedBar` status
 * machine: dirty → saving → saved → (after a beat) clean.
 *
 * Lives next to the panels rather than in `hooks/settings/` because the
 * toast-on-failure and the success-confirmation timing are this section's
 * presentation choices, not a general-purpose contract. The reusable half —
 * draft state and the dirty set — is `useDirtyDraft`.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { useDirtyDraft } from "@/hooks/settings/use-dirty-draft"
import type { UnsavedBarStatus } from "@/components/settings/common/unsaved-bar"
import { createLogger } from "@cognia/logging"

const log = createLogger("settings.subagents.policy")

/** How long the ✓ confirmation lingers before the bar retracts. */
const SAVED_DWELL_MS = 1400

export interface PolicyDraft<T extends object> {
  draft: T
  patch: (partial: Partial<T>) => void
  setField: <K extends keyof T>(key: K, value: T[K]) => void
  status: UnsavedBarStatus
  dirtyCount: number
  isDirty: boolean
  save: () => void
  discard: () => void
}

export function usePolicyDraft<T extends object>(
  identity: string,
  initial: T,
  persist: (values: T) => Promise<void>
): PolicyDraft<T> {
  const { draft, patch, setField, dirtyKeys, isDirty, discard, commit } = useDirtyDraft(
    identity,
    initial
  )
  const [phase, setPhase] = useState<"idle" | "saving" | "saved">("idle")
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current)
    }
  }, [])

  // A different panel was selected mid-confirmation — drop the stale ✓.
  // Derived during render (not in an effect) per the repo's
  // `react-hooks/set-state-in-effect` rule.
  const [lastIdentity, setLastIdentity] = useState(identity)
  if (lastIdentity !== identity) {
    setLastIdentity(identity)
    if (phase !== "idle") setPhase("idle")
  }

  const save = useCallback(() => {
    setPhase("saving")
    void (async () => {
      try {
        await persist(draft)
        commit()
        setPhase("saved")
        if (savedTimer.current) clearTimeout(savedTimer.current)
        savedTimer.current = setTimeout(() => setPhase("idle"), SAVED_DWELL_MS)
      } catch (err) {
        log.error("policy.saveFailed", err)
        toast.error(err instanceof Error ? err.message : String(err))
        setPhase("idle")
      }
    })()
  }, [draft, persist, commit])

  const status: UnsavedBarStatus =
    phase === "saving" ? "saving" : phase === "saved" ? "saved" : isDirty ? "dirty" : "clean"

  return {
    draft,
    patch,
    setField,
    status,
    dirtyCount: dirtyKeys.length,
    isDirty,
    save,
    discard,
  }
}
