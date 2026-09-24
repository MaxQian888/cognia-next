/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { getDb } from "@/lib/db/schema"
import { buildThreadHandoffOffer } from "./orchestrator"
import { resumeAcceptedThreadHandoff } from "./standalone-receiver"
import type { ThreadHandoffOfferFrame } from "./orchestrator"
const mockCall = jest.fn()
const mockIssueLease = jest.fn().mockResolvedValue({ token: "lease" })
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: () => "mobile",
}))
jest.mock("@/lib/tauri", () => ({
  ...jest.requireActual("@/lib/tauri"),
  transport: { call: (...args: unknown[]) => mockCall(...args) },
}))
jest.mock("@/lib/tauri/admin-lease", () => ({
  issueHostAdminLease: (...args: unknown[]) => mockIssueLease(...args),
}))
import {
  completeInboundThreadHandoff,
  prepareInboundThreadHandoff,
  type PreparedInboundThreadHandoff,
} from "./standalone-receiver"

const frame = {
  ticket: {
    role: "target",
    target: { kind: "mobile", hostRef: "phone-1" },
  },
} as ThreadHandoffOfferFrame

describe("standalone thread handoff receiver", () => {
  it.each([
    { role: "source", target: { kind: "mobile", hostRef: "phone-1" } },
    { role: "target", target: { kind: "cloud", hostRef: "phone-1" } },
  ])("ignores offers that are not mobile target offers", async (ticket) => {
    await expect(
      prepareInboundThreadHandoff({ ...frame, ticket } as never, "phone-1")
    ).resolves.toBeNull()
  })

  it.each([
    { role: "source", state: "accepted", target: { sessionId: "s" } },
    { role: "target", state: "accepted", target: {} },
  ])("refuses resume without target ownership and a target session", async (ticket) => {
    await expect(resumeAcceptedThreadHandoff(ticket as never)).rejects.toThrow(
      "target_not_accepted"
    )
  })
  it("ignores offers addressed to another device", async () => {
    await expect(
      prepareInboundThreadHandoff(frame, "phone-2", {
        environment: jest.fn() as never,
      })
    ).resolves.toBeNull()
  })

  it("never imports when preflight is blocked", async () => {
    const importSession = jest.fn()
    const prepared = {
      frame,
      ticket: frame.ticket,
      preflight: { ok: false, blockers: [], achievableFidelity: "unsupported", checkedAt: 1 },
    } as PreparedInboundThreadHandoff
    await expect(completeInboundThreadHandoff(prepared, { importSession })).rejects.toThrow(
      "thread_handoff_preflight_blocked"
    )
    expect(importSession).not.toHaveBeenCalled()
  })
})

