/**
 * Per-channel policy for projecting an action review onto a run.
 *
 * Nine channels declare themselves in `ActionReviewChannel`, and until now each
 * one wired its own waiter, its own decision shape, its own pending store and
 * its own UI. The consequences were concrete: exactly ONE channel
 * (`workflow-step`) ever wrote an `ActionReviewReceipt`, so the audit table was
 * almost empty, and nothing could answer "what is blocked on a human right
 * now?" across channels.
 *
 * This registry deliberately does NOT take over settlement. Each channel keeps
 * owning its waiter — that is where the security-relevant decision plumbing
 * already lives and is already tested. What it centralises is the *projection*:
 * which run interrupt a channel's reviews park on, so one list can show them.
 *
 * Dexie-free on purpose, so the projection layer and any pure consumer can
 * consult it without acquiring a database import.
 */

import type { ActionReviewChannel } from "@cognia/agent-config-types/action-review"
import type { ExecutionRunInterrupt } from "@/types/execution/run"

export interface ActionReviewChannelAdapter {
  /**
   * The run interrupt this channel's reviews park on, or `null` for a channel
   * that records an outcome without ever blocking a run.
   *
   * `connector-workflow` is the deliberate `null`: the contract describes it as
   * receipt-only and "never a waiter", so minting an interrupt for it would
   * invent a pending item nobody can answer.
   */
  interruptType: ExecutionRunInterrupt["type"] | null
  /** Fallback TTL for a request that carries no `expiresAt`. */
  defaultTtlMs: number
}

/** Ten minutes — matches the connector HITL registry's existing TTL. */
export const DEFAULT_ACTION_REVIEW_TTL_MS = 10 * 60 * 1000

/**
 * A Squad gate holds a whole run open on a person, and those runs are started
 * to be walked away from. One hour before the gate denies by expiry.
 */
export const SQUAD_REVIEW_TTL_MS = 60 * 60 * 1000

/** A recovery decision waits a week: expiring it would decide for the person. */
export const TEAM_RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The built-in projection policy for every declared channel.
 *
 * Exhaustive by construction: `Record<ActionReviewChannel, …>` means adding a
 * channel to the contract fails the build here until its projection is chosen,
 * rather than silently defaulting to "invisible".
 */
export const DEFAULT_ACTION_REVIEW_ADAPTERS: Record<
  ActionReviewChannel,
  ActionReviewChannelAdapter
> = {
  "chat-tool": { interruptType: "tool_approval", defaultTtlMs: DEFAULT_ACTION_REVIEW_TTL_MS },
  "connector-tool": { interruptType: "tool_approval", defaultTtlMs: DEFAULT_ACTION_REVIEW_TTL_MS },
  "workflow-step": {
    interruptType: "workflow_approval",
    defaultTtlMs: DEFAULT_ACTION_REVIEW_TTL_MS,
  },
  "agent-team-plan": { interruptType: "plan_approval", defaultTtlMs: SQUAD_REVIEW_TTL_MS },
  // The pre-run capability audit is its own decision (ADR-0168): stale
  // capability ids, not a plan. Parking it on `plan_approval` made a card
  // offer the plan form for a question about plugins.
  "agent-team-gate": {
    interruptType: "squad_capability_audit",
    defaultTtlMs: SQUAD_REVIEW_TTL_MS,
  },
  "agent-team-budget": { interruptType: "squad_budget", defaultTtlMs: SQUAD_REVIEW_TTL_MS },
  "agent-team-deadlock": { interruptType: "squad_deadlock", defaultTtlMs: SQUAD_REVIEW_TTL_MS },
  "agent-team-teammate-repair": {
    interruptType: "squad_teammate_repair",
    defaultTtlMs: SQUAD_REVIEW_TTL_MS,
  },
  "agent-team-replan": { interruptType: "squad_replan", defaultTtlMs: SQUAD_REVIEW_TTL_MS },
  // A recovery decision is a durable human handoff in all but name: expiring
  // it would replay or drop work nobody chose to. Long TTL, same as a
  // `human_handoff` in spirit.
  "agent-team-recovery": {
    interruptType: "team_recovery",
    defaultTtlMs: TEAM_RECOVERY_TTL_MS,
  },
  "github-delivery": {
    interruptType: "workflow_approval",
    defaultTtlMs: DEFAULT_ACTION_REVIEW_TTL_MS,
  },
  "thread-handoff": { interruptType: "human_handoff", defaultTtlMs: DEFAULT_ACTION_REVIEW_TTL_MS },
  "connector-workflow": { interruptType: null, defaultTtlMs: DEFAULT_ACTION_REVIEW_TTL_MS },
  // A real interrupt type, deliberately unlike `connector-workflow` above:
  // a Bot's approval MUST produce something a person can answer, or the run
  // waits forever for a decision that never appears anywhere.
  "bot-step": { interruptType: "bot_approval", defaultTtlMs: DEFAULT_ACTION_REVIEW_TTL_MS },
  generic: { interruptType: "tool_approval", defaultTtlMs: DEFAULT_ACTION_REVIEW_TTL_MS },
}

const overrides = new Map<ActionReviewChannel, ActionReviewChannelAdapter>()

/**
 * Override one channel's projection policy. Returns an identity-checked
 * unregister, so a later registration is never clobbered by an earlier
 * owner's teardown.
 */
export function registerActionReviewChannel(
  channel: ActionReviewChannel,
  adapter: ActionReviewChannelAdapter
): () => void {
  overrides.set(channel, adapter)
  return () => {
    if (overrides.get(channel) === adapter) overrides.delete(channel)
  }
}

export function getActionReviewChannelAdapter(
  channel: ActionReviewChannel
): ActionReviewChannelAdapter {
  return overrides.get(channel) ?? DEFAULT_ACTION_REVIEW_ADAPTERS[channel]
}

/** Test-only: drop every override so suites do not leak into each other. */
export function __resetActionReviewChannelsForTesting(): void {
  overrides.clear()
}
