// Shared reply observation, built on each platform's `pollTargetMessages`.
//
// Every platform exposes a different way to read a conversation forward
// (Telegram acks an offset, Slack pages history, Discord takes an `after` id,
// Lark walks a time range, Matrix pages backwards). Each driver hides that
// behind one method that returns the target bot's messages it has not returned
// before; the two behaviours the harness actually cares about — "wait for the
// answer" and "keep watching for a second one" — are the same everywhere and
// live here, so a platform cannot accidentally implement the duplicate window
// differently from its siblings.

import { containsMarker } from "../marker.mjs"
import { pollUntil, sleep } from "./http.mjs"

/**
 * Wait for the target bot's reply carrying `marker`.
 *
 * Returns `null` on timeout. Messages seen along the way are retained on the
 * lease, so a reply that arrived before the first poll is never missed.
 */
export async function waitForMarkedReply(
  driver,
  lease,
  { marker, timeoutMs, intervalMs = 2000, signal, now = Date.now, sleepImpl = sleep }
) {
  const found = await pollUntil(
    async () => {
      const fresh = await driver.pollTargetMessages(lease)
      lease.observed.push(...fresh)
      return lease.observed.filter((message) => containsMarker(message.text ?? "", marker))
    },
    { timeoutMs, intervalMs, signal, now, sleepImpl }
  )
  return found?.[0] ?? null
}

/**
 * Keep watching for `windowMs` after the first reply and return everything the
 * target bot posted.
 *
 * This is the exactly-once check. It always burns the whole window — returning
 * early on "one reply, looks fine" is precisely how a duplicate that arrives a
 * second later goes unnoticed.
 */
export async function collectRepliesForWindow(
  driver,
  lease,
  { windowMs, intervalMs = 1000, signal, now = Date.now, sleepImpl = sleep }
) {
  const deadline = now() + windowMs
  for (;;) {
    const fresh = await driver.pollTargetMessages(lease)
    lease.observed.push(...fresh)
    const remaining = deadline - now()
    if (remaining <= 0 || signal?.aborted) break
    await sleepImpl(Math.min(intervalMs, remaining))
  }
  return [...lease.observed]
}

/** A fresh lease. Drivers add their own cursor fields on top. */
export function createLease({ platform, conversationId, extra = {} }) {
  return { platform, conversationId, observed: [], sentMessageIds: [], ...extra }
}

/** Normalize one platform message into the shape the runner and report expect. */
export function observedReply({ messageId, text, at, threadId = null }) {
  return { messageId: String(messageId), text: text ?? "", at: at ?? null, threadId }
}
