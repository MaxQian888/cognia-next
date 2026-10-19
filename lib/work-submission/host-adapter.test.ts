/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { webcrypto } from "node:crypto"

import {
  type AllowedHostStateIntent,
  type HostStateAction,
} from "@cognia/agent-config-types/host-state"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  getWorkSubmission,
  getWorkSubmissionBundle,
  WORK_SUBMISSION_LEASE_TTL_MS,
} from "@/lib/db/work-submissions"

import { chatIdempotencyKey } from "./chat-adapter"
import { openWorkSubmissionPayload } from "./crypto"
import {
  acceptHostStateChatTurn,
  bindHostStateChatTurnContext,
  claimHostStateChatTurnForDispatch,
  HOST_STATE_ATTACHMENT_REFS_DETAIL,
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

  it("records that the turn carried attachment refs its frozen input cannot replay", async () => {
    const withFiles = action({
      kind: "message.enqueue",
      messageId: "message-1",
      text: "look",
      attachments: [{ ref: "upload:u1", name: "shot.png", mediaType: "image/png", size: 3 }],
    })
    expect(await bindHostStateChatTurnContext(withFiles, { model: "m" }, deps())).toBe(true)
    const bundle = await getWorkSubmissionBundle("work:hoststate:action-1")
    const context = JSON.parse(
      await openWorkSubmissionPayload(
        bundle!.contextBundle!.envelope,
        {
          accountId: "account-1",
          submissionId: "work:hoststate:action-1",
          kind: "context-bundle",
        },
        deps()
      )
    )
    expect(context.detail).toEqual({ [HOST_STATE_ATTACHMENT_REFS_DETAIL]: 1 })
  }, 30_000)
})

describe("HostState redrive of an earlier attempt", () => {
  const LATER = NOW + WORK_SUBMISSION_LEASE_TTL_MS + 1

  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    await acceptHostStateChatTurn(action(), deps())
    // A previous Host claimed and handed the turn off, then died.
    expect(await claimHostStateChatTurnForDispatch("action-1", NOW, deps())).toBe("claimed")
    expect(await markHostStateChatTurnStarted("action-1", NOW, deps())).toBe(true)
  }, 30_000)

  it("leaves a turn whose lease is still live to its owner", async () => {
    const listRunEvents = jest.fn(async () => [])
    expect(
      await claimHostStateChatTurnForDispatch("action-1", NOW + 1, deps({ listRunEvents }))
    ).toBe("owned_elsewhere")
    expect(listRunEvents).not.toHaveBeenCalled()
    expect((await getWorkSubmission("work:hoststate:action-1"))?.dispatchState).toBe("dispatched")
  }, 30_000)

  it("parks a turn that already reached a tool instead of sending it again", async () => {
    const abortPrevious = jest.fn(async () => undefined)
    const listRunEvents = jest.fn(async () => [{ type: "tool.started" }] as never)
    expect(
      await claimHostStateChatTurnForDispatch(
        "action-1",
        LATER,
        deps({ listRunEvents, abortPrevious })
      )
    ).toBe("recovery_required")
    expect(abortPrevious).not.toHaveBeenCalled()
    expect(await getWorkSubmission("work:hoststate:action-1")).toMatchObject({
      dispatchState: "settled",
      terminalOutcome: "recovery_required",
      errorCode: "observed-tool-activity",
    })
  }, 30_000)

  it("stops the previous runtime before taking over a turn with no observed effects", async () => {
    const abortPrevious = jest.fn(async () => undefined)
    expect(
      await claimHostStateChatTurnForDispatch(
        "action-1",
        LATER,
        deps({
          listRunEvents: async () => [],
          readEnvelopes: async () => [],
          abortPrevious,
        })
      )
    ).toBe("claimed")
    expect(abortPrevious).toHaveBeenCalledWith(
      expect.objectContaining({ id: "work:hoststate:action-1", sessionId: "session-1" })
    )
  }, 30_000)

  it("parks the turn when the previous runtime cannot be stopped", async () => {
    const onError = jest.fn()
    expect(
      await claimHostStateChatTurnForDispatch(
        "action-1",
        LATER,
        deps({
          listRunEvents: async () => [],
          readEnvelopes: async () => [],
          abortPrevious: async () => {
            throw new Error("sidecar unreachable")
          },
          onError,
        })
      )
    ).toBe("recovery_required")
    expect(onError).toHaveBeenCalled()
    expect(await getWorkSubmission("work:hoststate:action-1")).toMatchObject({
      dispatchState: "settled",
      errorCode: "takeover_abort_failed",
    })
  }, 30_000)

  it("does not touch a settled turn", async () => {
    const listRunEvents = jest.fn(async () => [{ type: "tool.started" }] as never)
    await claimHostStateChatTurnForDispatch("action-1", LATER, deps({ listRunEvents }))
    listRunEvents.mockClear()
    expect(
      await claimHostStateChatTurnForDispatch("action-1", LATER + 1, deps({ listRunEvents }))
    ).toBe("owned_elsewhere")
    expect(listRunEvents).not.toHaveBeenCalled()
  }, 30_000)
})
