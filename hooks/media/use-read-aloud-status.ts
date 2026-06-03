"use client"

/**
 * Focused read-aloud status selector for a single chat message.
 *
 * The chat list is virtualized and every visible assistant row mounts a
 * `ReadAloudButton`. If each button subscribed to the full orchestrator state
 * (as `useTTS` does), every progress tick would re-render all of them. This
 * hook instead encodes only the two fields a per-message control needs —
 * "am I the active speaker" and the coarse playback state — into a string
 * snapshot, so `useSyncExternalStore`'s `Object.is` bailout skips re-renders
 * on progress-only updates.
 */

import { useCallback, useSyncExternalStore } from "react"

import { ttsOrchestrator, type TTSOrchestratorState } from "@/lib/tts/tts-orchestrator"
import type { TTSPlaybackState } from "@/types/media/tts"

export interface ReadAloudStatus {
  /** True when this message id owns the orchestrator's active playback. */
  isActive: boolean
  playbackState: TTSPlaybackState
  isPlaying: boolean
  isPaused: boolean
  isLoading: boolean
}

const IDLE_SNAPSHOT = "0:idle"

function subscribe(onStoreChange: () => void): () => void {
  // ttsOrchestrator.subscribe calls back with the state object; useSyncExternalStore
  // only needs the no-arg notification, so the extra arg is ignored.
  return ttsOrchestrator.subscribe(onStoreChange as (s: TTSOrchestratorState) => void)
}

function snapshotFor(messageId: string): string {
  const s = ttsOrchestrator.getState()
  const isActive = s.activeSourceId === messageId
  return `${isActive ? "1" : "0"}:${s.playbackState}`
}

export function useReadAloudStatus(messageId: string): ReadAloudStatus {
  const getSnapshot = useCallback(() => snapshotFor(messageId), [messageId])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => IDLE_SNAPSHOT)

  const [activeFlag, playbackState] = snapshot.split(":") as [string, TTSPlaybackState]
  const isActive = activeFlag === "1"
  return {
    isActive,
    playbackState,
    isPlaying: isActive && playbackState === "playing",
    isPaused: isActive && playbackState === "paused",
    isLoading: isActive && playbackState === "loading",
  }
}
