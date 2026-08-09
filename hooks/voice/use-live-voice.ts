/**
 * React binding for a live-voice session.
 *
 * `LiveVoiceController` is an external store (`subscribe` / `getSnapshot`), so
 * this is a `useSyncExternalStore` adapter and nothing more — the controller
 * owns all the audio and socket lifecycle.
 *
 * Two details that are easy to get wrong and expensive to debug:
 *
 * - **The idle fallback is a module-level constant.** `useSyncExternalStore`
 *   compares snapshots by identity, so returning a freshly built idle state for
 *   a null controller would produce a new object every render and throw
 *   "getSnapshot should be cached to avoid an infinite loop".
 *
 * - **A server snapshot is supplied.** This app is a static export, so every
 *   page is prerendered; without the third argument the hook throws during
 *   prerender instead of rendering the idle state.
 *
 * The controller's reducer returns the *same* state object for events that
 * change nothing (audio deltas arrive ~50/s), which is what keeps this from
 * re-rendering on every frame.
 */

"use client"

import { useSyncExternalStore } from "react"

import type { LiveVoiceController } from "@/lib/voice/live/controller"
import { createInitialLiveVoiceState, type LiveVoiceState } from "@/lib/voice/live/reducer"

/** Stable identity — see the note above about snapshot caching. */
const IDLE_STATE: LiveVoiceState = Object.freeze(createInitialLiveVoiceState())

const NO_OP_SUBSCRIBE = (): (() => void) => () => {}
const IDLE_SNAPSHOT = (): LiveVoiceState => IDLE_STATE

/**
 * Subscribe to a controller's conversation state.
 *
 * Passing `null` (no session yet, or one already torn down) yields a stable
 * idle state, so callers can render unconditionally.
 */
export function useLiveVoiceState(controller: LiveVoiceController | null): LiveVoiceState {
  return useSyncExternalStore(
    controller?.subscribe ?? NO_OP_SUBSCRIBE,
    controller?.getSnapshot ?? IDLE_SNAPSHOT,
    IDLE_SNAPSHOT
  )
}

const ZERO_LEVEL_SNAPSHOT = (): number => 0

/** Subscribe to the controller's throttled meter without re-rendering transcript state. */
export function useLiveVoiceInputLevel(controller: LiveVoiceController | null): number {
  return useSyncExternalStore(
    controller?.subscribeInputLevel ?? NO_OP_SUBSCRIBE,
    controller?.getInputLevelSnapshot ?? ZERO_LEVEL_SNAPSHOT,
    ZERO_LEVEL_SNAPSHOT
  )
}
