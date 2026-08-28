import { ThreadHandoffClient } from "./client"

describe("ThreadHandoffClient", () => {
  it("keeps the admin lease on both halves of commit", async () => {
    const call = jest.fn().mockResolvedValue({})
    const client = new ThreadHandoffClient({ call })
    const acceptedProof = {
      ticketId: "ticket-1",
      state: "accepted" as const,
      targetHostRef: "target",
      targetSessionId: "session-2",
      sequenceDigest: "digest",
    }
    const sourceProof = {
      ticketId: "ticket-1",
      state: "committed" as const,
      sourceHostRef: "source",
      sourceSessionId: "session-1",
      sequenceDigest: "digest",
    }

    await client.commitSource("ticket-1", acceptedProof, "lease-1")
    await client.commitTarget("ticket-1", sourceProof, "lease-2")

    expect(call).toHaveBeenNthCalledWith(1, "thread_handoff_commit", {
      ticketId: "ticket-1",
      role: "source",
      acceptedProof,
      adminLease: "lease-1",
    })
    expect(call).toHaveBeenNthCalledWith(2, "thread_handoff_commit", {
      ticketId: "ticket-1",
      role: "target",
      sourceCommitProof: sourceProof,
      adminLease: "lease-2",
    })
  })

  it("omits an absent peer disposition from abort", async () => {
    const call = jest.fn().mockResolvedValue({})
    const client = new ThreadHandoffClient({ call })

    await client.abort("ticket-1", "source")

    expect(call).toHaveBeenCalledWith("thread_handoff_abort", {
      ticketId: "ticket-1",
      role: "source",
    })
  })
})
