/**
 * Is anything running right now?
 *
 * Repointing the transport at another machine changes where every
 * `target: "execution"` command lands. Doing that under a live turn strands
 * the turn on a host the UI has stopped addressing, and the user gets no
 * error, just a conversation that never finishes.
 *
 * Two reasons this is a lazy async import rather than a hook:
 *
 *  * The switcher renders in the desktop status bar on every route, and
 *    subscribing to chat state there would re-render the whole bar on every
 *    streamed token.
 *  * `stores/chat` pulls in the whole chat runtime. The switcher is also
 *    mounted on a phone's `/devices` header, which has no reason to load it
 *    until someone actually opens the popover.
 *
 * `aggregateRunState` is the app-wide answer (`lib/chat/aggregate-run-state`),
 * chosen over the focused session's projected `status` for exactly the reason
 * that module documents: with two background turns streaming and the focused
 * conversation idle, the projection says "idle".
 */

import { aggregateRunState } from "@/lib/chat/aggregate-run-state"

/**
 * True when a turn is streaming or waiting on an approval anywhere.
 *
 * Never throws. A store that cannot be read is reported as "nothing running":
 * blocking a host switch behind a store-load failure would leave the user
 * unable to change machines at all, which is worse than the race this guards.
 */
export async function anyRunActive(): Promise<boolean> {
  try {
    const { useChatStore } = await import("@/stores/chat/chat-store")
    const { sessions, activeSessionId } = useChatStore.getState()
    return aggregateRunState({ sessions, activeSessionId }).active > 0
  } catch {
    return false
  }
}
