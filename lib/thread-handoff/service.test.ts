/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import type { CanonicalSession } from "@cognia/agent-config-types/canonical-session"
import type { ThreadHandoffTicket } from "@cognia/agent-config-types/thread-handoff"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  acceptThreadHandoff,
  abortThreadHandoff,
  commitThreadHandoff,
  offerThreadHandoff,
  preflightThreadHandoff,
} from "./service"

function ticket(overrides: Partial<ThreadHandoffTicket> = {}): ThreadHandoffTicket {
  return {
    ticketVersion: 1,
    ticketId: "ticket-1",
    role: "source",
    state: "preparing",
    source: {
      hostRef: "host-source",
      kind: "desktop",
      sessionId: "session-source",
      title: "Thread",
      messageCount: 1,
    },
    target: { hostRef: "host-target", kind: "cloud" },
    transport: "remote-host",
    project: { workspaceRef: "workspace-main" },
    requirements: {
      capabilities: ["agent-runtime"],
      hostOperations: [{ feature: "chat", operation: "send" }],
      providerRefs: ["provider-openai"],
      models: ["gpt-x"],
      credentialProfileRefs: ["credential-main"],
      minProtocolVersion: 1,
    },
    continuation: {
      sourceRuntime: "ai-sdk",
      sdkSessionId: "sdk-source",
      fidelity: "native-exact",
      sequenceDigest: "a".repeat(64),
      seedTranscript: "User: hello",
    },
    attachments: [],
    pendingApprovals: [],
    history: [{ state: "preparing", at: 100 }],
    createdAt: 100,
    updatedAt: 100,
    expiresAt: 10_000,
    ...overrides,
  }
}

const envelope: CanonicalSession = {
  schemaVersion: 1,
  header: {
    sessionId: "canonical-source",
    sourceRuntime: "ai-sdk",
    importFidelity: "structured",
    title: "Thread",
    createdAt: "2026-08-28T00:00:00.000Z",
  },
  turns: [{ turnId: "turn-1", role: "user", text: "hello" }],
  permissions: [],
  checkpoints: [],
  losses: [],
}

describe("thread handoff ownership protocol", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    await getDb().sessions.put({
      id: "session-source",
      title: "Thread",
      createdAt: 1,
      updatedAt: 1,
    })
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("atomically freezes the source and makes offer replay idempotent", async () => {
    const offered = await offerThreadHandoff(ticket(), 200)
    const replay = await offerThreadHandoff(ticket(), 300)

    expect(replay).toEqual(offered)
    expect(offered.state).toBe("frozen")
    await expect(getDb().sessions.get("session-source")).resolves.toMatchObject({
      handoffLock: { ticketId: "ticket-1", state: "frozen" },
    })
  })

  it("reports blockers and an honest transcript-seeded fidelity downgrade", () => {
    const result = preflightThreadHandoff(
      ticket(),
      {
        capabilities: [],
        hostOperations: [],
        providerRefs: ["provider-openai"],
        models: ["gpt-x"],
        credentialProfileRefs: [],
        workspaceRefs: ["workspace-main"],
        attachmentRefs: [],
        protocolVersion: 1,
        nativeRuntimeAvailable: false,
      },
      500
    )

    expect(result.ok).toBe(false)
    expect(result.achievableFidelity).toBe("contextual")
    expect(result.blockers.map((blocker) => blocker.kind)).toEqual(
      expect.arrayContaining(["capability-missing", "host-operation-missing", "credential-missing"])
    )
  })

  it("imports a target read-only, commits source first, then unlocks the target", async () => {
    const offered = await offerThreadHandoff(ticket(), 200)
    const accepted = await acceptThreadHandoff(
      {
        ticket: {
          ...offered,
          role: "target",
          target: { ...offered.target, sessionId: "session-target" },
          preflight: {
            ok: true,
            blockers: [],
            achievableFidelity: "structured",
            checkedAt: 300,
          },
        },
        envelope,
      },
      {
        now: 400,
        importSession: async (_envelope, sessionId) => {
          await getDb().sessions.put({
            id: sessionId,
            title: "Thread",
            createdAt: 400,
            updatedAt: 400,
          })
        },
      }
    )
    expect(accepted.ticket.state).toBe("accepted")
    await expect(getDb().sessions.get("session-target")).resolves.toMatchObject({
      handoffLock: { ticketId: "ticket-1", state: "frozen" },
    })

    const source = await commitThreadHandoff({
      ticketId: "ticket-1",
      role: "source",
      at: 500,
      acceptedProof: accepted.proof,
    })
    expect(source.ticket.state).toBe("committed")
    await expect(getDb().sessions.get("session-source")).resolves.toMatchObject({
      handoffLock: { ticketId: "ticket-1", state: "committed" },
    })

    const target = await commitThreadHandoff({
      ticketId: "ticket-1",
      role: "target",
      at: 600,
      sourceCommitProof: source.proof,
    })
    expect(target.ticket.state).toBe("committed")
    expect((await getDb().sessions.get("session-target"))?.handoffLock).toBeUndefined()
  })

  it("never unfreezes a source without proof that the target did not accept", async () => {
    await offerThreadHandoff(ticket(), 200)
    await expect(
      abortThreadHandoff({ ticketId: "ticket-1", role: "source", at: 300 })
    ).rejects.toThrow(/proof/i)
    expect((await getDb().sessions.get("session-source"))?.handoffLock?.state).toBe("frozen")

    await expect(
      abortThreadHandoff({
        ticketId: "ticket-1",
        role: "source",
        at: 400,
        peerDisposition: "not-accepted",
      })
    ).resolves.toMatchObject({ state: "aborted" })
    expect((await getDb().sessions.get("session-source"))?.handoffLock).toBeUndefined()
  })
})
