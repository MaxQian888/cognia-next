/**
 * Stopping a Bot from answering itself forever.
 *
 * A Bot that comments on a pull request and also listens for comments is a
 * loop, and it is not a rare shape: it is what almost every useful Bot looks
 * like. Two independent guards, because either one alone fails in a way the
 * other catches.
 *
 *   1. PROVENANCE. When a Cognia run produced the thing an event describes, the
 *      event says so by id. Ids, not heuristics: matching on a bot account's
 *      display name breaks the moment a workspace renames it, and matching on
 *      "did we write something similar recently" is a guess.
 *   2. DEPTH. Every event carries how many Bot generations deep its chain is.
 *      A source that cannot tell us who produced something still cannot drive
 *      an unbounded chain, because depth is carried forward regardless.
 */

import type { BotEventEnvelopeV1, BotEventProvenanceV1 } from "@/types/bot/event"

/**
 * How many Bot generations a chain may run before it is cut.
 *
 * Three is enough for the legitimate shapes (a Bot opens a PR, CI reacts, the
 * Bot reads the result) and short enough that a runaway is caught in seconds
 * rather than in a bill.
 */
export const MAX_BOT_EVENT_DEPTH = 3

/** How many causation ids an envelope carries, so a long chain stays readable. */
export const MAX_CAUSATION_IDS = 8

export type BotLoopVerdict =
  { allowed: true } | { allowed: false; reason: "self_produced" | "depth_exceeded" }

/**
 * May this envelope start a run for this installation?
 *
 * `allowSelfTriggering` opts in to the first guard only. Nothing opts out of
 * the depth cap, because an opt-in that removes every brake is an opt-in to an
 * unbounded loop, and the person enabling it is not the person who pays for it.
 */
export function evaluateBotLoopGuard(input: {
  envelope: BotEventEnvelopeV1
  installationId: string
  allowSelfTriggering?: boolean
}): BotLoopVerdict {
  const { provenance } = input.envelope

  if (provenance.depth >= MAX_BOT_EVENT_DEPTH) {
    return { allowed: false, reason: "depth_exceeded" }
  }

  // Self-produced means "a Cognia Bot run made this". An event produced by
  // ANOTHER installation is not this Bot answering itself, so the opt-in is
  // only needed when the producer is this same installation.
  const producedByThisInstallation =
    provenance.selfProduced &&
    (provenance.producedByInstallationId === undefined ||
      provenance.producedByInstallationId === input.installationId)

  if (producedByThisInstallation && input.allowSelfTriggering !== true) {
    return { allowed: false, reason: "self_produced" }
  }

  return { allowed: true }
}

/**
 * The provenance an event produced BY a Bot run should carry.
 *
 * Called when a Bot's own action creates something the outside world will
 * echo back: a comment, a push, a label. The returned block is what makes the
 * echo recognisable when it arrives.
 */
export function provenanceForBotOutput(input: {
  runId: string
  installationId: string
  actionJobId?: string
  /** The envelope that caused this run, when it had one. */
  cause?: BotEventEnvelopeV1
}): BotEventProvenanceV1 {
  const causation = [
    ...(input.cause ? [input.cause.eventId] : []),
    ...(input.cause?.provenance.causationEventIds ?? []),
  ].slice(0, MAX_CAUSATION_IDS)

  return {
    selfProduced: true,
    producedByRunId: input.runId,
    producedByInstallationId: input.installationId,
    depth: (input.cause?.provenance.depth ?? 0) + 1,
    ...(input.actionJobId ? { producedByActionJobId: input.actionJobId } : {}),
    ...(causation.length > 0 ? { causationEventIds: causation } : {}),
  }
}

/** Provenance for an event nothing of ours produced. */
export function externalProvenance(): BotEventProvenanceV1 {
  return { selfProduced: false, depth: 0 }
}
