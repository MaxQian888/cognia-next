/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { webcrypto } from "node:crypto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { getWorkSubmission } from "@/lib/db/work-submissions"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"

import { settleChatTurnForSession } from "./chat-adapter"
import {
  abandonPairedChatTurn,
  admitPairedChatTurn,
  dispatchPairedTurnCommand,
  isPairedTurnCommand,
  PAIRED_TURN_LEASE_OWNER,
  type PairedTurnAdapterDeps,
} from "./paired-turn-adapter"

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true })
  }
})

const KEY = new Uint8Array(32).fill(21)
const NOW = 1_755_000_000_000

const heartbeat = jest.fn(() => () => {})

function deps(overrides: Partial<PairedTurnAdapterDeps> = {}): PairedTurnAdapterDeps {
  return { loadKey: async () => KEY, now: () => NOW, startHeartbeat: heartbeat, ...overrides }
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: "session-1",
    runId: "paired:request-1",
    prompt: "use my connection",
    messageId: "user-message-1",
    callerAccountId: "account-1",
    authoritativeHostId: "host-1",
    callerDeviceId: "browser-device",
    callerDeviceGrants: ["agent.control"],
    ...overrides,
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  heartbeat.mockClear()
  setActiveRuntimeTargetContext("account-1", "target-1")
  await getDb().sessions.put({
    id: "session-1",
    title: "New conversation",
    transcriptRevision: 0,
    createdAt: 1,
    updatedAt: 1,
  })
}, 30_000)

afterEach(() => {
  clearActiveRuntimeTargetContext()
})

