/**
 * Consensus orchestrator tests.
 *
 * The pure helpers (`tallyVotes` / `computeWinner` / `thresholdMet`) get
 * exhaustive matrix coverage; the orchestrator entry points
 * (`createConsensus` / `castVote` / `resolveConsensus` / `cancelConsensus`)
 * are exercised against the live Zustand store with the plugin lifecycle
 * hooks mocked out so we don't need to boot the plugin runtime.
 */

import "fake-indexeddb/auto"
import type { ConsensusVote } from "@/types/agent/agent-team"

const dispatchOnConsensusOpened = jest.fn()
const dispatchOnConsensusVoted = jest.fn()
const dispatchOnConsensusResolved = jest.fn()

jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginLifecycleHooks: jest.fn(() => ({
    dispatchOnConsensusOpened,
    dispatchOnConsensusVoted,
    dispatchOnConsensusResolved,
  })),
}))

import {
  cancelConsensus,
  castVote,
  computeWinner,
  createConsensus,
  resolveConsensus,
  tallyVotes,
  thresholdMet,
} from "./consensus-orchestrator"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"

function vote(voterId: string, optionIndex: number, weight?: number): ConsensusVote {
  return {
    voterId,
    voterName: voterId.toUpperCase(),
    optionIndex,
    weight,
    votedAt: new Date(),
  }
}

describe("pure helpers", () => {
  describe("tallyVotes", () => {
    it("counts each vote as 1 for non-weighted types", () => {
      expect(
        tallyVotes([vote("a", 0), vote("b", 0), vote("c", 1)], ["yes", "no"], "majority")
      ).toEqual([2, 1])
    })

    it("applies vote weight only for weighted consensus", () => {
      const votes = [vote("a", 0, 3), vote("b", 1, 1)]
      expect(tallyVotes(votes, ["yes", "no"], "weighted")).toEqual([3, 1])
      expect(tallyVotes(votes, ["yes", "no"], "majority")).toEqual([1, 1])
    })

    it("ignores out-of-range option indices", () => {
      expect(tallyVotes([vote("a", 5)], ["yes", "no"], "majority")).toEqual([0, 0])
    })
  })

  describe("computeWinner", () => {
    it("majority requires > 50% of total votes", () => {
      expect(computeWinner([vote("a", 0), vote("b", 1)], ["yes", "no"], "majority", 2)).toBeNull()
      expect(
        computeWinner([vote("a", 0), vote("b", 0), vote("c", 1)], ["yes", "no"], "majority", 3)
      ).toBe(0)
    })

    it("supermajority requires > 2/3 of total votes", () => {
      // 2/3 = ~66.67% — exactly 2 out of 3 fails (must be STRICTLY > 2/3).
      expect(
        computeWinner([vote("a", 0), vote("b", 0), vote("c", 1)], ["yes", "no"], "supermajority", 3)
      ).toBeNull()
      expect(
        computeWinner(
          [vote("a", 0), vote("b", 0), vote("c", 0), vote("d", 1)],
          ["yes", "no"],
          "supermajority",
          4
        )
      ).toBe(0)
    })

    it("unanimous requires all voters to agree", () => {
      expect(computeWinner([vote("a", 0), vote("b", 0)], ["yes", "no"], "unanimous", 3)).toBeNull()
      expect(
        computeWinner([vote("a", 0), vote("b", 0), vote("c", 0)], ["yes", "no"], "unanimous", 3)
      ).toBe(0)
    })

    it("weighted uses weighted majority", () => {
      const votes = [vote("a", 0, 5), vote("b", 1, 3)]
      expect(computeWinner(votes, ["yes", "no"], "weighted", 2)).toBe(0)
      const tied = [vote("a", 0, 3), vote("b", 1, 3)]
      expect(computeWinner(tied, ["yes", "no"], "weighted", 2)).toBeNull()
    })

    it("lead_override never auto-resolves", () => {
      expect(
        computeWinner([vote("a", 0), vote("b", 0), vote("c", 0)], ["yes", "no"], "lead_override", 3)
      ).toBeNull()
    })

    it("returns null on empty votes", () => {
      expect(computeWinner([], ["yes", "no"], "majority", 5)).toBeNull()
    })

    it("ties resolve to the lowest-index leader (deterministic)", () => {
      expect(
        computeWinner(
          [vote("a", 0), vote("b", 1), vote("c", 0), vote("d", 1), vote("e", 0)],
          ["yes", "no"],
          "majority",
          5
        )
      ).toBe(0)
    })
  })

  describe("thresholdMet", () => {
    it("mirrors computeWinner's null check", () => {
      expect(thresholdMet([], ["a", "b"], "majority", 2)).toBe(false)
      expect(thresholdMet([vote("v1", 0), vote("v2", 0)], ["a", "b"], "majority", 2)).toBe(true)
    })
  })
})

