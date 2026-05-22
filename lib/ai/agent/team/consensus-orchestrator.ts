/**
 * Consensus orchestrator — thin business logic on top of the store's CRUD
 * actions (`upsertConsensus` / `deleteConsensus` / `clearTeamConsensus`).
 *
 * The store already carries the data shape (`ConsensusRequest` /
 * `ConsensusVote` / `ConsensusType` etc.) and basic CRUD. This module adds:
 *
 *   - `createConsensus`     — builds a new `ConsensusRequest`, persists it,
 *                             fires `onConsensusOpened`.
 *   - `castVote`            — appends to `votes[]`, dedupes by voterId,
 *                             persists, fires `onConsensusVoted`. When the
 *                             resolved threshold is met, transitions to
 *                             `resolved` and fires `onConsensusResolved`.
 *   - `resolveConsensus`    — manual lead override; transitions a row to
 *                             `resolved` with `winningOption` + `summary`.
 *   - `cancelConsensus`     — transitions to `cancelled`.
 *
 * Pure functions where possible (`tallyVotes`, `computeWinner`,
 * `thresholdMet`) so tests don't need the Zustand store. The dispatch path
 * (read store → compute → write store) lives in the orchestrator entry
 * points themselves.
 */

import { nanoid } from "nanoid"
import type {
  CastVoteInput,
  ConsensusRequest,
  ConsensusType,
  ConsensusVote,
  CreateConsensusInput,
} from "@/types/agent/agent-team"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { getPluginLifecycleHooks } from "@/lib/plugin/messaging/hooks-system"

/**
 * Tally votes per option index. Returns an array indexed by option position.
 * Weighted consensus respects `vote.weight ?? 1`; every other type weighs
 * each vote as 1.
 */
export function tallyVotes(
  votes: ReadonlyArray<ConsensusVote>,
  options: ReadonlyArray<string>,
  type: ConsensusType
): number[] {
  const counts = new Array(options.length).fill(0)
  for (const v of votes) {
    if (v.optionIndex < 0 || v.optionIndex >= options.length) continue
    const weight = type === "weighted" ? (v.weight ?? 1) : 1
    counts[v.optionIndex] += weight
  }
  return counts
}

/**
 * Pick the winning option index, or `null` when there's no winner under the
 * current vote set + consensus type. Ties resolve to the lowest-index option
 * that's tied (deterministic for re-runs).
 *
 * Denominator semantics:
 *   - majority / supermajority / unanimous use `voterCount` (the expected
 *     voter pool — typically `team.teammateIds.length`). This is what most
 *     users mean by "majority of the team": resolving the first vote when
 *     1/3 is "in" is rarely the desired behaviour.
 *   - `weighted` uses the total weight cast so far; the expected total
 *     weight is unknown until every voter has registered their weighted
 *     vote, so we treat the running total as the denominator.
 *   - `lead_override` never auto-resolves; `resolveConsensus` is required.
 */
export function computeWinner(
  votes: ReadonlyArray<ConsensusVote>,
  options: ReadonlyArray<string>,
  type: ConsensusType,
  voterCount: number
): number | null {
  const counts = tallyVotes(votes, options, type)
  const total = counts.reduce((acc, c) => acc + c, 0)
  if (total === 0 || options.length === 0) return null

  // Find current leader index.
  let leader = 0
  for (let i = 1; i < counts.length; i += 1) {
    if (counts[i] > counts[leader]) leader = i
  }
  const leaderCount = counts[leader]

  switch (type) {
    case "majority":
      return voterCount > 0 && leaderCount > voterCount / 2 ? leader : null
    case "supermajority":
      return voterCount > 0 && leaderCount > (voterCount * 2) / 3 ? leader : null
    case "unanimous":
      return voterCount > 0 && leaderCount === voterCount ? leader : null
    case "weighted":
      // Weighted majority of the cast weight; expected total weight is
      // not knowable until everyone has voted with their weights set.
      return leaderCount > total / 2 ? leader : null
    case "lead_override":
      // Resolution requires explicit `resolveConsensus` call from the lead;
      // automatic resolution never fires for this type.
      return null
    default:
      return null
  }
}

/**
 * Returns true when the votes meet the threshold for the consensus type and
 * a winner has emerged. Used by `castVote` to decide whether to flip to
 * `resolved` automatically.
 */
export function thresholdMet(
  votes: ReadonlyArray<ConsensusVote>,
  options: ReadonlyArray<string>,
  type: ConsensusType,
  voterCount: number
): boolean {
  return computeWinner(votes, options, type, voterCount) !== null
}

/** Append (or replace) a vote in the votes array, dedupe-keyed by voterId. */
function applyVote(existing: ReadonlyArray<ConsensusVote>, vote: ConsensusVote): ConsensusVote[] {
  const filtered = existing.filter((v) => v.voterId !== vote.voterId)
  return [...filtered, vote]
}

/**
 * Create a new consensus request. Persists it via the store and fires
 * `onConsensusOpened`.
 */
