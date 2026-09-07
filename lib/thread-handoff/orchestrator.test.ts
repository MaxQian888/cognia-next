/** @jest-environment jsdom */

import type { ChatSession } from "@cognia/agent-config-types"
import { validateThreadHandoffRefs } from "@cognia/agent-config-types/thread-handoff"

import "fake-indexeddb/auto"
import { getDb } from "@/lib/db/schema"
import { offerThreadHandoff } from "./service"
import {
  buildThreadHandoffOffer,
  recoverThreadHandoffOffer,
  startRemoteThreadHandoff,
  startThreadHandoff,
} from "./orchestrator"

const session: ChatSession = {
  id: "session-1",
  title: "Portable session",
  projectId: "workspace-1",
  providerOverride: "anthropic",
  model: "claude-sonnet",
  sdkSessionId: "native-session",
  permissionMode: "default",
  workingDir: "/Users/alice/private/project",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_001_000,
}

describe("buildThreadHandoffOffer", () => {
  it.each([
    [{ kind: "subscription-vault", providerId: "provider" }, "subscription-vault:provider"],
    [{ kind: "secret-store", secretId: "secret" }, "secret-store:secret"],
    [{ kind: "env", var: "API_KEY" }, "env:API_KEY"],
  ])(
    "preserves required credential references without transporting secrets: %s",
    async (credentialProfileRef, expected) => {
      const frame = await buildThreadHandoffOffer(
        {
          ...session,
          createdAt: undefined,
          updatedAt: undefined,
          providerOverride: "alias",
          systemPrompt: "Follow project rules",
          characterId: "character",
        } as never,
        { hostRef: "cloud", kind: "cloud" },
        1000,
        {
          messages: [
            { id: "sys", role: "system", parts: [{ type: "text", text: "Rules" }] },
          ] as never,
          deployments: [
            {
              id: "deployment",
              legacyProviderId: "alias",
              providerRef: "provider",
              credentialProfileRef,
              models: [],
            },
          ] as never,
        }
      )
      expect(frame.ticket.requirements.credentialProfileRefs).toEqual([expected])
      expect(frame.ticket.continuation).toMatchObject({
        systemPrompt: "Follow project rules",
        characterId: "character",
        seedTranscript: "System: Rules",
      })
      expect(frame.envelope.header.createdAt).toBe(new Date(1000).toISOString())
    }
  )

  it("selects model deployment when there is no provider override", async () => {
    const frame = await buildThreadHandoffOffer(
      { ...session, providerOverride: undefined },
      { hostRef: "phone", kind: "mobile" },
      1000,
      {
        messages: [],
        deployments: [
          { id: "d", providerRef: "p", models: [{ id: "different", upstreamId: session.model }] },
        ] as never,
      }
    )
    expect(frame.ticket.requirements.providerRefs).toEqual(["p", "d"])
  })

  it("refuses unsupported content instead of silently dropping it", async () => {
    await expect(
      buildThreadHandoffOffer(session, { hostRef: "phone", kind: "mobile" }, 1000, {
        deployments: [],
        messages: [
          { id: "u", role: "user", parts: [{ type: "custom-widget", payload: "important" }] },
        ] as never,
      })
    ).rejects.toThrow("thread_handoff_unsupported_content:turns[0].parts[0]")
  })
  it("preserves reasoning and completed tool results without promising native resume", async () => {
    const frame = await buildThreadHandoffOffer(
      session,
      { hostRef: "phone-1", kind: "mobile" },
      1000,
      {
        ticketId: "structured",
        deployments: [],
        messages: [
          {
            id: "a",
            role: "assistant",
            parts: [
              { type: "reasoning", text: "Reasoning" },
              { type: "text", text: "Result" },
              {
                type: "dynamic-tool",
                toolCallId: "call",
                toolName: "search",
                input: { query: "x" },
                output: "found",
                state: "output-available",
              },
            ],
          },
        ] as never,
      }
    )
    expect(frame.envelope.turns[0]).toMatchObject({
      reasoning: "Reasoning",
      toolCalls: [{ callId: "call", resultText: "found", status: "completed" }],
    })
    expect(frame.ticket.continuation.fidelity).toBe("contextual")
    expect(frame.ticket.continuation.sdkSessionId).toBeUndefined()
  })

  it("refuses a private portable copy of a server-authoritative shared conversation", async () => {
    await expect(
      buildThreadHandoffOffer(
        { ...session, collaboration: { sharedSessionId: "shared" } } as never,
        { hostRef: "phone-1", kind: "mobile" },
        1000,
        { deployments: [], messages: [] }
      )
    ).rejects.toThrow("thread_handoff_shared_session_requires_executor_transfer")
  })

  it("projects a canonical, path-free ticket with provider and credential requirements", async () => {
    const frame = await buildThreadHandoffOffer(
      session,
      { hostRef: "phone-1", kind: "mobile", label: "Phone" },
      1_700_000_002_000,
      {
        ticketId: "ticket-1",
        messages: [
          { id: "u1", role: "user", parts: [{ type: "text", text: "Hello" }] },
          { id: "a1", role: "assistant", parts: [{ type: "text", text: "Hi" }] },
        ] as never,
        deployments: [
          {
            id: "anthropic",
            providerRef: "provider-anthropic",
            endpoint: "https://api.anthropic.com",
            transportProfileRef: "transport-anthropic",
            legacyProviderId: "anthropic",
            credentialProfileRef: {
              kind: "legacy-provider-settings",
              providerId: "anthropic",
            },
            models: [{ id: "claude-sonnet" }],
          },
        ],
      }
    )

    expect(frame.ticket.requirements).toMatchObject({
      capabilities: ["thread-handoff-v1", "thread-handoff-structured-v1"],
      providerRefs: ["provider-anthropic", "anthropic"],
      models: ["claude-sonnet"],
      credentialProfileRefs: ["legacy-provider-settings:anthropic"],
    })
    expect(frame.envelope.turns.map((turn) => turn.text)).toEqual(["Hello", "Hi"])
    expect(frame.ticket.continuation.sequenceDigest).toBe(frame.envelope.header.sequenceDigest)
    expect(validateThreadHandoffRefs(frame.ticket)).toEqual([])
    expect(JSON.stringify(frame)).not.toContain(session.workingDir)
  })

  it("requires no provider when the session pinned neither a model nor an override", async () => {
    // `upstreamId` / `canonicalModelRef` are optional, so an unset
    // `session.model` used to `.includes(undefined)` its way into the first
    // deployment missing either — and the ticket then demanded a provider and
    // credential this session never used, which the target refuses.
    const unpinned: ChatSession = {
      ...session,
      model: undefined,
      providerOverride: undefined,
    }
    const frame = await buildThreadHandoffOffer(
      unpinned,
      { hostRef: "phone-1", kind: "mobile", label: "Phone" },
      1_700_000_002_000,
      {
        ticketId: "ticket-2",
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Hello" }] }] as never,
        deployments: [
          {
            id: "anthropic",
            providerRef: "provider-anthropic",
            endpoint: "https://api.anthropic.com",
            transportProfileRef: "transport-anthropic",
            legacyProviderId: "anthropic",
            credentialProfileRef: {
              kind: "legacy-provider-settings",
              providerId: "anthropic",
            },
            // No `upstreamId`, no `canonicalModelRef` — the shape that matched.
            models: [{ id: "claude-sonnet" }],
          },
        ],
      }
    )

    expect(frame.ticket.requirements.providerRefs).toEqual([])
    expect(frame.ticket.requirements.credentialProfileRefs).toEqual([])
    expect(frame.ticket.requirements.models).toEqual([])
  })

  it("rejects recovery unless the persisted source ticket is frozen and owns the session lock", async () => {
    await expect(
      recoverThreadHandoffOffer(session, {
        ticketVersion: 1,
        ticketId: "ticket-1",
        state: "preparing",
        role: "source",
        source: {
          hostRef: "local",
          kind: "desktop",
          sessionId: session.id,
          title: session.title,
          messageCount: 0,
        },
        target: { hostRef: "phone-1", kind: "mobile", label: "Phone" },
        transport: "companion",
        project: {},
        requirements: {
          capabilities: ["thread-handoff-v1", "thread-handoff-structured-v1"],
          hostOperations: [],
          providerRefs: [],
          models: [],
          credentialProfileRefs: [],
          minProtocolVersion: 1,
        },
        continuation: {
          sourceRuntime: "cognia",
          fidelity: "structured",
          sequenceDigest: "digest",
        },
        attachments: [],
        pendingApprovals: [],
        history: [],
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      })
    ).rejects.toThrow("thread_handoff_offer_not_recoverable")
  })
})

