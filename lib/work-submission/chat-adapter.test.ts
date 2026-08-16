/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { webcrypto } from "node:crypto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { commitMessageDelta } from "@/lib/db/messages"
import {
  getExecutionContextBundle,
  getWorkSubmission,
  listClaimableWorkSubmissions,
} from "@/lib/db/work-submissions"

import {
  acceptChatTurn,
  bindChatTurnContext,
  chatIdempotencyKey,
  chatSubmissionId,
  claimChatTurnForDispatch,
  markChatTurnStarted,
  settleChatTurn,
  settleChatTurnForSession,
  type ChatAdapterDeps,
} from "./chat-adapter"

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true })
  }
})

const NOW = 1_755_000_000_000
const KEY = new Uint8Array(32).fill(11)

function deps(overrides: Partial<ChatAdapterDeps> = {}): ChatAdapterDeps {
  return {
    isEnabled: () => true,
    resolveScope: () => ({ accountId: "account-1", runtimeTargetId: "target-1" }),
    loadKey: async () => KEY,
    ...overrides,
  }
}

const turn = {
  sessionId: "session-1",
  runId: "run-1",
  messageId: "message-1",
  content: "what changed?",
  visibleMessageIds: ["message-1"],
  now: NOW,
}

describe("identity helpers", () => {
  it("keys idempotency on the message, so a resend is the same work", () => {
    expect(chatIdempotencyKey("session-1", "message-1")).toBe("chat:session-1:message-1")
  })

  it("derives the submission id from the run id", () => {
    expect(chatSubmissionId("run-1")).toBe("work:run-1")
  })
})