describe("standalone receiver continuation and recovery", () => {
  beforeEach(async () => {
    await getDb().threadHandoffTickets.clear()
    await getDb().sessions.clear()
    await getDb().messages.clear()
  })

  it("uses production preflight, lease and RPC defaults and completes an interrupted target commit", async () => {
    const offer = await buildThreadHandoffOffer(
      { id: "source", title: "Thread", createdAt: 1, updatedAt: 1 },
      { kind: "mobile", hostRef: "phone-1" },
      Date.now(),
      { ticketId: "defaults", deployments: [], messages: [] }
    )
    const incoming = { ...offer, ticket: { ...offer.ticket, role: "target" as const } }
    incoming.envelope.goals = [
      { goalId: "goal", description: "Keep production unchanged", status: "active" },
    ]
    const prepared = await prepareInboundThreadHandoff(incoming, "phone-1")
    expect(prepared?.preflight).toMatchObject({ ok: true, blockers: [] })
    mockCall.mockImplementation(async (_name, args) => ({
      proof: {
        ticketId: args.ticketId,
        state: "committed",
        sourceHostRef: incoming.ticket.source.hostRef,
        sourceSessionId: "source",
        sequenceDigest: incoming.ticket.continuation.sequenceDigest,
      },
    }))
    const commitTarget = jest.fn().mockRejectedValue(new Error("target commit interrupted"))
    await expect(completeInboundThreadHandoff(prepared!, { commitTarget })).rejects.toThrow(
      "target commit interrupted"
    )
    const accepted = (await getDb().threadHandoffTickets.get(["defaults", "target"]))!
    expect(accepted.state).toBe("accepted")
    await expect(resumeAcceptedThreadHandoff(accepted)).resolves.toMatchObject({
      state: "committed",
    })
    expect(mockIssueLease).toHaveBeenCalledWith(["thread_handoff_commit"])
    expect(mockCall).toHaveBeenCalledWith(
      "thread_handoff_commit",
      expect.objectContaining({ role: "source", adminLease: "lease" })
    )
    expect((await getDb().sessions.get("handoff-defaults"))?.handoffLock).toBeUndefined()
    expect((await getDb().sessions.get("handoff-defaults"))?.importCanonicalState?.goals).toEqual(
      incoming.envelope.goals
    )
    expect((await getDb().sessions.get("handoff-defaults"))?.branchSeed?.content).toContain(
      "Keep production unchanged"
    )
  })

  it("restores structured content with a frozen target, then resumes a lost source commit response", async () => {
    const offer = await buildThreadHandoffOffer(
      {
        id: "source",
        title: "Thread",
        createdAt: 1,
        updatedAt: 1,
        model: "target-model",
        providerOverride: "target-provider",
        workingDir: "/source/private",
      },
      { kind: "mobile", hostRef: "phone-1" },
      100,
      {
        ticketId: "retry",
        deployments: [],
        messages: [
          {
            id: "a",
            role: "assistant",
            parts: [
              { type: "text", text: "Answer" },
              { type: "reasoning", text: "Reason" },
            ],
          },
        ],
      }
    )
    const incoming = { ...offer, ticket: { ...offer.ticket, role: "target" as const } }
    const prepared = await prepareInboundThreadHandoff(incoming, "phone-1", {
      now: () => 150,
      environment: async () => ({
        capabilities: ["thread-handoff-v1", "thread-handoff-structured-v1"],
        hostOperations: [],
        providerRefs: ["target-provider"],
        models: ["target-model"],
        credentialProfileRefs: [],
        workspaceRefs: [],
        attachmentRefs: [],
        protocolVersion: 1,
        nativeRuntimeAvailable: false,
      }),
    })
    expect(prepared?.preflight.ok).toBe(true)
    const issueLease = jest.fn().mockResolvedValue({ token: "lease" })
    const commitSource = jest
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockImplementation(async (_id, proof) => ({
        proof: {
          ticketId: "retry",
          state: "committed",
          sourceHostRef: incoming.ticket.source.hostRef,
          sourceSessionId: "source",
          sequenceDigest: proof.sequenceDigest,
        },
      }))
    await expect(
      completeInboundThreadHandoff(prepared!, { now: () => 200, issueLease, commitSource })
    ).rejects.toThrow("response lost")
    const accepted = (await getDb().threadHandoffTickets.get(["retry", "target"]))!
    expect(accepted.state).toBe("accepted")
    expect((await getDb().sessions.get("handoff-retry"))?.handoffLock?.state).toBe("frozen")
    const target = await getDb().sessions.get("handoff-retry")
    expect(target?.model).toBe("target-model")
    expect(target?.providerOverride).toBe("target-provider")
    expect(target?.workingDir).toBeUndefined()
    expect((await getDb().messages.get("handoff-retry:a"))?.parts).toEqual(
      expect.arrayContaining([{ type: "reasoning", text: "Reason", state: "done" }])
    )
    await expect(
      resumeAcceptedThreadHandoff(accepted, { now: () => 300, issueLease, commitSource })
    ).resolves.toMatchObject({ state: "committed" })
    expect((await getDb().sessions.get("handoff-retry"))?.handoffLock).toBeUndefined()
    await expect(resumeAcceptedThreadHandoff({ ...accepted, state: "aborted" })).rejects.toThrow(
      "thread_handoff_target_not_accepted"
    )
  })
})