describe("remote Host handoff carrier", () => {
  beforeEach(async () => {
    await getDb().threadHandoffTickets.clear()
    await getDb().sessions.clear()
    await getDb().messages.clear()
  })

  it("commits source first and retries only the target unlock after its response fails", async () => {
    const localSession = { id: "source", title: "Remote handoff", createdAt: 1, updatedAt: 1 }
    await getDb().sessions.put(localSession)
    await getDb().messages.put({
      id: "m",
      sessionId: "source",
      role: "user",
      parts: [{ type: "text", text: "Hello" }],
      createdAt: 1,
    })
    let remoteTicket:
      import("@cognia/agent-config-types/thread-handoff").ThreadHandoffTicket | null = null
    let failCommit = true
    const calls: string[] = []
    const call = jest.fn(async (name: string, args?: Record<string, unknown>) => {
      calls.push(name)
      if (name === "thread_handoff_preflight")
        return { ok: true, blockers: [], achievableFidelity: "contextual", checkedAt: 1 }
      if (name === "host_admin_lease_issue") return { token: "lease" }
      if (name === "thread_handoff_accept") {
        remoteTicket = {
          ...(args!
            .ticket as import("@cognia/agent-config-types/thread-handoff").ThreadHandoffTicket),
          state: "accepted",
        }
        return {
          ticket: remoteTicket,
          proof: {
            ticketId: remoteTicket.ticketId,
            state: "accepted",
            targetHostRef: remoteTicket.target.hostRef,
            targetSessionId: remoteTicket.target.sessionId,
            sequenceDigest: remoteTicket.continuation.sequenceDigest,
          },
        }
      }
      if (name === "thread_handoff_commit") {
        expect((await getDb().sessions.get("source"))?.handoffLock?.state).toBe("committed")
        if (failCommit) {
          failCommit = false
          throw new Error("response lost")
        }
        return { ticket: { ...remoteTicket, state: "committed" }, proof: { state: "committed" } }
      }
      if (name === "thread_handoff_status") return remoteTicket
      throw new Error(`Unexpected ${name}`)
    })
    const close = jest.fn()
    const openTarget = jest.fn(async () => ({
      host: {},
      transport: { call, subscribe: () => () => {} },
      close,
    })) as never
    const target = { hostRef: "cloud", kind: "cloud" as const }
    await expect(
      startRemoteThreadHandoff(localSession, target, 100, { openTarget })
    ).rejects.toThrow("response lost")
    const frozen = (await getDb().sessions.get("source"))!
    const result = await startRemoteThreadHandoff(frozen, target, 200, { openTarget })
    expect(result.state).toBe("committed")
    expect(calls.filter((name) => name === "thread_handoff_accept")).toHaveLength(1)
    expect(calls.filter((name) => name === "thread_handoff_preflight")).toHaveLength(1)
    expect(close).toHaveBeenCalledTimes(2)
  })
})

