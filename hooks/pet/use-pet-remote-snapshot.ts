// The paired desktop's live pet snapshot (`pet_get`, ADR-0219), for the
// remote console.
//
// The mirror tables paint the pet, but three things a care UI needs are not in
// any table: whether the desktop would accept an action at all, how long each
// action is still cooling down on the DESKTOP clock, and the presentation flags
// that live in its settings. This hook keeps that answer fresh:
//
//   - on mount, and whenever the window regains focus or becomes visible
//     (a phone coming back from the lock screen);
//   - when the host invalidates a pet table (`sync://invalidate`), which is
//     how a feed made on the desktop reaches the phone without a pull;
//   - after every remote action (the actions hook calls `refresh`).
//
// A failed refresh keeps the last good snapshot and reports why, so the
// console can say "couldn't reach your desktop" over the state it last saw
// rather than blanking the page.

"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { PetRemoteSnapshotError, type PetRemoteClient } from "@/lib/pet/remote/client"
import {
  livePetRemoteClient,
  subscribeLivePetTransport,
  type PetTransportSubscribe,
} from "@/lib/pet/remote/live-transport"
import { isPetMirrorTable } from "@/lib/pet/remote/mirror"
import type { PetRemoteSnapshot } from "@/lib/pet/remote/types"

export type PetRemoteSnapshotFailure =
  /** The call failed: the desktop did not answer. */
  | "unreachable"
  /** The desktop answered something that is not a pet snapshot. */
  | "invalid"

export interface PetRemoteSnapshotState {
  /** Undefined until the desktop first answers. */
  snapshot: PetRemoteSnapshot | undefined
  /** This device's clock when `snapshot` arrived; cooldowns age from it. */
  fetchedAt: number | null
  /** Why the latest refresh failed, or null after a success. */
  error: PetRemoteSnapshotFailure | null
  /** Ask the desktop again. Resolves to the snapshot, or null on failure. */
  refresh: () => Promise<PetRemoteSnapshot | null>
}

export interface UsePetRemoteSnapshotDeps {
  getClient?: () => PetRemoteClient
  subscribe?: PetTransportSubscribe
  now?: () => number
}

/** Invalidations arrive per table, five tables per reset; one fetch answers them all. */
export const PET_SNAPSHOT_INVALIDATE_COALESCE_MS = 200

const systemNow = () => Date.now()

type LoadResult =
  | { ticket: number; snapshot: PetRemoteSnapshot }
  | { ticket: number; failure: PetRemoteSnapshotFailure }

interface SnapshotData {
  snapshot: PetRemoteSnapshot | undefined
  fetchedAt: number | null
  error: PetRemoteSnapshotFailure | null
}

export function usePetRemoteSnapshot(
  enabled: boolean,
  deps: UsePetRemoteSnapshotDeps = {}
): PetRemoteSnapshotState {
  const getClient = deps.getClient ?? livePetRemoteClient
  const subscribe = deps.subscribe ?? subscribeLivePetTransport
  const now = deps.now ?? systemNow
  const [data, setData] = useState<SnapshotData>({
    snapshot: undefined,
    fetchedAt: null,
    error: null,
  })
  // Only the newest request may write: a slow answer to an older refresh must
  // not overwrite a newer one.
  const sequence = useRef(0)
  const mounted = useRef(true)

  // Fetching and applying are split so the effect below only ever sets state
  // from a promise callback, never synchronously in its own body.
  const load = useCallback(async (): Promise<LoadResult> => {
    const ticket = ++sequence.current
    try {
      return { ticket, snapshot: await getClient().getSnapshot() }
    } catch (error) {
      return {
        ticket,
        failure: error instanceof PetRemoteSnapshotError ? "invalid" : "unreachable",
      }
    }
  }, [getClient])

  const apply = useCallback(
    (result: LoadResult): PetRemoteSnapshot | null => {
      if (mounted.current && result.ticket === sequence.current) {
        if ("snapshot" in result) {
          setData({ snapshot: result.snapshot, fetchedAt: now(), error: null })
        } else {
          setData((previous) => ({ ...previous, error: result.failure }))
        }
      }
      return "snapshot" in result ? result.snapshot : null
    },
    [now]
  )

  const refresh = useCallback(async (): Promise<PetRemoteSnapshot | null> => {
    if (!enabled) return null
    return apply(await load())
  }, [enabled, load, apply])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    const run = () => {
      void load().then(apply)
    }
    run()

    const onFocus = run
    const onVisibility = () => {
      if (document.visibilityState === "visible") run()
    }
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onVisibility)

    let pending: ReturnType<typeof setTimeout> | null = null
    const stopInvalidations = subscribe<{ table?: unknown } | undefined>(
      "sync://invalidate",
      (payload) => {
        // An untabled frame is "pull everything", which includes the pet.
        const table = payload?.table
        if (table !== undefined && !isPetMirrorTable(table)) return
        if (pending !== null) return
        pending = setTimeout(() => {
          pending = null
          run()
        }, PET_SNAPSHOT_INVALIDATE_COALESCE_MS)
      }
    )

    return () => {
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onVisibility)
      if (pending !== null) clearTimeout(pending)
      stopInvalidations()
    }
  }, [enabled, load, apply, subscribe])

  return { ...data, refresh }
}

export interface RemoteActionCooldown {
  /** Ms until `kind` is accepted again by the desktop; 0 = ready. */
  remaining: (kind: string) => number
}

/**
 * The care buttons' cooldowns, aged on this device's clock from the moment the
 * snapshot arrived. Reading the mirrored `interactionGate` instead would
 * compare desktop timestamps against the phone's clock, and two clocks a few
 * seconds apart greyed a ready button (or offered one the desktop refused).
 */
export function useRemoteActionCooldown(
  snapshot: PetRemoteSnapshot | undefined,
  fetchedAt: number | null,
  deps: { now?: () => number; tickMs?: number } = {}
): RemoteActionCooldown {
  const clock = deps.now ?? systemNow
  const tickMs = deps.tickMs ?? 250
  const cooldowns = useMemo(() => snapshot?.summary?.cooldowns ?? {}, [snapshot])
  const [now, setNow] = useState(() => clock())

  useEffect(() => {
    if (fetchedAt === null) return
    const deadline = Math.max(0, ...Object.values(cooldowns)) + fetchedAt
    if (deadline <= clock()) return
    const id = setInterval(() => {
      const current = clock()
      setNow(current)
      if (current >= deadline) clearInterval(id)
    }, tickMs)
    return () => clearInterval(id)
  }, [cooldowns, fetchedAt, clock, tickMs])

  return {
    remaining: (kind) => {
      const total = cooldowns[kind] ?? 0
      if (total <= 0 || fetchedAt === null) return 0
      // Clamped to the snapshot's own figure: until the ticker first runs,
      // `now` may predate `fetchedAt`, which would read as longer than the
      // desktop said.
      return Math.min(total, Math.max(0, fetchedAt + total - now))
    },
  }
}
