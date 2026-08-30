/**
 * Desktop adapter for the post-turn memory pass.
 *
 * The decision and enqueue live in `enqueueTurnMemory`, which reads settings
 * from Dexie so it works on every host. This wrapper keeps the renderer's
 * Zustand settings as the fast path and keeps the exported signature the two
 * chat hooks already call. Fire-and-forget at the call site: this never throws,
 * because memory must never break a send.
 */

import { useSettingsStore } from "@/stores/settings"
import {
  enqueueTurnMemory,
  type TurnMemoryInput,
  type TurnTranscriptEntry,
} from "@/lib/memory/lifecycle/enqueue-turn-memory"
import { drainMemoryJobsAfterTurn } from "@/lib/memory/lifecycle/job-worker"

export type { TurnMemoryInput, TurnTranscriptEntry }

export async function runTurnMemory(sessionId: string, input: TurnMemoryInput): Promise<void> {
  try {
    const settings = useSettingsStore.getState().settings
    const result = await enqueueTurnMemory({
      sessionId,
      ...input,
      ...(settings ? { settings } : {}),
    })
    // One job, right now, so a user does not wait up to the worker interval to
    // see what the turn learned. The backlog stays the interval worker's.
    if (result.enqueued) await drainMemoryJobsAfterTurn()
  } catch (err) {
    console.warn("runTurnMemory failed", err)
  }
}