describe("orchestrator entry points", () => {
  /**
   * Stand up a team with `voterCount` teammates so the orchestrator's
   * threshold math has a real denominator. Returns the team id so callers
   * use it consistently with the consensus's teamId.
   */
  function setupTeam(voterCount: number): string {
    const store = useAgentTeamStore.getState()
    const team = store.createTeam({
      name: "Test Team",
      task: "Test task",
      leadName: "Lead",
    })
    for (let i = 1; i <= voterCount; i += 1) {
      store.addTeammate({
        teamId: team.id,
        name: `Voter ${i}`,
        role: "teammate",
      })
    }
    return team.id
  }

  beforeEach(() => {
    useAgentTeamStore.getState().reset()
    dispatchOnConsensusOpened.mockReset()
    dispatchOnConsensusVoted.mockReset()
    dispatchOnConsensusResolved.mockReset()
  })

  it("createConsensus persists and fires onConsensusOpened", () => {
    const result = createConsensus({
      teamId: "team-1",
      initiatorId: "lead",
      question: "Choose color",
      options: ["red", "blue"],
    })
    expect(result.status).toBe("open")
    expect(result.type).toBe("majority")
    expect(useAgentTeamStore.getState().consensus[result.id]).toBeDefined()
    expect(dispatchOnConsensusOpened).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "team-1",
        consensusId: result.id,
        options: ["red", "blue"],
      })
    )
  })

  it("castVote appends to votes[] and fires onConsensusVoted", () => {
    const c = createConsensus({
      teamId: "team-1",
      initiatorId: "lead",
      question: "?",
      options: ["a", "b", "c"],
    })
    const out = castVote({ consensusId: c.id, voterId: "v1", optionIndex: 1 })
    expect(out.votes).toHaveLength(1)
    expect(out.status).toBe("open")
    expect(dispatchOnConsensusVoted).toHaveBeenCalledWith(
      expect.objectContaining({
        consensusId: c.id,
        voterId: "v1",
        optionIndex: 1,
      })
    )
  })

  it("castVote re-vote replaces previous vote (idempotent per voter)", () => {
    const c = createConsensus({
      teamId: "team-1",
      initiatorId: "lead",
      question: "?",
      options: ["a", "b"],
    })
    castVote({ consensusId: c.id, voterId: "v1", optionIndex: 0 })
    const out = castVote({ consensusId: c.id, voterId: "v1", optionIndex: 1 })
    expect(out.votes).toHaveLength(1)
    expect(out.votes[0].optionIndex).toBe(1)
  })

  it("castVote auto-resolves when threshold is met (fires onConsensusResolved)", () => {
    // 2 teammates → majority needs > 1 vote for one option (2 of 2).
    const teamId = setupTeam(2)
    const c = createConsensus({
      teamId,
      initiatorId: "lead",
      question: "?",
      options: ["a", "b"],
    })
    castVote({ consensusId: c.id, voterId: "v1", optionIndex: 0 })
    const out = castVote({ consensusId: c.id, voterId: "v2", optionIndex: 0 })
    expect(out.status).toBe("resolved")
    expect(out.winningOption).toBe(0)
    expect(dispatchOnConsensusResolved).toHaveBeenCalledWith(
      expect.objectContaining({ consensusId: c.id, winningOption: 0 })
    )
  })

  it("does NOT auto-resolve when the team is missing from the store (defensive)", () => {
    // No team in store → voterCount=0 → majority can never resolve. Forces
    // the orchestrator user to call resolveConsensus explicitly.
    const c = createConsensus({
      teamId: "team-orphan",
      initiatorId: "lead",
      question: "?",
      options: ["a", "b"],
    })
    castVote({ consensusId: c.id, voterId: "v1", optionIndex: 0 })
    const after = castVote({ consensusId: c.id, voterId: "v2", optionIndex: 0 })
    expect(after.status).toBe("open")
    expect(dispatchOnConsensusResolved).not.toHaveBeenCalled()
  })

  it("castVote rejects when consensus is missing / closed / option out of range", () => {
    expect(() => castVote({ consensusId: "nope", voterId: "v1", optionIndex: 0 })).toThrow(
      /not found/
    )

    // For the "closed" case we explicitly resolve first, then verify the
    // follow-up vote is rejected. This avoids depending on auto-resolve
    // behaviour which is governed by team-size math.
    const c = createConsensus({
      teamId: "team-1",
      initiatorId: "lead",
      question: "?",
      options: ["a"],
    })
    resolveConsensus(c.id, 0)
    expect(() => castVote({ consensusId: c.id, voterId: "v2", optionIndex: 0 })).toThrow(/not open/)

    const c2 = createConsensus({
      teamId: "team-1",
      initiatorId: "lead",
      question: "?",
      options: ["a", "b"],
    })
    expect(() => castVote({ consensusId: c2.id, voterId: "v1", optionIndex: 5 })).toThrow(
      /out of range/
    )
  })

  it("resolveConsensus forces a winner and fires onConsensusResolved", () => {
    const c = createConsensus({
      teamId: "team-1",
      initiatorId: "lead",
      question: "?",
      options: ["a", "b"],
      type: "lead_override",
    })
    castVote({ consensusId: c.id, voterId: "v1", optionIndex: 0 })
    const resolved = resolveConsensus(c.id, 1, "lead overruled")
    expect(resolved.status).toBe("resolved")
    expect(resolved.winningOption).toBe(1)
    expect(resolved.summary).toBe("lead overruled")
    expect(dispatchOnConsensusResolved).toHaveBeenCalledWith(
      expect.objectContaining({ consensusId: c.id, winningOption: 1 })
    )
  })

  it("resolveConsensus rejects an out-of-range winningOption", () => {
    const c = createConsensus({
      teamId: "team-1",
      initiatorId: "lead",
      question: "?",
      options: ["a", "b"],
    })
    expect(() => resolveConsensus(c.id, 7)).toThrow(/out of range/)
  })

  it("cancelConsensus flips an open row to cancelled without firing resolved hook", () => {
    const c = createConsensus({
      teamId: "team-1",
      initiatorId: "lead",
      question: "?",
      options: ["a", "b"],
    })
    const out = cancelConsensus(c.id)
    expect(out?.status).toBe("cancelled")
    expect(dispatchOnConsensusResolved).not.toHaveBeenCalled()
  })

  it("cancelConsensus is a no-op on already-resolved rows", () => {
    const c = createConsensus({
      teamId: "team-1",
      initiatorId: "lead",
      question: "?",
      options: ["a"],
    })
    resolveConsensus(c.id, 0)
    const after = cancelConsensus(c.id)
    expect(after?.status).toBe("resolved")
  })
})
