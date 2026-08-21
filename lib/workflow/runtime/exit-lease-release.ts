"use client"

/**
 * Hand back run leases when this host quits.
 *
 * A lease is claimed before the first step and heartbeat-renewed while the run
 * executes; `isLive` frees it once `expiresAt` passes. That is the right design
 * for a host that *crashes* — nobody can write on its behalf — but a host that
 * quits deliberately knows it is going, and leaving a live lease behind makes
 * the run unclaimable for the rest of the TTL for no reason. On a team where
 * another machine could pick it up, that is dead time by omission.
 *
 * Exit is never blocked and no takeover is awaited (there may be nobody to take
 * over). This releases and lets the process go.
 */

import { heldRunIds, releaseRunLease } from "./run-lease"

export interface ExitLeaseReleaseDeps {
  heldRunIds?: () => string[]
  release?: (runId: string) => Promise<void>
  markReleased?: (runId: string, at: number) => Promise<void>
  now?: () => number
  onError?: (error: unknown) => void
}

async function defaultMarkReleased(runId: string, at: number): Promise<void> {
  const { getDb } = await import("@/lib/db/schema")
  await getDb().workflowRuns.update(runId, { releasedForHandoffAt: at })
}

/**
 * Release every lease this process holds. Resolves once the writes settle, or
 * immediately if there is nothing held. Never throws.
 */
export async function releaseHeldLeasesForExit(deps: ExitLeaseReleaseDeps = {}): Promise<string[]> {
  const held = (deps.heldRunIds ?? heldRunIds)()
  if (held.length === 0) return []
  const at = (deps.now ?? Date.now)()
  const release = deps.release ?? releaseRunLease
  const markReleased = deps.markReleased ?? defaultMarkReleased

  const released: string[] = []
  await Promise.all(
    held.map(async (runId) => {
      try {
        // Stamp first: if the process dies between the two writes, a run marked
        // released with a lease still attached is recoverable (the TTL frees
        // it), whereas a freed lease with no stamp loses the reason.
        await markReleased(runId, at)
        await release(runId)
        released.push(runId)
      } catch (error) {
        // One run failing to release must not stop the others, and none of it
        // may delay exit.
        deps.onError?.(error)
      }
    })
  )
  return released
}

/**
 * Subscribe to the shell's teardown signals.
 *
 * Two signals, because neither alone covers every quit: `app://close-requested`
 * only fires when the close behavior is `ask`, and `pagehide` fires on every
 * webview teardown but gives no time to await. Releasing twice is harmless —
 * `releaseRunLease` is idempotent and ownership-checked.
 */
export function installExitLeaseRelease(deps: ExitLeaseReleaseDeps = {}): () => void {
  const onExit = () => {
    void releaseHeldLeasesForExit(deps)
  }
  if (typeof window === "undefined") return () => undefined
  window.addEventListener("pagehide", onExit)

  let unlistenClose: (() => void) | undefined
  let cancelled = false
  void import("@/lib/tauri/events")
    .then(({ onTauriEvent, TAURI_EVENTS }) => onTauriEvent(TAURI_EVENTS.appCloseRequested, onExit))
    .then(
      (unlisten) => {
        if (cancelled) unlisten()
        else unlistenClose = unlisten
      },
      () => {
        // Not a Tauri shell; `pagehide` alone is the whole story there.
      }
    )

  return () => {
    cancelled = true
    window.removeEventListener("pagehide", onExit)
    unlistenClose?.()
  }
}
