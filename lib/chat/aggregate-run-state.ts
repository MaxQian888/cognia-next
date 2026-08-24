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
  /** Sessions in any non-idle state — what a "N running" badge counts. */
  active: number
  /** The focused conversation's own state, or `"idle"` when there is none. */
  focused: AggregateChatStatus
  /**
   * True when something is happening somewhere OTHER than the focused
   * conversation. The signal that justifies a "N in the background" affordance.
   */
  activeElsewhere: boolean
}

const PRECEDENCE: AggregateChatStatus[] = ["awaiting_approval", "streaming", "error", "idle"]

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
    if (id !== input.activeSessionId) activeElsewhere = true
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
    active: streaming + awaitingApproval + error,
    focused: input.activeSessionId
      ? (input.sessions?.[input.activeSessionId]?.status ?? "idle")
      : "idle",
    activeElsewhere,
  }
}

/** Sessions in a non-idle state, excluding the focused one. Ordered by key. */
export function backgroundActiveSessionIds(input: AggregateRunStateInput): string[] {
  return Object.entries(input.sessions ?? {})
    .filter(([id, slice]) => id !== input.activeSessionId && (slice?.status ?? "idle") !== "idle")
    .map(([id]) => id)
    .sort()
}
