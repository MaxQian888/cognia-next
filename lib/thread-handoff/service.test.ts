/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { computeSequenceDigest } from "@cognia/agent-config-types/canonical-session"
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
      sequenceDigest: computeSequenceDigest([{ turnId: "turn-1", role: "user", text: "hello" }]),
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
  header: {
    canonicalVersion: 1,
    canonicalSessionId: "canonical-source",
    sourceRuntime: "ai-sdk",
    importFidelity: "structured",
    title: "Thread",
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    turnCount: 1,
    sequenceDigest: computeSequenceDigest([{ turnId: "turn-1", role: "user", text: "hello" }]),
  },
  turns: [{ turnId: "turn-1", role: "user", text: "hello" }],
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

  it("rejects invalid roles, non-preparing offers, missing sources and shared or competing ownership", async () => {
    await expect(offerThreadHandoff(ticket({ role: "target" }))).rejects.toThrow(
      "requires source role"
    )
    await expect(offerThreadHandoff(ticket({ state: "frozen" }))).rejects.toThrow(
      "requires a preparing ticket"
    )
    await expect(offerThreadHandoff(ticket({ ticketVersion: 999 } as never))).rejects.toThrow(
      "invalid thread handoff ticket"
    )
    await getDb().sessions.delete("session-source")
    await expect(offerThreadHandoff(ticket())).rejects.toThrow("source_session_not_found")
    await getDb().sessions.put({
      id: "session-source",
      title: "Shared",
      createdAt: 1,
      updatedAt: 1,
      collaboration: { sharedSessionId: "shared" },
    } as never)
    await expect(offerThreadHandoff(ticket())).rejects.toThrow(
      "shared_session_requires_executor_transfer"
    )
    await getDb().sessions.update("session-source", {
      collaboration: undefined,
      handoffLock: { ticketId: "other", state: "frozen", targetHostRef: "other", at: 1 },
    })
    await expect(offerThreadHandoff(ticket())).rejects.toThrow("source_already_locked")
  })

  it("reports missing protocol, workspace, provider and model, and cannot fake native continuation without a seed", () => {
    const base = ticket()
    const result = preflightThreadHandoff(
      {
        ...base,
        continuation: { ...base.continuation, seedTranscript: undefined },
        requirements: { ...base.requirements, hostOperations: [{ feature: "chat" }] },
      },
      {
        capabilities: [],
        hostOperations: [],
        providerRefs: [],
        models: [],
        credentialProfileRefs: [],
        workspaceRefs: [],
        attachmentRefs: [],
        protocolVersion: 0,
        nativeRuntimeAvailable: false,
      }
    )
    expect(result.achievableFidelity).toBe("unsupported")
    expect(result.blockers.map((b) => b.kind)).toEqual(
      expect.arrayContaining([
        "protocol-incompatible",
        "workspace-unavailable",
        "provider-unavailable",
        "model-unavailable",
      ])
    )
    const native = preflightThreadHandoff(
      { ...base, requirements: { ...base.requirements, hostOperations: [{ feature: "chat" }] } },
      {
        capabilities: ["agent-runtime"],
        hostOperations: [{ feature: "chat", operation: "send" }],
        providerRefs: ["provider-openai"],
        models: ["gpt-x"],
        credentialProfileRefs: ["credential-main"],
        workspaceRefs: ["workspace-main"],
        attachmentRefs: [],
        protocolVersion: 1,
        nativeRuntimeAvailable: true,
      }
    )
    expect(native).toMatchObject({ ok: true, achievableFidelity: "native-exact" })
  })

  it("refuses expired or unapproved acceptance before importing", async () => {
    const importSession = jest.fn()
    await expect(
      acceptThreadHandoff({ ticket: ticket(), envelope }, { importSession })
    ).rejects.toThrow("requires target role")
    await expect(
      acceptThreadHandoff({ ticket: ticket({ role: "target" }), envelope }, { importSession })
    ).rejects.toThrow("preflight_blocked")
    await expect(
      acceptThreadHandoff(
        {
          ticket: ticket({
            role: "target",
            preflight: { ok: true, blockers: [], achievableFidelity: "contextual", checkedAt: 1 },
          }),
          envelope,
        },
        { importSession }
      )
    ).rejects.toThrow("offer_expired")
    expect(importSession).not.toHaveBeenCalled()
  })

  it.each(["missing", "aborted", "accepted", "committed", "no-session"])(
    "recovers or refuses an import interrupted by %s state without granting a new writer",
    async (state) => {
      const incoming = ticket({
        role: "target",
        target: { hostRef: "host-target", kind: "cloud", sessionId: "target" },
        preflight: { ok: true, blockers: [], achievableFidelity: "contextual", checkedAt: 1 },
      })
      const run = acceptThreadHandoff(
        { ticket: incoming, envelope },
        {
          now: 200,
          importSession: async () => {
            if (state === "missing")
              await getDb().threadHandoffTickets.delete([incoming.ticketId, "target"])
            else if (state !== "no-session")
              await getDb().threadHandoffTickets.put({
                ...incoming,
                state: state as ThreadHandoffTicket["state"],
              })
          },
        }
      )
      if (state === "accepted" || state === "committed")
        await expect(run).resolves.toMatchObject({ ticket: { state } })
      else await expect(run).rejects.toThrow()
      expect(await getDb().sessions.get("target")).toBeUndefined()
    }
  )

  it.each(["accepted", "committed"])(
    "deduplicates acceptance of a persisted %s target and rejects changed identity",
    async (state) => {
      const incoming = ticket({
        role: "target",
        state: state as ThreadHandoffTicket["state"],
        target: { hostRef: "host-target", kind: "cloud", sessionId: "target" },
        preflight: { ok: true, blockers: [], achievableFidelity: "contextual", checkedAt: 1 },
      })
      await getDb().threadHandoffTickets.put(incoming)
      const importSession = jest.fn()
      await expect(
        acceptThreadHandoff({ ticket: incoming, envelope }, { now: 200, importSession })
      ).resolves.toMatchObject({ proof: { targetSessionId: "target" } })
      await expect(
        acceptThreadHandoff(
          {
            ticket: { ...incoming, target: { ...incoming.target, hostRef: "impostor" } },
            envelope,
          },
          { now: 200, importSession }
        )
      ).rejects.toThrow("identity_mismatch")
      expect(importSession).not.toHaveBeenCalled()
    }
  )

  it("requires matching proofs, returns committed replays, and deletes an abandoned accepted copy before source abort", async () => {
    await expect(
      commitThreadHandoff({ ticketId: "missing", role: "target", sourceCommitProof: {} as never })
    ).rejects.toThrow("not_found")
    await expect(abortThreadHandoff({ ticketId: "missing", role: "source" })).rejects.toThrow(
      "not_found"
    )
    const source = await offerThreadHandoff(ticket(), 200)
    await expect(
      commitThreadHandoff({ ticketId: source.ticketId, role: "source", acceptedProof: {} as never })
    ).rejects.toThrow("accepted_proof_invalid")
    const target = {
      ...source,
      role: "target" as const,
      state: "accepted" as const,
      target: { ...source.target, sessionId: "target" },
    }
    await getDb().threadHandoffTickets.put(target)
    await getDb().sessions.put({ id: "target", title: "Frozen", createdAt: 1, updatedAt: 1 })
    await getDb().messages.put({
      id: "t",
      sessionId: "target",
      role: "user",
      parts: [],
      createdAt: 1,
    })
    await expect(
      commitThreadHandoff({
        ticketId: target.ticketId,
        role: "target",
        sourceCommitProof: {} as never,
      })
    ).rejects.toThrow("commit_proof_invalid")
    await expect(abortThreadHandoff({ ticketId: target.ticketId, role: "target" })).rejects.toThrow(
      "copy was deleted"
    )
    const aborted = await abortThreadHandoff({
      ticketId: target.ticketId,
      role: "target",
      peerDisposition: "deleted",
    })
    expect(await getDb().sessions.get("target")).toBeUndefined()
    expect(await getDb().messages.get("t")).toBeUndefined()
    expect(await abortThreadHandoff({ ticketId: target.ticketId, role: "target" })).toEqual(aborted)
    for (const role of ["source", "target"] as const) {
      await getDb().threadHandoffTickets.put({ ...source, role, state: "committed" })
      await expect(
        commitThreadHandoff({
          ticketId: source.ticketId,
          role,
          acceptedProof: {} as never,
          sourceCommitProof: {} as never,
        } as never)
      ).resolves.toMatchObject({ ticket: { state: "committed" } })
      await expect(abortThreadHandoff({ ticketId: source.ticketId, role })).rejects.toThrow()
    }
  })

  it("rejects tampered canonical history before creating a target or invoking its importer", async () => {
    const importSession = jest.fn()
    await expect(
      acceptThreadHandoff(
        {
          ticket: ticket({
            role: "target",
            preflight: { ok: true, blockers: [], achievableFidelity: "contextual", checkedAt: 1 },
          }),
          envelope: { ...envelope, turns: [{ ...envelope.turns[0], text: "changed" }] },
        },
        { importSession, now: 200 }
      )
    ).rejects.toThrow("thread_handoff_envelope_integrity_failed")
    expect(importSession).not.toHaveBeenCalled()
    expect(await getDb().threadHandoffTickets.count()).toBe(0)
  })

  it("requires verified attachment availability for every carriage mode", () => {
    const result = preflightThreadHandoff(
      ticket({
        attachments: [
          {
            attachmentId: "image",
            filename: "image.png",
            mediaType: "image/png",
            byteLength: 3,
            digest: "a".repeat(64),
            carriage: "inline",
          },
        ],
      }),
      {
        capabilities: ["agent-runtime"],
        hostOperations: [{ feature: "chat", operation: "send" }],
        providerRefs: ["provider-openai"],
        models: ["gpt-x"],
        credentialProfileRefs: ["credential-main"],
        workspaceRefs: ["workspace-main"],
        attachmentRefs: [],
        protocolVersion: 1,
        nativeRuntimeAvailable: false,
      }
    )
    expect(result.ok).toBe(false)
    expect(result.blockers).toContainEqual({
      kind: "attachment-unresolvable",
      ref: "image",
      severity: "blocking",
    })
  })

  it("does not revive an aborted target when a delayed acceptance arrives", async () => {
    const inputTicket = ticket({
      role: "target",
      state: "aborted",
      preflight: { ok: true, blockers: [], achievableFidelity: "contextual", checkedAt: 1 },
    })
    await getDb().threadHandoffTickets.put(inputTicket)
    const importSession = jest.fn()
    await expect(
      acceptThreadHandoff(
        { ticket: { ...inputTicket, state: "preparing" }, envelope },
        { importSession, now: 200 }
      )
    ).rejects.toThrow()
    expect(importSession).not.toHaveBeenCalled()
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
      sourceCommitProof: source.proof as import("./service").SourceCommitProof,
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
