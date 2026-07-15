// Provider-request lifecycle logging for a dispatch loop.
//
// Why this exists: a stalled turn used to be completely invisible from the
// sidecar. A Lark connector turn (2026-07-15) hung for its full 15-minute wall
// clock having emitted nothing after MCP init, and no log could say whether the
// request never got a first byte, or the stream opened and then broke. The three
// lines below separate those cases:
//
//   first provider event after <ms>              → the stream started
//   provider stream ended after <ms> (<n> events)→ clean finish
//   provider stream failed after <ms> (... first event never arrived ...)
//                                                → died, and whether pre-first-byte
//
// If the "first provider event" line never appears for a turn that later times
// out, the provider never answered at all — which is exactly the distinction the
// original incident could not make.
//
// These ride the unconditional `log` channel (stdout JSON → parent → persisted
// renderer log), NOT the COGNIA_SIDECAR_VERBOSE stderr channel, so a post-mortem
// doesn't depend on the stall having been reproduced with a special env var.

/**
 * @param {{
 *   sessionId: string,
 *   turnId?: string,
 *   log: (level: "info"|"warn"|"error", message: string) => void,
 *   now?: () => number,
 * }} params
 */
export function createProviderStreamLogger({ sessionId, turnId, log, now = Date.now }) {
  // `turnId` correlates these lines with the renderer's agent-trace span for the
  // same turn; absent when the parent didn't stamp one.
  const tag = turnId ? ` turn ${turnId}` : ""
  const startedAt = now()
  let firstEventAt = null
  let eventCount = 0

  return {
    /** Call for every event pulled off the provider stream. */
    onEvent() {
      if (firstEventAt === null) {
        firstEventAt = now()
        log(
          "info",
          `session ${sessionId}${tag}: first provider event after ${firstEventAt - startedAt}ms`
        )
      }
      eventCount += 1
    },
    /** Call when the stream completes normally. */
    onEnd() {
      log(
        "info",
        `session ${sessionId}${tag}: provider stream ended after ${now() - startedAt}ms (${eventCount} events)`
      )
    },
    /** Call when the stream throws. */
    onError(err) {
      const firstEvent =
        firstEventAt === null ? "never arrived" : `after ${firstEventAt - startedAt}ms`
      log(
        "error",
        `session ${sessionId}${tag}: provider stream failed after ${now() - startedAt}ms ` +
          `(${eventCount} events, first event ${firstEvent}): ${err?.message ?? String(err)}`
      )
    },
  }
}
