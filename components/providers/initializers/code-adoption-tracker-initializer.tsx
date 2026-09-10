"use client"

/**
 * Boot initializer for the local code-adoption tracker. Subscribes to the chat
 * store's turn lifecycle once and, on each settle edge, releases that turn's
 * managed working copy and persists its write-attribution.
 *
 * Mounted in `DeferredBootInitializers` for every host, NOT only the desktop.
 * This comment used to say the opposite — that it lived in
 * `DesktopOnlyInitializers` and that `startCodeAdoptionTracker` "self-no-ops off
 * Tauri" — and neither is true: the subscriber in
 * `lib/code-adoption/turn-tracker.ts` has no host gate at all, and it must not
 * have one. It is the only thing that calls `settleTaskWorkspaceTurn`, so a
 * host where it did not run would leave every chat turn's run `running` and
 * refuse that conversation's next send for good. Left as written, the comment
 * sent the next reader looking for the wedge anywhere but here.
 */

import { useEffect } from "react"

import { startCodeAdoptionTracker } from "@/lib/code-adoption/turn-tracker"

export function CodeAdoptionTrackerInitializer() {
  useEffect(() => startCodeAdoptionTracker(), [])
  return null
}

export default CodeAdoptionTrackerInitializer
