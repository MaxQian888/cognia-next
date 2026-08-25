/**
 * What the app as a whole is doing, across every open conversation.
 *
 * # The lie this replaces
 *
 * `useChatStore` keeps one slice per session and projects the FOCUSED slice
 * onto the store's top level, so ~130 legacy call sites can keep reading
 * `s.status`. That projection is correct for a panel that is showing one
 * conversation. It is a lie for anything that speaks for the whole app: the
 * tray, the status bar, the mobile shell. With two background turns streaming
 * and the focused conversation idle, all three said "idle" — the user had no
 * way to know work was in flight except by switching to it.
 *
 * # Precedence
 *
 * `awaiting_approval` outranks `streaming` because it is the only state that
 * needs the user; a run that is blocked on a decision the user has not been
 * shown is the worst thing for these surfaces to hide. `error` outranks `idle`
 * so a failure that happened off-screen is still visible, but sits below the
 * live states so an ongoing turn is never masked by an older failure.
 *
 * The focused session's own state is reported alongside rather than replaced:
 * a surface that points at one conversation still needs it, and a surface that
 * speaks for the app needs to be able to say "not the one you are looking at".
 */

export type AggregateChatStatus = "idle" | "streaming" | "awaiting_approval" | "error"

export interface AggregateRunState {
  /** The single word these surfaces should show. */
  status: AggregateChatStatus
  streaming: number
  awaitingApproval: number
  error: number
  /**
   * Sessions with work actually IN FLIGHT — what a "N running" badge counts.
   *
   * Deliberately excludes `error`. A turn that has already failed is not work
   * in flight, and every surface that renders this number renders it with
   * running chrome (a spinning loader, "N conversations running"). Counting a
   * failure there produces a spinner that never stops for a conversation that
   * stopped long ago — the same dishonest readout this module exists to remove.
   * A background failure is still visible: it reaches `status` through
   * {@link PRECEDENCE}, which ranks it above idle.
   */
  active: number
  /** The focused conversation's own state, or `"idle"` when there is none. */
  focused: AggregateChatStatus
  /**
   * True when work is in flight somewhere OTHER than the focused conversation.
   * The signal that justifies a "N in the background" affordance.
   *
   * Same exclusion as {@link active}, and for the same reason: the affordance
   * offers to take you to something that is happening.
   */
  activeElsewhere: boolean
}

const PRECEDENCE: AggregateChatStatus[] = ["awaiting_approval", "streaming", "error", "idle"]

/**
 * Whether a status means work is happening RIGHT NOW.
 *
 * The one predicate behind `active`, `activeElsewhere` and
 * {@link backgroundActiveSessionIds}, so the count, the affordance and the list
 * it opens can never disagree about what they are counting.
 */
function isInFlight(status: AggregateChatStatus): boolean {
  return status === "streaming" || status === "awaiting_approval"
}

export interface AggregateRunStateInput {
  sessions: Record<string, { status?: AggregateChatStatus } | undefined>
  activeSessionId?: string | null
}

export function aggregateRunState(input: AggregateRunStateInput): AggregateRunState {
  let streaming = 0
  let awaitingApproval = 0
  let error = 0
  let activeElsewhere = false

  for (const [id, slice] of Object.entries(input.sessions ?? {})) {
    const status = slice?.status ?? "idle"
    if (status === "idle") continue
    if (status === "streaming") streaming += 1
    else if (status === "awaiting_approval") awaitingApproval += 1
    else if (status === "error") error += 1
    // `error` is deliberately not "elsewhere activity" — see `activeElsewhere`.
    if (id !== input.activeSessionId && isInFlight(status)) activeElsewhere = true
  }

  const counts: Record<AggregateChatStatus, number> = {
    awaiting_approval: awaitingApproval,
    streaming,
    error,
    idle: 0,
  }
  const status = PRECEDENCE.find((candidate) => counts[candidate] > 0) ?? "idle"

  return {
    status,
    streaming,
    awaitingApproval,
    error,
    active: streaming + awaitingApproval,
    focused: input.activeSessionId
      ? (input.sessions?.[input.activeSessionId]?.status ?? "idle")
      : "idle",
    activeElsewhere,
  }
}

/**
 * Sessions with work in flight, excluding the focused one. Ordered by key.
 *
 * Exactly the sessions `activeElsewhere` is true about, so a caller that has
 * this list does not need to ask twice — its length IS the answer.
 */
export function backgroundActiveSessionIds(input: AggregateRunStateInput): string[] {
  return Object.entries(input.sessions ?? {})
    .filter(([id, slice]) => id !== input.activeSessionId && isInFlight(slice?.status ?? "idle"))
    .map(([id]) => id)
    .sort()
}
