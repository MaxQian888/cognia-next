"use client"

/**
 * The artifact tabs belonging to the conversation currently on screen.
 *
 * `artifactStore` buckets both the open-tab list and the active tab by session
 * id, because the two used to be global: switching conversations left the dock
 * showing the previous one's tab strip and preview beside the new one's artifact
 * list and browser. Nothing in the artifact store knows which conversation is
 * on screen, so the join lives here — one place, reading `chatStore` — rather
 * than in every consumer.
 *
 * Surfaces with no conversation behind them (the artifact workspace route, a
 * Sheet host opened from a plugin) fall into the `NO_SESSION_KEY` bucket, the
 * same one the workbench's `?? "none"` scope key already uses.
 */

import {
  selectActiveArtifactId,
  selectOpenArtifactIds,
  useArtifactStore,
} from "@/stores/artifact/artifact-store"
import { useChatStore } from "@/stores/chat"

/** The session whose artifact tabs the dock is showing. */
export function useArtifactSessionId(): string | null {
  return useChatStore((state) => state.activeSessionId)
}

/** The artifact the on-screen conversation is parked on. */
export function useActiveArtifactId(): string | null {
  const sessionId = useArtifactSessionId()
  return useArtifactStore((state) => selectActiveArtifactId(state, sessionId))
}

/**
 * The on-screen conversation's open tabs, in the order they were opened.
 * Stable identity while the bucket is untouched, so it is safe to depend on.
 */
export function useOpenArtifactIds(): string[] {
  const sessionId = useArtifactSessionId()
  return useArtifactStore((state) => selectOpenArtifactIds(state, sessionId))
}