describe("admitPairedChatTurn", () => {
  it("writes the user's message and holds an open, leased submission for the persister", async () => {
    await expect(admitPairedChatTurn(request(), deps())).resolves.toEqual({
      admitted: true,
      submissionId: "work:paired:request-1",
    })

    // The user's turn is on the Host under the client's own id, so the
    // transcript the client pages back lines up with what it showed.
    await expect(getDb().messages.get("user-message-1")).resolves.toMatchObject({
      sessionId: "session-1",
      role: "user",
      parts: [expect.objectContaining({ type: "text", text: "use my connection" })],
    })
    await expect(getWorkSubmission("work:paired:request-1")).resolves.toMatchObject({
      accountId: "account-1",
      runtimeTargetId: "target-1",
      sessionId: "session-1",
      sourceKind: "chat",
      dispatchState: "dispatched",
      leaseOwner: PAIRED_TURN_LEASE_OWNER,
    })
    expect(heartbeat).toHaveBeenCalledWith("work:paired:request-1")
  }, 30_000)

  it("never freezes the turn's options: no execution context is stored", async () => {
    await admitPairedChatTurn(
      request({ options: { providerCredentials: { apiKey: "browser-provider-key" } } }),
      deps()
    )
    const row = await getWorkSubmission("work:paired:request-1")
    expect(row?.contextBundleId).toBeUndefined()
    await expect(getDb().executionContextBundles.count()).resolves.toBe(0)
    const stored = JSON.stringify(await getDb().workInputBatches.toArray())
    expect(stored).not.toContain("browser-provider-key")
  }, 30_000)

  it("lets the existing persister settle the admitted turn and write the reply", async () => {
    await admitPairedChatTurn(request(), deps())
    const writeTranscript = jest.fn(async () => {})
    await expect(
      settleChatTurnForSession("session-1", { outcome: "completed", writeTranscript })
    ).resolves.toBe(true)
    expect(writeTranscript).toHaveBeenCalledTimes(1)
    await expect(getWorkSubmission("work:paired:request-1")).resolves.toMatchObject({
      dispatchState: "settled",
      terminalOutcome: "completed",
    })
  }, 30_000)

  it("re-sending a turn the session already holds writes no second user row", async () => {
    const commitUserMessage = jest.fn(async () => {})
    await getDb().messages.put({
      id: "user-message-1",
      sessionId: "session-1",
      role: "user",
      parts: [{ type: "text", text: "use my connection" }],
      createdAt: 1,
    } as never)
    await expect(
      admitPairedChatTurn(request(), deps({ commitUserMessage }))
    ).resolves.toMatchObject({ admitted: true })
    expect(commitUserMessage).not.toHaveBeenCalled()
  }, 30_000)

  it("names its own user row when the client sent no message id", async () => {
    await admitPairedChatTurn(request({ messageId: undefined }), deps())
    await expect(getDb().messages.get("paired:request-1:user")).resolves.toMatchObject({
      sessionId: "session-1",
      role: "user",
    })
  }, 30_000)

  it.each([
    ["a session the Host never created", { sessionId: "session-elsewhere" }, "session_not_found"],
    ["another account's pairing", { callerAccountId: "account-2" }, "host_state_scope_mismatch"],
  ])(
    "refuses %s, admitting nothing",
    async (_label, overrides, code) => {
      await expect(admitPairedChatTurn(request(overrides), deps())).resolves.toMatchObject({
        admitted: false,
        refusal: { code },
      })
      await expect(getDb().workSubmissions.count()).resolves.toBe(0)
      await expect(getDb().messages.count()).resolves.toBe(0)
    },
    30_000
  )

  it("refuses a turn on a conversation frozen for a handoff", async () => {
    await getDb().sessions.update("session-1", {
      handoffLock: { ticketId: "ticket-1", lockedAt: 1 },
    } as never)
    await expect(admitPairedChatTurn(request(), deps())).resolves.toMatchObject({
      admitted: false,
      refusal: { code: "session_handoff_locked" },
    })
  }, 30_000)

  it("refuses a message id that belongs to another conversation", async () => {
    await getDb().messages.put({
      id: "user-message-1",
      sessionId: "session-other",
      role: "user",
      parts: [],
      createdAt: 1,
    } as never)
    await expect(admitPairedChatTurn(request(), deps())).resolves.toMatchObject({
      admitted: false,
      refusal: { code: "host_state_message_id_exists" },
    })
  }, 30_000)

  it("stays out of the way on a Host with no runtime target, as local chat does", async () => {
    clearActiveRuntimeTargetContext()
    await expect(admitPairedChatTurn(request(), deps())).resolves.toEqual({
      admitted: false,
      untracked: true,
    })
    await expect(getDb().workSubmissions.count()).resolves.toBe(0)
  }, 30_000)

  it("rejects a malformed bridge request outright", async () => {
    await expect(admitPairedChatTurn(request({ runId: "" }), deps())).rejects.toThrow(
      "paired_turn_invalid_request"
    )
    await expect(admitPairedChatTurn(request({ prompt: 42 }), deps())).rejects.toThrow(
      "paired_turn_invalid_request"
    )
  }, 30_000)
})

describe("abandonPairedChatTurn", () => {
  it("seals an admitted turn the server could not hand to the runtime", async () => {
    await admitPairedChatTurn(request(), deps())
    await expect(
      abandonPairedChatTurn(
        { submissionId: "work:paired:request-1", errorCode: "sidecar_unavailable" },
        deps()
      )
    ).resolves.toEqual({ settled: true })
    await expect(getWorkSubmission("work:paired:request-1")).resolves.toMatchObject({
      dispatchState: "settled",
      terminalOutcome: "failed",
      errorCode: "sidecar_unavailable",
    })
    // Nothing is left open for the persister to attach a later turn's frames to.
    await expect(settleChatTurnForSession("session-1", { outcome: "completed" })).resolves.toBe(
      false
    )
  }, 30_000)
})

describe("command routing", () => {
  it("claims exactly its two internal bridge commands", () => {
    expect(isPairedTurnCommand("paired_turn_admit")).toBe(true)
    expect(isPairedTurnCommand("paired_turn_abandon")).toBe(true)
    expect(isPairedTurnCommand("agent_send")).toBe(false)
  })

  it("dispatches by command name", async () => {
    await expect(
      dispatchPairedTurnCommand("paired_turn_admit", request({ sessionId: "missing" }))
    ).resolves.toMatchObject({ admitted: false, refusal: { code: "session_not_found" } })
    await expect(
      dispatchPairedTurnCommand("paired_turn_abandon", { submissionId: "work:none" })
    ).resolves.toEqual({ settled: false })
  }, 30_000)
})