describe("remote Host recovery failures", () => {
  beforeEach(async () => {
    await getDb().threadHandoffTickets.clear()
    await getDb().sessions.clear()
    await getDb().messages.clear()
  })

  it("durably queues mobile offers and can rebuild a failed delivery while frozen", async () => {
    const localSession = { id: "source", title: "Thread", createdAt: 1, updatedAt: 1 }
    await getDb().sessions.put(localSession)
    const frozen = await startThreadHandoff(localSession, { hostRef: "phone", kind: "mobile" })
    expect(frozen.state).toBe("frozen")
    await expect(
      recoverThreadHandoffOffer((await getDb().sessions.get("source"))!, frozen)
    ).resolves.toBeUndefined()
    await getDb().messages.put({
      id: "changed",
      sessionId: "source",
      role: "user",
      parts: [{ type: "text", text: "changed" }],
      createdAt: 1,
    })
    await expect(
      recoverThreadHandoffOffer((await getDb().sessions.get("source"))!, frozen)
    ).rejects.toThrow("source_digest_changed")
    await expect(recoverThreadHandoffOffer(localSession, frozen)).rejects.toThrow(
      "offer_not_recoverable"
    )
  })

  it("rejects shared sessions before opening a remote connection", async () => {
    const openTarget = jest.fn()
    await expect(
      startRemoteThreadHandoff(
        { ...session, collaboration: {} } as never,
        { hostRef: "cloud", kind: "cloud" },
        100,
        { openTarget }
      )
    ).rejects.toThrow("shared_session_requires_executor_transfer")
    expect(openTarget).not.toHaveBeenCalled()
  })

  it.each(["aborted", "committed", "recoverable"])(
    "does not import over a target in %s state",
    async (state) => {
      const localSession = { id: "source", title: "Thread", createdAt: 1, updatedAt: 1 }
      await getDb().sessions.put(localSession)
      const frame = await buildThreadHandoffOffer(
        localSession,
        { hostRef: "cloud", kind: "cloud" },
        Date.now()
      )
      const frozen = await offerThreadHandoff(frame.ticket)
      const call = jest.fn().mockResolvedValue({ ...frozen, role: "target", state })
      const close = jest.fn()
      const openTarget = jest.fn(async () => ({
        host: {},
        transport: { call, subscribe: () => () => {} },
        close,
      })) as never
      await expect(
        startRemoteThreadHandoff(
          (await getDb().sessions.get("source"))!,
          frozen.target,
          Date.now(),
          { openTarget }
        )
      ).rejects.toThrow("target_not_recoverable")
      expect(call.mock.calls.map(([name]) => name)).toEqual(["thread_handoff_status"])
      expect(close).toHaveBeenCalledTimes(1)
      expect((await getDb().sessions.get("source"))?.handoffLock?.state).toBe("frozen")
    }
  )

  it("rejects a changed transcript when retrying before acceptance", async () => {
    const localSession = { id: "source", title: "Thread", createdAt: 1, updatedAt: 1 }
    await getDb().sessions.put(localSession)
    const frame = await buildThreadHandoffOffer(
      localSession,
      { hostRef: "cloud", kind: "cloud" },
      Date.now()
    )
    const frozen = await offerThreadHandoff(frame.ticket)
    await getDb().messages.put({
      id: "unexpected",
      sessionId: "source",
      role: "user",
      parts: [{ type: "text", text: "unexpected external write" }],
      createdAt: 1,
    })
    const call = jest.fn().mockResolvedValue(null)
    const openTarget = jest.fn(async () => ({
      host: {},
      transport: { call, subscribe: () => () => {} },
      close: jest.fn(),
    })) as never
    await expect(
      startRemoteThreadHandoff((await getDb().sessions.get("source"))!, frozen.target, Date.now(), {
        openTarget,
      })
    ).rejects.toThrow("source_digest_changed")
    expect(call).toHaveBeenCalledTimes(1)
  })

  it("does not resurrect an aborted source after a delayed preflight", async () => {
    const localSession = { id: "source", title: "Thread", createdAt: 1, updatedAt: 1 }
    await getDb().sessions.put(localSession)
    const call = jest.fn(async () => {
      const rows = await getDb().threadHandoffTickets.toArray()
      await getDb().threadHandoffTickets.put({ ...rows[0], state: "aborted" })
      return { ok: true, blockers: [], achievableFidelity: "contextual", checkedAt: 1 }
    })
    const openTarget = jest.fn(async () => ({
      host: {},
      transport: { call, subscribe: () => () => {} },
      close: jest.fn(),
    })) as never
    await expect(
      startRemoteThreadHandoff(localSession, { hostRef: "cloud", kind: "cloud" }, Date.now(), {
        openTarget,
      })
    ).rejects.toThrow("offer_not_recoverable")
    expect(call).toHaveBeenCalledTimes(1)
    expect((await getDb().threadHandoffTickets.toArray())[0].state).toBe("aborted")
  })

  it("keeps the source frozen and records destination blockers without seeking consent or importing", async () => {
    const localSession = { id: "source", title: "Thread", createdAt: 1, updatedAt: 1 }
    await getDb().sessions.put(localSession)
    const call = jest.fn().mockResolvedValue({
      ok: false,
      blockers: [{ kind: "credential-missing", severity: "blocking", ref: "profile" }],
      achievableFidelity: "contextual",
      checkedAt: 1,
    })
    const close = jest.fn()
    const openTarget = jest.fn(async () => ({
      host: {},
      transport: { call, subscribe: () => () => {} },
      close,
    })) as never
    await expect(
      startRemoteThreadHandoff(localSession, { hostRef: "cloud", kind: "cloud" }, 100, {
        openTarget,
      })
    ).rejects.toThrow("thread_handoff_preflight_blocked")
    const lock = (await getDb().sessions.get("source"))?.handoffLock
    expect(lock?.state).toBe("frozen")
    expect(
      (await getDb().threadHandoffTickets.get([lock!.ticketId, "source"]))?.preflight?.blockers[0]
        .kind
    ).toBe("credential-missing")
    expect(call).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("reconciles an accepted target after a lost accept response without importing twice", async () => {
    const localSession = { id: "source", title: "Thread", createdAt: 1, updatedAt: 1 }
    await getDb().sessions.put(localSession)
    let remoteTicket:
      import("@cognia/agent-config-types/thread-handoff").ThreadHandoffTicket | null = null
    const call = jest.fn(async (name: string, args?: Record<string, unknown>) => {
      if (name === "thread_handoff_preflight")
        return { ok: true, blockers: [], achievableFidelity: "contextual", checkedAt: 1 }
      if (name === "host_admin_lease_issue") return { token: "lease" }
      if (name === "thread_handoff_accept") {
        remoteTicket = {
          ...(args!
            .ticket as import("@cognia/agent-config-types/thread-handoff").ThreadHandoffTicket),
          state: "accepted",
        }
        throw new Error("accept response lost")
      }
      if (name === "thread_handoff_status") return remoteTicket
      if (name === "thread_handoff_commit") return { proof: { state: "committed" } }
      throw new Error(name)
    })
    const openTarget = jest.fn(async () => ({
      host: {},
      transport: { call, subscribe: () => () => {} },
      close: jest.fn(),
    })) as never
    const target = { hostRef: "cloud", kind: "cloud" as const }
    await expect(
      startRemoteThreadHandoff(localSession, target, 100, { openTarget })
    ).rejects.toThrow("accept response lost")
    const source = (await getDb().sessions.get("source"))!
    expect(source.handoffLock?.state).toBe("frozen")
    await expect(
      startRemoteThreadHandoff(source, target, 200, { openTarget })
    ).resolves.toMatchObject({ state: "committed" })
    expect(call.mock.calls.filter(([name]) => name === "thread_handoff_accept")).toHaveLength(1)
  })

  it("refuses recovery to a different Host and always closes its isolated transport", async () => {
    const localSession = {
      id: "source",
      title: "Thread",
      createdAt: 1,
      updatedAt: 1,
      handoffLock: {
        ticketId: "missing",
        state: "frozen" as const,
        targetHostRef: "cloud-one",
        at: 1,
      },
    }
    const close = jest.fn()
    const openTarget = jest.fn(async () => ({
      host: {},
      transport: { call: jest.fn(), subscribe: () => () => {} },
      close,
    })) as never
    await expect(
      startRemoteThreadHandoff(localSession, { hostRef: "cloud-two", kind: "cloud" }, 100, {
        openTarget,
      })
    ).rejects.toThrow("thread_handoff_offer_not_recoverable")
    expect(close).toHaveBeenCalledTimes(1)
  })
})