describe("acceptChatTurn", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  }, 30_000)

  it("accepts the turn and records the submission", async () => {
    const receipt = await acceptChatTurn(turn, deps())

    expect(receipt).toMatchObject({ submissionId: "work:run-1", runId: "run-1", state: "accepted" })
    expect(await getWorkSubmission("work:run-1")).toMatchObject({
      sourceKind: "chat",
      accountId: "account-1",
      runtimeTargetId: "target-1",
      availabilityPolicy: "wait",
    })
  }, 30_000)

  it("runs the transcript write inside the acceptance transaction", async () => {
    const writeTranscript = jest.fn(async () => {})
    await acceptChatTurn({ ...turn, writeTranscript }, deps())
    expect(writeTranscript).toHaveBeenCalledTimes(1)
  }, 30_000)

  it("commits a real user message atomically with the submission", async () => {
    // Exercises the production write, not a stub: `commitMessageDelta` reaches
    // `messageMedia`, `settings` and `projects` transitively, and a Dexie
    // sub-transaction may only narrow its parent's scope — so this fails if the
    // acceptance transaction under-declares what it locks.
    await getDb().sessions.put({
      id: "session-1",
      title: "T",
      createdAt: NOW,
      updatedAt: NOW,
    } as never)

    await acceptChatTurn(
      {
        ...turn,
        writeTranscript: () =>
          commitMessageDelta("session-1", {
            upserts: [
              {
                id: "message-1",
                role: "user",
                parts: [{ type: "text", text: "what changed?" }],
              } as never,
            ],
          }),
      },
      deps()
    )

    expect(await getDb().messages.get("message-1")).toMatchObject({ sessionId: "session-1" })
    expect(await getWorkSubmission("work:run-1")).toBeDefined()
  }, 30_000)

  it("rolls the user message back when the submission cannot be written", async () => {
    // The guarantee stated the other way round: no visible message without a
    // record of the work that owes it an answer.
    await getDb().sessions.put({
      id: "session-1",
      title: "T",
      createdAt: NOW,
      updatedAt: NOW,
    } as never)
    // A run id collision makes the submission write fail mid-transaction.
    await getDb().executionRuns.add({
      id: "run-1",
      kind: "agent-turn",
      sourceId: "pre-existing",
      title: "clash",
      status: "queued",
      currentRevision: 0,
      startedAt: NOW,
      updatedAt: NOW,
    })

    await expect(
      acceptChatTurn(
        {
          ...turn,
          writeTranscript: () =>
            commitMessageDelta("session-1", {
              upserts: [
                {
                  id: "message-ghost",
                  role: "user",
                  parts: [{ type: "text", text: "should not survive" }],
                } as never,
              ],
            }),
        },
        deps()
      )
    ).rejects.toThrow()

    expect(await getDb().messages.get("message-ghost")).toBeUndefined()
    expect(await getWorkSubmission("work:run-1")).toBeUndefined()
  }, 30_000)

  it("returns null and writes nothing when the feature is off", async () => {
    // With the flag off the chat path must be byte-for-byte what it is today.
    const writeTranscript = jest.fn(async () => {})
    const receipt = await acceptChatTurn(
      { ...turn, writeTranscript },
      deps({ isEnabled: () => false })
    )
    expect(receipt).toBeNull()
    expect(writeTranscript).not.toHaveBeenCalled()
    expect(await getDb().workSubmissions.count()).toBe(0)
  }, 30_000)

  it("returns null when no runtime target is active", async () => {
    const receipt = await acceptChatTurn(turn, deps({ resolveScope: () => null }))
    expect(receipt).toBeNull()
    expect(await getDb().workSubmissions.count()).toBe(0)
  }, 30_000)

  it("returns the same receipt for a resent message", async () => {
    const first = await acceptChatTurn(turn, deps())
    const writeTranscript = jest.fn(async () => {})
    const second = await acceptChatTurn({ ...turn, writeTranscript }, deps())

    expect(second).toEqual(first)
    expect(writeTranscript).not.toHaveBeenCalled()
    expect(await getDb().workSubmissions.count()).toBe(1)
  }, 30_000)

  it("carries the project id onto the submission", async () => {
    await acceptChatTurn({ ...turn, projectId: "project-1" }, deps())
    expect((await getWorkSubmission("work:run-1"))?.projectId).toBe("project-1")
  }, 30_000)

  it("parks the turn as blocked when the host is away", async () => {
    const receipt = await acceptChatTurn({ ...turn, targetAvailable: false }, deps())
    expect(receipt?.state).toBe("blocked")
  }, 30_000)

  it("reports a rejection and falls back rather than losing the user's message", async () => {
    // Refusing to send because a ledger insert failed would be worse than
    // running the turn the legacy way.
    const onError = jest.fn()
    const receipt = await acceptChatTurn({ ...turn, sessionId: "" }, deps({ onError }))
    expect(receipt).toBeNull()
    expect(onError).toHaveBeenCalled()
  }, 30_000)

  it("propagates an unexpected failure instead of silently dropping the turn", async () => {
    const onError = jest.fn()
    await expect(
      acceptChatTurn(
        turn,
        deps({
          onError,
          loadKey: async () => {
            throw new Error("vault locked")
          },
        })
      )
    ).rejects.toThrow("vault locked")
    expect(onError).toHaveBeenCalled()
  }, 30_000)

  it("uses the live flag when none is injected", async () => {
    // Production wiring: with nothing injected the adapter reads the real flag,
    // which is off by default, so it must decline.
    expect(await acceptChatTurn(turn, { loadKey: async () => new Uint8Array(32) })).toBeNull()
  }, 30_000)

  it("reads the live runtime target when no scope is injected", async () => {
    clearActiveRuntimeTargetContext()
    // No active target: the real resolver returns null and the adapter declines
    // instead of inventing an account to attribute the work to.
    expect(
      await acceptChatTurn(turn, { isEnabled: () => true, loadKey: async () => KEY })
    ).toBeNull()

    setActiveRuntimeTargetContext("account-1", "target-1")
    try {
      const receipt = await acceptChatTurn(turn, {
        isEnabled: () => true,
        loadKey: async () => KEY,
      })
      expect(receipt).toMatchObject({ submissionId: "work:run-1" })
      expect(await getWorkSubmission("work:run-1")).toMatchObject({
        accountId: "account-1",
        runtimeTargetId: "target-1",
      })
    } finally {
      clearActiveRuntimeTargetContext()
    }
  }, 30_000)
})

