/**
 * Proposal store — lifecycle tests for the open / applied / discarded
 * state machine + replacement semantics.
 */

import { __resetProposalStoreForTesting, useProposalStore } from "./proposal-store"
import type { ProposalOp } from "./proposal-types"

const sampleOps: ProposalOp[] = [
  { type: "add_node", nodeId: "n_a", kind: "trigger.manual", position: { x: 0, y: 0 } },
  { type: "add_node", nodeId: "n_b", kind: "ai.prompt", position: { x: 200, y: 0 } },
  { type: "connect_edge", edgeId: "e_ab", source: "n_a", target: "n_b" },
]

beforeEach(() => {
  __resetProposalStoreForTesting()
})

describe("openProposal", () => {
  it("opens a proposal and auto-computes opCount when omitted", () => {
    const payload = useProposalStore.getState().openProposal("wf_1", {
      proposalId: "p_1",
      workflowId: "wf_1",
      summary: "Add a parallel pair of analysts",
      ops: sampleOps,
    })
    expect(payload.opCount).toEqual({ add: 2, remove: 0, connect: 1, disconnect: 0, configure: 0 })
    expect(useProposalStore.getState().statusOf("p_1")).toBe("open")
    expect(useProposalStore.getState().getProposal("p_1")?.summary).toBe(
      "Add a parallel pair of analysts"
    )
  })

  it("opening a second proposal moves the first to discarded", () => {
    useProposalStore.getState().openProposal("wf_1", {
      proposalId: "p_1",
      workflowId: "wf_1",
      summary: "first",
      ops: sampleOps,
    })
    useProposalStore.getState().openProposal("wf_1", {
      proposalId: "p_2",
      workflowId: "wf_1",
      summary: "second",
      ops: sampleOps,
    })
    expect(useProposalStore.getState().statusOf("p_1")).toBe("discarded")
    expect(useProposalStore.getState().statusOf("p_2")).toBe("open")
  })

  it("two different workflows can each have their own open proposal", () => {
    useProposalStore.getState().openProposal("wf_1", {
      proposalId: "p_a",
      workflowId: "wf_1",
      summary: "wf1",
      ops: sampleOps,
    })
    useProposalStore.getState().openProposal("wf_2", {
      proposalId: "p_b",
      workflowId: "wf_2",
      summary: "wf2",
      ops: sampleOps,
    })
    expect(useProposalStore.getState().statusOf("p_a")).toBe("open")
    expect(useProposalStore.getState().statusOf("p_b")).toBe("open")
  })
})

describe("markApplied", () => {
  it("moves the open proposal to lastApplied", () => {
    useProposalStore.getState().openProposal("wf_1", {
      proposalId: "p_1",
      workflowId: "wf_1",
      summary: "x",
      ops: sampleOps,
    })
    useProposalStore.getState().markApplied("wf_1")
    expect(useProposalStore.getState().statusOf("p_1")).toBe("applied")
  })

  it("is a no-op when there is no open proposal", () => {
    expect(() => useProposalStore.getState().markApplied("wf_unknown")).not.toThrow()
    expect(useProposalStore.getState().statusOf("p_unknown")).toBeUndefined()
  })
})

describe("discardProposal", () => {
  it("moves the open proposal to lastDiscarded", () => {
    useProposalStore.getState().openProposal("wf_1", {
      proposalId: "p_1",
      workflowId: "wf_1",
      summary: "x",
      ops: sampleOps,
    })
    useProposalStore.getState().discardProposal("wf_1")
    expect(useProposalStore.getState().statusOf("p_1")).toBe("discarded")
  })

  it("is a no-op when there is no open proposal", () => {
    expect(() => useProposalStore.getState().discardProposal("wf_x")).not.toThrow()
  })
})

describe("clearProposalsFor", () => {
  it("wipes every record for a workflow", () => {
    useProposalStore.getState().openProposal("wf_1", {
      proposalId: "p_1",
      workflowId: "wf_1",
      summary: "x",
      ops: sampleOps,
    })
    useProposalStore.getState().markApplied("wf_1")
    useProposalStore.getState().openProposal("wf_1", {
      proposalId: "p_2",
      workflowId: "wf_1",
      summary: "y",
      ops: sampleOps,
    })
    useProposalStore.getState().discardProposal("wf_1")
    expect(useProposalStore.getState().statusOf("p_1")).toBe("applied")
    expect(useProposalStore.getState().statusOf("p_2")).toBe("discarded")

    useProposalStore.getState().clearProposalsFor("wf_1")
    expect(useProposalStore.getState().statusOf("p_1")).toBeUndefined()
    expect(useProposalStore.getState().statusOf("p_2")).toBeUndefined()
  })
})

describe("isolation between proposals", () => {
  it("applying one workflow's proposal does not touch another's", () => {
    useProposalStore.getState().openProposal("wf_1", {
      proposalId: "p_1",
      workflowId: "wf_1",
      summary: "w1",
      ops: sampleOps,
    })
    useProposalStore.getState().openProposal("wf_2", {
      proposalId: "p_2",
      workflowId: "wf_2",
      summary: "w2",
      ops: sampleOps,
    })
    useProposalStore.getState().markApplied("wf_1")
    expect(useProposalStore.getState().statusOf("p_1")).toBe("applied")
    expect(useProposalStore.getState().statusOf("p_2")).toBe("open")
  })
})
