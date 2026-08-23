/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { webcrypto } from "node:crypto"

import {
  type AllowedHostStateIntent,
  type HostStateAction,
} from "@cognia/agent-config-types/host-state"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { getWorkSubmission } from "@/lib/db/work-submissions"

import { chatIdempotencyKey } from "./chat-adapter"
import {
  acceptHostStateChatTurn,
  bindHostStateChatTurnContext,
  claimHostStateChatTurnForDispatch,
  hostStateRunId,
  hostStateSubmissionId,
  markHostStateChatTurnStarted,
  type HostAdapterDeps,
} from "./host-adapter"

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true })
  }
})

const KEY = new Uint8Array(32).fill(13)
const NOW = 1_755_000_000_000

function deps(overrides: Partial<HostAdapterDeps> = {}): HostAdapterDeps {
  return { loadKey: async () => KEY, ...overrides }
}

function action(
  intent: AllowedHostStateIntent = {
    kind: "message.enqueue",
    messageId: "message-1",
    text: "hello from mobile",
    attachments: [],
  },
  overrides: Partial<HostStateAction> = {}
): HostStateAction {
  return {
    channel: "cognia://target/target-1/sessions/session-1",
    accountId: "account-1",
    runtimeTargetId: "target-1",
    hostId: "host-1",
    hostGeneration: 1,
    sessionId: "session-1",
    clientId: "client-1",
    clientSeq: 1,
    actionId: "action-1",
    createdAt: 1_755_000_000_000,
    action: intent,
    ...overrides,
  }
}

describe("id helpers", () => {
  it("derives run and submission ids from the action id", () => {
    expect(hostStateRunId("action-1")).toBe("hoststate:action-1")
    expect(hostStateSubmissionId("action-1")).toBe("work:hoststate:action-1")
  })
})

describe("acceptHostStateChatTurn", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  }, 30_000)

  it("accepts an enqueued message from an attached client", async () => {
    const receipt = await acceptHostStateChatTurn(action(), deps())

    expect(receipt).toMatchObject({
      submissionId: "work:hoststate:action-1",
      runId: "hoststate:action-1",
      state: "accepted",
    })
    expect(await getWorkSubmission("work:hoststate:action-1")).toMatchObject({
      accountId: "account-1",
      runtimeTargetId: "target-1",
      sessionId: "session-1",
      sourceKind: "chat",
      triggerId: "action-1",
    })
  }, 30_000)

  it("uses the same idempotency key shape as the renderer", async () => {
    // A turn that reaches the Host twice — once via the client outbox, once
    // locally — is the same work and must collapse onto one submission.
    await acceptHostStateChatTurn(action(), deps())
    const row = await getWorkSubmission("work:hoststate:action-1")
    expect(row?.idempotencyKey).toBe(chatIdempotencyKey("session-1", "message-1"))
  }, 30_000)

  it("collapses a redelivered action onto the original submission", async () => {
    const first = await acceptHostStateChatTurn(action(), deps())
    const second = await acceptHostStateChatTurn(action(), deps())
    expect(second).toEqual(first)
    expect(await getDb().workSubmissions.count()).toBe(1)
  }, 30_000)

  it("collapses a re-sent message that arrives under a different action id", async () => {
    // The transport may retry with a fresh action id; the message id is what
    // identifies the work.
    await acceptHostStateChatTurn(action(), deps())
    const replay = await acceptHostStateChatTurn(
      action(undefined, { actionId: "action-2" }),
      deps()
    )
    expect(replay?.submissionId).toBe("work:hoststate:action-1")
    expect(await getDb().workSubmissions.count()).toBe(1)
  }, 30_000)

  it("freezes the enqueued text as the model-side input", async () => {
    await acceptHostStateChatTurn(action(), deps())
    const batch = await getDb().workInputBatches.get("input:hoststate:action-1")
    expect(batch?.visibleMessageIds).toEqual(["message-1"])
    // Reference-only: HostState attachment refs carry no content address.
    expect(batch?.attachments).toEqual([])
    expect(JSON.stringify(batch?.envelope)).not.toContain("hello from mobile")
  }, 30_000)

  it.each<AllowedHostStateIntent>([
    { kind: "turn.abort" },
    { kind: "turn.steer", text: "actually, stop" },
    { kind: "draft.replace", text: "draft", attachments: [] },
    { kind: "session.rename", title: "renamed" },
  ])(
    "ignores the $kind intent",
    async (intent) => {
      expect(await acceptHostStateChatTurn(action(intent), deps())).toBeNull()
      expect(await getDb().workSubmissions.count()).toBe(0)
    },
    30_000
  )

  it("ignores an action with no session", async () => {
    const withoutSession = action()
    delete (withoutSession as { sessionId?: string }).sessionId
    expect(await acceptHostStateChatTurn(withoutSession, deps())).toBeNull()
  }, 30_000)

  it("reports a rejection rather than dropping the client's message", async () => {
    const onError = jest.fn()
    const receipt = await acceptHostStateChatTurn(
      action(undefined, { accountId: "" }),
      deps({ onError })
    )
    expect(receipt).toBeNull()
    expect(onError).toHaveBeenCalled()
  }, 30_000)

  it("propagates an unexpected failure instead of silently continuing", async () => {
    const onError = jest.fn()
    await expect(
      acceptHostStateChatTurn(
        action(),
        deps({
          onError,
          loadKey: async () => {
            throw new Error("keyring unavailable")
          },
        })
      )
    ).rejects.toThrow("keyring unavailable")
    expect(onError).toHaveBeenCalled()
  }, 30_000)
})

describe("HostState live handoff", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    await acceptHostStateChatTurn(action(), deps())
  }, 30_000)

  it("freezes the production send options before HostState dispatch", async () => {
    expect(
      await bindHostStateChatTurnContext(
        action(),
        { cwd: "/srv/original", model: "claude-sonnet-4-5" },
        deps()
      )
    ).toBe(true)
    expect(await getWorkSubmission("work:hoststate:action-1")).toMatchObject({
      contextBundleId: "context:hoststate:action-1",
    })
  }, 30_000)

  it("claims the accepted turn before HostState assembles its send options", async () => {
    expect(await claimHostStateChatTurnForDispatch("action-1", NOW, deps())).toBe("claimed")
    expect(await getWorkSubmission("work:hoststate:action-1")).toMatchObject({
      dispatchState: "claimed",
      leaseOwner: "host-state",
    })
    expect(await claimHostStateChatTurnForDispatch("action-1", NOW + 1, deps())).toBe(
      "owned_elsewhere"
    )
  }, 30_000)

  it("marks the successful HostState handoff dispatched", async () => {
    expect(await markHostStateChatTurnStarted("action-1", NOW + 1, deps())).toBe(true)
    expect((await getWorkSubmission("work:hoststate:action-1"))?.dispatchState).toBe("dispatched")
  }, 30_000)
})
