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

/**
 * How much a *named* conversation is holding in the dock — open artifacts and
 * proposals awaiting review.
 *
 * Takes the session explicitly rather than reading the active one, because the
 * caller is the chat tab strip asking about conversations that are NOT on
 * screen. In split view the right rail follows `activeSessionId` alone, so an
 * artifact produced by the other pane was completely silent: no tab, no badge,
 * and `useDockAttentionSignal` deliberately ignores background sessions. This
 * is what makes "there is something over there" visible without moving the
 * rail's binding.
 */
export function useSessionArtifactSummary(sessionId: string): {
  openCount: number
  pendingReviewCount: number
} {
  const openCount = useArtifactStore((state) => selectOpenArtifactIds(state, sessionId).length)
  const pendingReviewCount = useArtifactStore(
    (state) =>
      Object.keys(state.pendingReviews).filter(
        (artifactId) => state.artifacts[artifactId]?.sessionId === sessionId
      ).length
  )
  return { openCount, pendingReviewCount }
}
