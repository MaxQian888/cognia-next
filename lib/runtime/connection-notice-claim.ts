/**
 * Who reports the Host connection on screen right now.
 *
 * Three surfaces used to say "the Host is not answering" at once on a phone:
 * the shell's `OfflineBanner` ("Reconnecting…"), the route boundary's
 * read-only Alert ("Read-only: cached data stays readable") and the chat's own
 * runtime notice ("Waiting for the host" + Connection settings) — two stacked
 * bands of chrome above a card that already carried the recovery action.
 *
 * The chat notice is the one that knows what the user was trying to do and
 * where to send them, so while it is mounted it claims the report and the two
 * generic bands stand down. Anything else those bands carry (the outbound
 * queue, a refused row, an approval wait) is not a connection report and keeps
 * showing.
 *
 * The outbound queue is a second, separate claim. The composer strip carries
 * the queue on the same line ("Reconnecting · 2 queued"), so it claims both;
 * the empty-conversation card has no room for it and claims only the
 * connection, leaving the queue on the banner.
 *
 * Counters rather than flags: split view mounts two composers, and a claim
 * must outlive whichever one unmounts first.
 */

let connectionClaims = 0
let queueClaims = 0
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function claim(kind: "connection" | "queue"): () => void {
  if (kind === "connection") connectionClaims += 1
  else queueClaims += 1
  emit()
  let released = false
  return () => {
    if (released) return
    released = true
    if (kind === "connection") connectionClaims -= 1
    else queueClaims -= 1
    emit()
  }
}

/** Take the connection claim; returns its release. Idempotent per handle. */
export function claimConnectionNotice(): () => void {
  return claim("connection")
}

/** Take the outbound-queue claim; returns its release. Idempotent per handle. */
export function claimQueueNotice(): () => void {
  return claim("queue")
}

export function subscribeConnectionNoticeClaim(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** True while some mounted surface reports the Host connection itself. */
export function isConnectionNoticeClaimed(): boolean {
  return connectionClaims > 0
}

/** True while some mounted surface reports the outbound queue itself. */
export function isQueueNoticeClaimed(): boolean {
  return queueClaims > 0
}