describe("bindChatTurnContext", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    await acceptChatTurn(turn, deps())
  }, 30_000)

  it("freezes the context and labels the spec as shadow", async () => {
    const bound = await bindChatTurnContext(
      {
        runId: "run-1",
        context: { cwd: "/srv/project", projectId: "project-1" },
        executionFingerprint: "aexf1-abc",
        now: NOW + 1,
      },
      deps()
    )

    expect(bound).toBe(true)
    expect(await getWorkSubmission("work:run-1")).toMatchObject({
      contextBundleId: "context:run-1",
      executionFingerprint: "aexf1-abc",
      // Chat still routes the legacy way, so the frozen spec is an observation.
      specAuthority: "shadow",
    })
  }, 30_000)

  it("keeps the absolute cwd out of the queryable row", async () => {
    await bindChatTurnContext(
      { runId: "run-1", context: { cwd: "/Users/me/private" }, now: NOW + 1 },
      deps()
    )
    const row = await getExecutionContextBundle("work:run-1")
    expect(JSON.stringify({ ...row, envelope: undefined })).not.toContain("/Users/me")
  }, 30_000)

  it("is write-once, so a retry keeps the original context", async () => {
    await bindChatTurnContext(
      { runId: "run-1", context: { projectId: "project-1" }, now: NOW + 1 },
      deps()
    )
    const second = await bindChatTurnContext(
      { runId: "run-1", context: { projectId: "project-moved" }, now: NOW + 2 },
      deps()
    )
    expect(second).toBe(false)
    expect((await getExecutionContextBundle("work:run-1"))?.projectId).toBe("project-1")
  }, 30_000)

  it("returns false when the feature is off", async () => {
    const bound = await bindChatTurnContext(
      { runId: "run-1", context: {}, now: NOW + 1 },
      deps({ isEnabled: () => false })
    )
    expect(bound).toBe(false)
  }, 30_000)

  it("returns false rather than interrupting a turn whose submission is missing", async () => {
    const onError = jest.fn()
    const bound = await bindChatTurnContext(
      { runId: "run-unknown", context: {}, now: NOW + 1 },
      deps({ onError })
    )
    expect(bound).toBe(false)
    expect(onError).toHaveBeenCalled()
  }, 30_000)
})

