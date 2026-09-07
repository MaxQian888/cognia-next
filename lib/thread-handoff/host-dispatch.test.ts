/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { getDb } from "@/lib/db/schema"
import { buildThreadHandoffOffer } from "./orchestrator"
import { buildThreadHandoffPreflightEnvironment } from "./host-dispatch"
import * as service from "./service"
jest.mock("./service", () => {
  const actual = jest.requireActual("./service")
  return {
    ...actual,
    offerThreadHandoff: jest.fn(actual.offerThreadHandoff),
    commitThreadHandoff: jest.fn(actual.commitThreadHandoff),
    abortThreadHandoff: jest.fn(actual.abortThreadHandoff),
  }
})

import {
  THREAD_HANDOFF_COMMANDS,
  dispatchThreadHandoffCommand,
  isThreadHandoffCommand,
} from "./host-dispatch"

jest.mock("@/lib/db/thread-handoff-tickets", () => ({
  getThreadHandoffTicket: jest.fn(async () => ({ ticketId: "ticket-1", state: "frozen" })),
}))

describe("thread handoff host dispatch", () => {
  it("keeps the six-command family closed", () => {
    expect(THREAD_HANDOFF_COMMANDS).toHaveLength(6)
    for (const command of THREAD_HANDOFF_COMMANDS)
      expect(isThreadHandoffCommand(command)).toBe(true)
    expect(isThreadHandoffCommand("thread_handoff_delete")).toBe(false)
  })

  it("returns the persisted role-specific status", async () => {
    await expect(
      dispatchThreadHandoffCommand(
        "thread_handoff_status",
        { ticketId: "ticket-1", role: "source" },
        { importSession: jest.fn() }
      )
    ).resolves.toEqual({ ticketId: "ticket-1", state: "frozen" })
  })
})

describe("host handoff preflight and dispatch", () => {
  afterEach(() => jest.restoreAllMocks())

  it("recognizes mounted workspace roots during destination preflight", async () => {
    const id = "handoff-root-project"
    await getDb().projects.put({
      id,
      name: "Target workspace",
      roots: [
        { id: "primary", path: "/workspace/app", isPrimary: true },
        { id: "secondary", path: "/workspace/assets" },
      ],
      knowledgeBase: [],
      sessionIds: [],
      sessionCount: 0,
      messageCount: 0,
      createdAt: new Date(1),
      updatedAt: new Date(1),
      lastAccessedAt: new Date(1),
    })
    try {
      const offer = await buildThreadHandoffOffer(
        { id: "source", title: "Thread", createdAt: 1, updatedAt: 1 },
        { kind: "cloud", hostRef: "target" },
        100,
        { messages: [], deployments: [] }
      )
      const environment = await buildThreadHandoffPreflightEnvironment(offer.ticket)
      expect(environment.workspaceRefs).toEqual(
        expect.arrayContaining([id, "/workspace/app", "/workspace/assets"])
      )
    } finally {
      await getDb().projects.delete(id)
    }
  })

  it("advertises structured import without claiming a foreign native runtime session", async () => {
    const offer = await buildThreadHandoffOffer(
      { id: "source", title: "Thread", createdAt: 1, updatedAt: 1 },
      { kind: "cloud", hostRef: "target" },
      100,
      { messages: [], deployments: [] }
    )
    const env = await buildThreadHandoffPreflightEnvironment(offer.ticket)
    expect(env.capabilities).toContain("thread-handoff-structured-v1")
    expect(env.nativeRuntimeAvailable).toBe(false)
    expect(env.attachmentRefs).toEqual([])
  })

  it("recomputes target preflight instead of trusting the sender's successful result", async () => {
    const offer = await buildThreadHandoffOffer(
      { id: "source", title: "Thread", createdAt: 1, updatedAt: 1 },
      { kind: "cloud", hostRef: "target" },
      100,
      { messages: [], deployments: [] }
    )
    const importSession = jest.fn()
    await expect(
      dispatchThreadHandoffCommand(
        "thread_handoff_accept",
        {
          ticket: { ...offer.ticket, role: "target", preflight: { ok: true } },
          envelope: offer.envelope,
        },
        {
          importSession,
          now: () => 200,
          preflightEnvironment: async () => ({
            capabilities: [],
            hostOperations: [],
            providerRefs: [],
            models: [],
            credentialProfileRefs: [],
            workspaceRefs: [],
            attachmentRefs: [],
            protocolVersion: 1,
            nativeRuntimeAvailable: false,
          }),
        }
      )
    ).rejects.toThrow("thread_handoff_preflight_blocked")
    expect(importSession).not.toHaveBeenCalled()
  })

  it("routes offer, preflight, source/target commit, and abort to the ownership service", async () => {
    await getDb().hostDispatchQueue.clear()
    const offer = jest
      .mocked(service.offerThreadHandoff)
      .mockResolvedValue({ ticketId: "ticket" } as never)
    const commit = jest
      .mocked(service.commitThreadHandoff)
      .mockResolvedValue({ ticket: { ticketId: "ticket" }, proof: { state: "committed" } } as never)
    const abort = jest
      .mocked(service.abortThreadHandoff)
      .mockResolvedValue({ state: "aborted" } as never)
    const deps = { importSession: jest.fn(), now: () => 200 }
    await dispatchThreadHandoffCommand(
      "thread_handoff_offer",
      { ticket: { ticketId: "ticket" } },
      deps
    )
    expect(offer).toHaveBeenCalledWith({ ticketId: "ticket" }, 200)
    await dispatchThreadHandoffCommand(
      "thread_handoff_commit",
      { ticketId: "ticket", role: "source", acceptedProof: { state: "accepted" } },
      deps
    )
    await dispatchThreadHandoffCommand(
      "thread_handoff_commit",
      { ticketId: "ticket", role: "target", sourceCommitProof: { state: "committed" } },
      deps
    )
    expect(commit).toHaveBeenCalledTimes(2)
    await dispatchThreadHandoffCommand(
      "thread_handoff_abort",
      { ticketId: "ticket", role: "source", peerDisposition: "not-accepted" },
      deps
    )
    expect(abort).toHaveBeenCalledWith({
      ticketId: "ticket",
      role: "source",
      peerDisposition: "not-accepted",
      at: 200,
    })
  })
})
