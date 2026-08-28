/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import type { ThreadHandoffTicket } from "@cognia/agent-config-types/thread-handoff"
import { __resetDbForTesting, getDb } from "./schema"
import {
  ThreadHandoffConflictError,
  getThreadHandoffTicket,
  saveThreadHandoffTicket,
  sweepExpiredThreadHandoffTickets,
  transitionThreadHandoffTicket,
} from "./thread-handoff-tickets"

function ticket(overrides: Partial<ThreadHandoffTicket> = {}): ThreadHandoffTicket {
  return {
    ticketVersion: 1,
    ticketId: "ticket-1",
    role: "source",
    state: "preparing",
    source: {
      hostRef: "local",
      kind: "desktop",
      sessionId: "session-1",
      title: "Thread",
      messageCount: 2,
    },
    target: { hostRef: "host-cloud", kind: "cloud" },
    transport: "remote-host",
    project: { workspaceRef: "workspace-main" },
    requirements: {
      capabilities: [],
      hostOperations: [],
      providerRefs: [],
      models: [],
      credentialProfileRefs: [],
      minProtocolVersion: 1,
    },
    continuation: {
      sourceRuntime: "ai-sdk",
      fidelity: "contextual",
      sequenceDigest: "a".repeat(64),
    },
    attachments: [],
    pendingApprovals: [],
    history: [{ state: "preparing", at: 100 }],
    createdAt: 100,
    updatedAt: 100,
    expiresAt: 1_000,
    ...overrides,
  }
}

describe("thread handoff ticket persistence", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("stores source and target rows under one ticket id", async () => {
    await saveThreadHandoffTicket(ticket())
    await saveThreadHandoffTicket(ticket({ role: "target" }))

    await expect(getThreadHandoffTicket("ticket-1", "source")).resolves.toMatchObject({
      role: "source",
      state: "preparing",
    })
    await expect(getThreadHandoffTicket("ticket-1", "target")).resolves.toMatchObject({
      role: "target",
      state: "preparing",
    })
  })

  it("rejects unsafe cross-host refs before persistence", async () => {
    await expect(
      saveThreadHandoffTicket(ticket({ project: { workspaceRef: "/Users/alice/repo" } }))
    ).rejects.toThrow(/absolute/i)
    await expect(getDb().threadHandoffTickets.count()).resolves.toBe(0)
  })

  it("makes repeated transitions idempotent and rejects illegal jumps", async () => {
    await saveThreadHandoffTicket(ticket())
    const frozen = await transitionThreadHandoffTicket({
      ticketId: "ticket-1",
      role: "source",
      to: "frozen",
      at: 200,
      actor: "source-host",
    })
    const replay = await transitionThreadHandoffTicket({
      ticketId: "ticket-1",
      role: "source",
      to: "frozen",
      at: 300,
      actor: "source-host",
    })

    expect(replay).toEqual(frozen)
    expect(replay.history).toHaveLength(2)
    await expect(
      transitionThreadHandoffTicket({
        ticketId: "ticket-1",
        role: "source",
        to: "committed",
        at: 400,
      })
    ).rejects.toBeInstanceOf(ThreadHandoffConflictError)
  })

  it("retires expired preparing and frozen-source tickets, leaving peer-owned ones stranded", async () => {
    await getDb().sessions.add({
      id: "session-1",
      title: "Thread",
      createdAt: 0,
      updatedAt: 0,
      handoffLock: {
        ticketId: "frozen",
        state: "frozen",
        targetHostRef: "host-cloud",
        at: 10,
      },
    } as never)
    await saveThreadHandoffTicket(ticket({ ticketId: "preparing", expiresAt: 50 }))
    await saveThreadHandoffTicket(
      ticket({ ticketId: "frozen", state: "frozen", expiresAt: 50, role: "source" })
    )
    // A frozen TARGET ticket is the peer's half of an in-flight handoff, and an
    // `accepted` one already has a second copy — both still need peer proof.
    await saveThreadHandoffTicket(
      ticket({ ticketId: "frozen-target", state: "frozen", expiresAt: 50, role: "target" })
    )
    await saveThreadHandoffTicket(
      ticket({ ticketId: "accepted", state: "accepted", expiresAt: 50, role: "target" })
    )

    await expect(sweepExpiredThreadHandoffTickets(100)).resolves.toEqual({
      abortedPreparing: 1,
      abortedFrozenSource: 1,
      stranded: 2,
    })
    await expect(getThreadHandoffTicket("preparing", "source")).resolves.toMatchObject({
      state: "aborted",
    })
    await expect(getThreadHandoffTicket("frozen", "source")).resolves.toMatchObject({
      state: "aborted",
    })
    await expect(getThreadHandoffTicket("frozen-target", "target")).resolves.toMatchObject({
      state: "frozen",
    })
    await expect(getThreadHandoffTicket("accepted", "target")).resolves.toMatchObject({
      state: "accepted",
    })
  })

  it("releases the source session's handoff lock when it retires an expired offer", async () => {
    await getDb().sessions.add({
      id: "session-1",
      title: "Thread",
      createdAt: 0,
      updatedAt: 0,
      handoffLock: {
        ticketId: "frozen",
        state: "frozen",
        targetHostRef: "host-cloud",
        at: 10,
      },
    } as never)
    await saveThreadHandoffTicket(
      ticket({ ticketId: "frozen", state: "frozen", expiresAt: 50, role: "source" })
    )

    await sweepExpiredThreadHandoffTickets(100)

    // Without this the conversation stays read-only forever: every ordinary
    // write goes through `assertSessionWritable`, which only looks at the lock.
    const session = await getDb().sessions.get("session-1")
    expect(session).toBeDefined()
    expect(session?.handoffLock).toBeUndefined()
  })
})