describe("settleChatTurn", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    await acceptChatTurn(turn, deps())
  }, 30_000)

  it("seals the turn and reports that this caller won", async () => {
    expect(
      await settleChatTurn({ runId: "run-1", outcome: "completed", now: NOW + 5 }, deps())
    ).toBe(true)
    expect(await getWorkSubmission("work:run-1")).toMatchObject({
      dispatchState: "settled",
      terminalOutcome: "completed",
    })
  }, 30_000)

  it("writes the assistant message exactly once across all four terminal paths", async () => {
    // claude-chat-events.ts can observe a turn ending in four places; only the
    // first may persist the reply.
    const writeTranscript = jest.fn(async () => {})
    const outcomes = ["completed", "failed", "cancelled", "no_response"] as const
    const results: boolean[] = []
    for (const outcome of outcomes) {
      results.push(
        await settleChatTurn({ runId: "run-1", outcome, writeTranscript, now: NOW + 1 }, deps())
      )
    }
    expect(results).toEqual([true, false, false, false])
    expect(writeTranscript).toHaveBeenCalledTimes(1)
  }, 30_000)

  it("records an error code on failure", async () => {
    await settleChatTurn(
      { runId: "run-1", outcome: "failed", errorCode: "sidecar_exit", now: NOW + 1 },
      deps()
    )
    expect((await getWorkSubmission("work:run-1"))?.errorCode).toBe("sidecar_exit")
  }, 30_000)

  it("returns false when the feature is off", async () => {
    expect(
      await settleChatTurn(
        { runId: "run-1", outcome: "completed" },
        deps({ isEnabled: () => false })
      )
    ).toBe(false)
  }, 30_000)

  it("seals the open turn when only the session id is known", async () => {
    expect(
      await settleChatTurnForSession("session-1", { outcome: "completed", now: NOW + 5 }, deps())
    ).toBe(true)
    expect((await getWorkSubmission("work:run-1"))?.terminalOutcome).toBe("completed")
  }, 30_000)

  it("returns false when the session has no open turn", async () => {
    await settleChatTurnForSession("session-1", { outcome: "completed", now: NOW + 1 }, deps())
    // Already settled: a second terminal event finds nothing open.
    expect(
      await settleChatTurnForSession("session-1", { outcome: "failed", now: NOW + 2 }, deps())
    ).toBe(false)
    expect(
      await settleChatTurnForSession("session-unknown", { outcome: "completed" }, deps())
    ).toBe(false)
  }, 30_000)

  it("returns false for a session lookup when the feature is off", async () => {
    expect(
      await settleChatTurnForSession(
        "session-1",
        { outcome: "completed" },
        deps({ isEnabled: () => false })
      )
    ).toBe(false)
  }, 30_000)

  it("reports a session-lookup failure rather than throwing into the event loop", async () => {
    const onError = jest.fn()
    const spy = jest.spyOn(getDb().workSubmissions, "orderBy").mockImplementation(() => {
      throw new Error("index gone")
    })
    try {
      expect(
        await settleChatTurnForSession("session-1", { outcome: "completed" }, deps({ onError }))
      ).toBe(false)
      expect(onError).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  }, 30_000)

  it("reports a settle failure without throwing into the event loop", async () => {
    const onError = jest.fn()
    const settled = await settleChatTurn(
      {
        runId: "run-1",
        outcome: "completed",
        writeTranscript: async () => {
          throw new Error("transcript write failed")
        },
      },
      deps({ onError })
    )
    expect(settled).toBe(false)
    expect(onError).toHaveBeenCalled()
    // The submission must stay open so recovery can still reach it.
    expect((await getWorkSubmission("work:run-1"))?.dispatchState).not.toBe("settled")
  }, 30_000)
})

describe("markChatTurnStarted", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    await acceptChatTurn(turn, deps())
  }, 30_000)

  it("records a successful live handoff so the outbox cannot dispatch it again", async () => {
    expect(await markChatTurnStarted("run-1", NOW + 1, deps())).toBe(true)
    expect(await getWorkSubmission("work:run-1")).toMatchObject({
      dispatchState: "dispatched",
    })
    expect(await listClaimableWorkSubmissions(NOW + 60_000)).toEqual([])
  }, 30_000)

  it("does nothing when durable submission is disabled", async () => {
    expect(await markChatTurnStarted("run-1", NOW + 1, deps({ isEnabled: () => false }))).toBe(
      false
    )
    expect((await getWorkSubmission("work:run-1"))?.dispatchState).toBe("pending")
  }, 30_000)
})

describe("claimChatTurnForDispatch", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    await acceptChatTurn(turn, deps())
  }, 30_000)

  it("gives exactly one live sender ownership of the accepted turn", async () => {
    expect(await claimChatTurnForDispatch("run-1", NOW + 1, deps())).toBe("claimed")
    expect(await claimChatTurnForDispatch("run-1", NOW + 1, deps())).toBe("owned_elsewhere")
  }, 30_000)

  it("preserves the legacy send path when durable submission is disabled", async () => {
    expect(await claimChatTurnForDispatch("run-1", NOW + 1, deps({ isEnabled: () => false }))).toBe(
      "legacy"
    )
  }, 30_000)
})
