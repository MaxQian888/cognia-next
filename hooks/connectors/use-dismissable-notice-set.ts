"use client"

/**
 * The dismiss state machine shared by the Inbox notice sources.
 *
 * `useDegradedAdapters` and `useOutboundSaturation` each carried their own copy
 * of it: seed from storage, hash the affected-id set, reset the moment that
 * hash changes, expire on a TTL, and report whether the current set stands
 * dismissed. Only the storage kind and the key ever differed — and the two
 * copies had already drifted, one clearing the persisted snapshot on reset and
 * the other leaving it behind.
 *
 * `lib/inbox/notice-dismiss.ts` owns the pure storage helpers; this owns the
 * React lifetime around them.
 */

import { useEffect, useMemo, useState } from "react"
import {
  clearDismiss,
  hashSet,
  msUntilDismissExpiry,
  readDismiss,
  safeStorage,
  writeDismiss,
  type PersistedDismiss,
} from "@/lib/inbox/notice-dismiss"

export interface DismissableNoticeSet {
  /** True while the *current* affected-id set stands dismissed. */
  hidden: boolean
  dismiss: () => void
}

export function useDismissableNoticeSet(
  storageKey: string,
  storageKind: "local" | "session",
  ids: readonly string[]
): DismissableNoticeSet {
  const [dismissed, setDismissed] = useState<PersistedDismiss | null>(() =>
    readDismiss(storageKey, safeStorage(storageKind))
  )

  // `ids` is a fresh array every render; the hash is what actually identifies
  // the set, so everything downstream keys off it rather than the array.
  const setHash = useMemo(() => hashSet(ids), [ids])

  // Reset the dismiss snapshot the moment the affected-set hash changes: a
  // dismissal covers *that* set, not the notice forever. React 19's
  // compare-prev-during-render pattern keeps this out of an effect (lint rule
  // `react-hooks/set-state-in-effect`).
  const [trackedHash, setTrackedHash] = useState(setHash)
  if (trackedHash !== setHash) {
    setTrackedHash(setHash)
    if (dismissed && dismissed.hash !== setHash) {
      setDismissed(null)
      // Drop the persisted snapshot too, so the next mount doesn't re-hide a
      // set that has already changed.
      clearDismiss(storageKey, safeStorage(storageKind))
    }
  }

  // TTL countdown — a one-shot timer issues the setState from its callback
  // rather than the effect body.
  useEffect(() => {
    if (!dismissed) return
    const id = window.setTimeout(() => {
      setDismissed(null)
      clearDismiss(storageKey, safeStorage(storageKind))
    }, msUntilDismissExpiry(dismissed))
    return () => window.clearTimeout(id)
  }, [dismissed, storageKey, storageKind])

  return {
    hidden: dismissed !== null && dismissed.hash === setHash,
    dismiss: () => {
      writeDismiss(storageKey, setHash, safeStorage(storageKind))
      setDismissed({ hash: setHash, at: Date.now() })
    },
  }
}
