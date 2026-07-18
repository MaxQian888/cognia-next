import {
  applyProjectFileProposal,
  discardProjectFileProposal,
  getProjectFileProposal,
  proposeProjectFileUpdate,
  rebaseProjectFileProposal,
  registerProjectFileProposalAdapter,
  resetProjectFileProposalsForTesting,
  setProjectFileProposalItemStatus,
  subscribeProjectFileProposals,
  undoProjectFileProposal,
} from "./project-file-proposals"

describe("project file proposals", () => {
  let content = "one"
  let token = "v1"

  beforeEach(() => {
    resetProjectFileProposalsForTesting()
    content = "one"
    token = "v1"
    registerProjectFileProposalAdapter("file", {
      capture: () => ({ content, baseToken: token }),
      apply: (next, expected) => {
        if (expected !== token) return false
        content = next
        token = token === "v1" ? "v2" : "v3"
        return token
      },
    })
  })

  it("applies accepted hunks once and supports undo", () => {
    const proposal = proposeProjectFileUpdate("file", "two", "request")!
    setProjectFileProposalItemStatus("file", proposal.review.items[0].id, "accepted")
    expect(applyProjectFileProposal("file")).toBe("applied")
    expect(content).toBe("two")
    expect(applyProjectFileProposal("file")).toBe("applied")
    expect(undoProjectFileProposal("file")).toBe(true)
    expect(content).toBe("one")
  })

  it("detects stale drafts and can rebase", () => {
    proposeProjectFileUpdate("file", "two", "request")
    content = "external"
    token = "external-token"
    expect(applyProjectFileProposal("file")).toBe("stale")
    expect(getProjectFileProposal("file")?.review.isStale).toBe(true)
    expect(rebaseProjectFileProposal("file")?.baseToken).toBe("external-token")
  })

  it("rejects missing and no-op proposals without notifying subscribers", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeProjectFileProposals(listener)

    expect(proposeProjectFileUpdate("missing", "two", "request")).toBeNull()
    expect(proposeProjectFileUpdate("file", "one", "request")).toBeNull()
    expect(applyProjectFileProposal("missing")).toBe("missing")
    expect(rebaseProjectFileProposal("missing")).toBeNull()
    expect(undoProjectFileProposal("missing")).toBe(false)
    setProjectFileProposalItemStatus("missing", "item", "accepted")
    discardProjectFileProposal("missing")
    expect(listener).not.toHaveBeenCalled()

    unsubscribe()
  })

  it("unregisters only the adapter instance that owns the registration", () => {
    const first = {
      capture: jest.fn(() => ({ content: "one", baseToken: "v1" })),
      apply: jest.fn(),
    }
    const second = {
      capture: jest.fn(() => ({ content: "one", baseToken: "v1" })),
      apply: jest.fn(),
    }
    const unregisterFirst = registerProjectFileProposalAdapter("owned", first)
    registerProjectFileProposalAdapter("owned", second)

    unregisterFirst()
    expect(proposeProjectFileUpdate("owned", "two", "request")).not.toBeNull()
  })

  it("marks a proposal stale when the adapter rejects compare-and-swap", () => {
    registerProjectFileProposalAdapter("rejected", {
      capture: () => ({ content: "one", baseToken: "v1" }),
      apply: () => false,
    })
    const proposal = proposeProjectFileUpdate("rejected", "two", "request")!
    setProjectFileProposalItemStatus("rejected", proposal.review.items[0].id, "accepted")

    expect(applyProjectFileProposal("rejected")).toBe("stale")
    expect(getProjectFileProposal("rejected")?.review.isStale).toBe(true)
  })

  it("discards proposals and reports failed undo compare-and-swap", () => {
    const listener = jest.fn()
    subscribeProjectFileProposals(listener)
    const proposal = proposeProjectFileUpdate("file", "two", "request")!
    setProjectFileProposalItemStatus("file", proposal.review.items[0].id, "accepted")
    expect(applyProjectFileProposal("file")).toBe("applied")

    token = "external-token"
    expect(undoProjectFileProposal("file")).toBe(false)
    discardProjectFileProposal("file")
    expect(getProjectFileProposal("file")).toBeNull()
    expect(listener).toHaveBeenCalled()
  })
})
