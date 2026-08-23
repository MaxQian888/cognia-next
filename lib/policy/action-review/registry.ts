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
  "agent-team-plan": { interruptType: "plan_approval", defaultTtlMs: DEFAULT_ACTION_REVIEW_TTL_MS },
  "agent-team-gate": { interruptType: "plan_approval", defaultTtlMs: DEFAULT_ACTION_REVIEW_TTL_MS },
  "github-delivery": {
    interruptType: "workflow_approval",
    defaultTtlMs: DEFAULT_ACTION_REVIEW_TTL_MS,
  },
  "thread-handoff": { interruptType: "human_handoff", defaultTtlMs: DEFAULT_ACTION_REVIEW_TTL_MS },
  "connector-workflow": { interruptType: null, defaultTtlMs: DEFAULT_ACTION_REVIEW_TTL_MS },
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
