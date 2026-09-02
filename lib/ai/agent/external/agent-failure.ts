/**
 * What went wrong for ONE external agent, kept next to that agent.
 *
 * The subsystem used to hold a single `lastError` string for the whole panel,
 * rendered as a banner above a list of agents. With more than one agent
 * configured the banner could not say which of them failed, and it was cleared
 * by a Dismiss button that had no other state to return to, so the only record
 * of a failed connection disappeared on the first click.
 *
 * Two things are recorded that the old string could not carry. The agent id,
 * so the report can be drawn where the user acted. And the cause chain: a
 * connect failure is usually a wrapper (`Pi adapter is not connected`) around
 * the sentence that actually explains it (`Could not determine the Pi
 * version`), and `error.message` alone throws the second one away.
 */

/** What the user was trying to do when it failed. */
export type ExternalAgentFailurePhase = "connect" | "disconnect" | "execute" | "session"

export interface ExternalAgentFailure {
  agentId: string
  phase: ExternalAgentFailurePhase
  /** The outermost message, as thrown. */
  message: string
  /** Everything that message was wrapping, outermost first. */
  causes: string[]
  /** Epoch millis, so a stale report can be told from a fresh one. */
  at: number
}

/** Depth cap. Chains longer than this are libraries talking to themselves. */
const MAX_CAUSE_DEPTH = 4

function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === "string") return value
  if (value === null || value === undefined) return ""
  if (typeof value === "object") {
    const candidate = (value as { message?: unknown }).message
    if (typeof candidate === "string") return candidate
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

/**
 * Every distinct sentence in an error's `cause` chain, outermost first.
 *
 * Duplicates are dropped rather than repeated. A wrapper that re-throws with
 * its cause's own message is common, and printing the same sentence twice
 * reads as two separate problems.
 */
export function flattenErrorCauses(error: unknown, limit = MAX_CAUSE_DEPTH): string[] {
  const seen = new Set<string>()
  const causes: string[] = []
  const head = messageOf(error).trim()
  if (head) seen.add(head)

  let current: unknown = error instanceof Error ? error.cause : undefined
  let depth = 0
  while (current !== undefined && current !== null && depth < limit) {
    const text = messageOf(current).trim()
    if (text && !seen.has(text)) {
      seen.add(text)
      causes.push(text)
    }
    current = current instanceof Error ? current.cause : undefined
    depth += 1
  }
  return causes
}

/**
 * Build the record the panel renders.
 *
 * `now` is injected rather than read from the clock so a caller can stamp a
 * batch of failures with one instant, and so the tests do not need fake timers.
 */
export function describeExternalAgentFailure(
  agentId: string,
  phase: ExternalAgentFailurePhase,
  error: unknown,
  now: number = Date.now()
): ExternalAgentFailure {
  const message = messageOf(error).trim()
  return {
    agentId,
    phase,
    // An error with no message at all still has to say something, or the panel
    // renders an empty red box that reads as a rendering bug.
    message: message || String(error),
    causes: flattenErrorCauses(error),
    at: now,
  }
}

/**
 * The failure and its causes as one list, outermost first.
 *
 * Kept out of the component so the ordering rule is testable and so both the
 * card and the diagnostics panel show the same chain in the same order.
 */
export function failureLines(failure: ExternalAgentFailure): string[] {
  return [failure.message, ...failure.causes].filter((line) => line.length > 0)
}