export function createConsensus(input: CreateConsensusInput): ConsensusRequest {
  const consensus: ConsensusRequest = {
    id: nanoid(),
    teamId: input.teamId,
    initiatorId: input.initiatorId,
    question: input.question,
    options: input.options,
    type: input.type ?? "majority",
    status: "open",
    votes: [],
    taskId: input.taskId,
    timeoutMs: input.timeoutMs,
    createdAt: new Date(),
  }
  useAgentTeamStore.getState().upsertConsensus(consensus)
  getPluginLifecycleHooks().dispatchOnConsensusOpened({
    teamId: consensus.teamId,
    consensusId: consensus.id,
    question: consensus.question,
    options: [...consensus.options],
  })
  return consensus
}

/**
 * Cast a vote against an open consensus. Idempotent per voter — re-voting
 * replaces the previous vote rather than appending. Auto-resolves when the
 * vote set crosses the threshold for the consensus type.
 *
 * Returns the post-vote state (mutated copy):
 *   - { status: "open" }: more votes still needed
 *   - { status: "resolved", winningOption }: threshold met this turn
 *   - throws when consensus is missing, already resolved, or option index
 *     is out of range — callers handle UX feedback.
 */
export function castVote(input: CastVoteInput): ConsensusRequest {
  const store = useAgentTeamStore.getState()
  const current = store.consensus[input.consensusId]
  if (!current) {
    throw new Error(`consensus ${input.consensusId} not found`)
  }
  if (current.status !== "open") {
    throw new Error(`consensus ${input.consensusId} is not open (status=${current.status})`)
  }
  if (input.optionIndex < 0 || input.optionIndex >= current.options.length) {
    throw new Error(
      `optionIndex ${input.optionIndex} out of range for consensus ${input.consensusId}`
    )
  }
  const voter = store.teammates[input.voterId]
  const newVote: ConsensusVote = {
    voterId: input.voterId,
    voterName: voter?.name ?? input.voterId,
    optionIndex: input.optionIndex,
    reasoning: input.reasoning,
    votedAt: new Date(),
  }
  const nextVotes = applyVote(current.votes, newVote)

  // Voter pool = the team's teammates roster. When the team isn't in the
  // store (test fixtures or a teardown race) we fall back to 0, which by
  // `computeWinner`'s contract suppresses auto-resolution for majority /
  // supermajority / unanimous — callers must call `resolveConsensus`
  // explicitly. Weighted consensus stays on cast-weight totals and is
  // unaffected by the fallback.
  const team = store.teams[current.teamId]
  const voterCount = team ? team.teammateIds.length : 0

  const winner = computeWinner(nextVotes, current.options, current.type, voterCount)
  const next: ConsensusRequest = {
    ...current,
    votes: nextVotes,
  }
  const hooks = getPluginLifecycleHooks()
  hooks.dispatchOnConsensusVoted({
    teamId: current.teamId,
    consensusId: current.id,
    voterId: input.voterId,
    optionIndex: input.optionIndex,
  })
  if (winner !== null) {
    next.status = "resolved"
    next.winningOption = winner
    next.resolvedAt = new Date()
    next.summary = `Resolved: option ${winner + 1} (${current.options[winner]})`
    store.upsertConsensus(next)
    hooks.dispatchOnConsensusResolved({
      teamId: current.teamId,
      consensusId: current.id,
      winningOption: winner,
      summary: next.summary,
    })
  } else {
    store.upsertConsensus(next)
  }
  return next
}

/**
 * Manually resolve a consensus (lead-override path). Forces the consensus
 * into `resolved` with the supplied `winningOption` regardless of the
 * tallied vote distribution. Always fires `onConsensusResolved`.
 */
export function resolveConsensus(
  consensusId: string,
  winningOption: number,
  summary?: string
): ConsensusRequest {
  const store = useAgentTeamStore.getState()
  const current = store.consensus[consensusId]
  if (!current) {
    throw new Error(`consensus ${consensusId} not found`)
  }
  if (winningOption < 0 || winningOption >= current.options.length) {
    throw new Error(`winningOption ${winningOption} out of range for consensus ${consensusId}`)
  }
  const resolvedAt = new Date()
  const finalSummary =
    summary ?? `Resolved: option ${winningOption + 1} (${current.options[winningOption]})`
  const next: ConsensusRequest = {
    ...current,
    status: "resolved",
    winningOption,
    summary: finalSummary,
    resolvedAt,
  }
  store.upsertConsensus(next)
  getPluginLifecycleHooks().dispatchOnConsensusResolved({
    teamId: current.teamId,
    consensusId: current.id,
    winningOption,
    summary: finalSummary,
  })
  return next
}

/**
 * Cancel an open consensus. No hook fires here — callers can rely on
 * `selectConsensus` snapshot diffing to detect cancellation, and the team
 * lifecycle already includes a `consensus_recorded` checkpoint type.
 */
export function cancelConsensus(consensusId: string): ConsensusRequest | undefined {
  const store = useAgentTeamStore.getState()
  const current = store.consensus[consensusId]
  if (!current || current.status !== "open") return current
  const next: ConsensusRequest = {
    ...current,
    status: "cancelled",
    resolvedAt: new Date(),
  }
  store.upsertConsensus(next)
  return next
}
