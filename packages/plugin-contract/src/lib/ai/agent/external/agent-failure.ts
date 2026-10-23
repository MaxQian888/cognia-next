/**
 * The plugin contract's share of `lib/ai/agent/external/agent-failure.ts`, which re-exports these.
 */
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
