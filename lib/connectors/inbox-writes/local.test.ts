/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

// Dexie `delete()` + `open()` per test is well past the 5 s default hook
// budget when the suite runs alongside the repo's heavier DB suites.
jest.setTimeout(30_000)

// The delivery gateway runs the PII gate and adapter lookups; the unit under
// test only cares that it is called once per NON-replayed send, with the
// caller's idempotency key threaded into `request.metadata`.
jest.mock("@/lib/connectors/delivery-gateway", () => ({
  enqueueGoverned: jest.fn(),
}))
// The host publishes a coalesced invalidate after each write; assert the call,
// not the Tauri emit behind it.
jest.mock("@/lib/sync/host-invalidate", () => ({ publishSyncInvalidate: jest.fn() }))

import { enqueueGoverned } from "@/lib/connectors/delivery-gateway"
import { publishSyncInvalidate } from "@/lib/sync/host-invalidate"
import { getDb } from "@/lib/db/schema"
import { createDraft } from "@/lib/db/connector-drafts"
import type { ConnectorDraftRow, OutboundJobRow } from "@/lib/db/connector-types"
import type { ConversationReference } from "@/types/connectors/event"

import {
  DraftNotFoundError,
  adapterIdOfConversationKey,
  approveDraftLocally,
  draftApprovalIdempotencyKey,
  rejectDraftLocally,
  segmentsToMessageParts,
  sendManualReplyLocally,
} from "./local"

const enqueueMock = enqueueGoverned as jest.Mock
const invalidateMock = publishSyncInvalidate as jest.Mock

const ADAPTER = "tg-1"
const KEY = "telegram:tg-1:555"
const SESSION = "s-1"
const REF: ConversationReference = { platform: "telegram", adapterId: ADAPTER }

let jobSeq = 0

/** Persist the job the gateway would have written, then hand it back. */
function fakeGateway(): void {
  enqueueMock.mockImplementation(
    async (input: {
      adapterId: string
      conversationKey: string
      request: OutboundJobRow["request"]
      source: OutboundJobRow["source"]
    }) => {
      const now = Date.now()
      const row: OutboundJobRow = {
        id: `job-${++jobSeq}`,
        adapterId: input.adapterId,
        conversationKey: input.conversationKey,
        request: input.request,
        status: "pending",
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        nextAttemptAt: 0,
        idempotencyKey: input.request.metadata.idempotencyKey,
        source: input.source,
      }
      await getDb().outboundQueue.add(row)
      return row
    }
  )
}

beforeEach(async () => {
  jest.clearAllMocks()
  jobSeq = 0
  await getDb().delete()
  await getDb().open()
  fakeGateway()
})

describe("segmentsToMessageParts", () => {
  it("renders every segment kind the composer can produce", () => {
    expect(
      segmentsToMessageParts([
        { type: "text", text: "hello" },
        { type: "markdown", md: "**bold**" },
        { type: "image", url: "https://x/i.png" },
        { type: "file", name: "report.pdf", url: "https://x/f", mimeType: "application/pdf", sizeBytes: 12 },
      ])
    ).toEqual([
      { type: "text", text: "hello" },
      { type: "text", text: "**bold**" },
      { type: "text", text: "[image: https://x/i.png]" },
      { type: "text", text: "[file: report.pdf]" },
    ])
  })

  it("drops empty text rather than emitting blank parts", () => {
    expect(segmentsToMessageParts([{ type: "text", text: "" }])).toEqual([])
  })
})

describe("adapterIdOfConversationKey", () => {
  it("parses a key and degrades to undefined on garbage", () => {
    expect(adapterIdOfConversationKey(KEY)).toBe(ADAPTER)
    expect(adapterIdOfConversationKey("not-a-key")).toBeUndefined()
  })
})

describe("sendManualReplyLocally", () => {
  const input = {
    adapterId: ADAPTER,
    conversationKey: KEY,
    sessionId: SESSION,
    conversationRef: REF,
    segments: [{ type: "text" as const, text: "on it" }],
    idempotencyKey: "idem-1",
  }

  it("enqueues a governed manual job and appends the local user message", async () => {
    const result = await sendManualReplyLocally(input)

    expect(enqueueMock).toHaveBeenCalledTimes(1)
    expect(enqueueMock.mock.calls[0][0]).toMatchObject({
      adapterId: ADAPTER,
      conversationKey: KEY,
      source: "manual",
      request: { metadata: { idempotencyKey: "idem-1" } },
    })
    expect(result.reused).toBe(false)

    const message = await getDb().messages.get(result.messageId)
    expect(message?.role).toBe("user")
    expect(message?.parts).toEqual([{ type: "text", text: "on it" }])
    expect(message?.metadata?.outboundJobId).toBe(result.jobId)
    expect(invalidateMock).toHaveBeenCalledWith("messages", KEY)
  })

  it("replays idempotently — a retried RPC never sends twice", async () => {
    const first = await sendManualReplyLocally(input)
    const second = await sendManualReplyLocally(input)

    expect(enqueueMock).toHaveBeenCalledTimes(1)
    expect(second).toEqual({ jobId: first.jobId, messageId: first.messageId, reused: true })
    expect(await getDb().messages.count()).toBe(1)
  })

  it("finishes a send whose job landed but whose message write was interrupted", async () => {
    const first = await sendManualReplyLocally(input)
    // Simulate the crash window: job persisted, message row lost.
    await getDb().messages.delete(first.messageId)

    const second = await sendManualReplyLocally(input)
    expect(enqueueMock).toHaveBeenCalledTimes(1)
    expect(second.jobId).toBe(first.jobId)
    expect(second.reused).toBe(true)
    expect(await getDb().messages.get(second.messageId)).toBeDefined()
  })

  it("converges on the client-minted message id so the mirror is replaced, not duplicated", async () => {
    // The thin client already wrote an optimistic row under this id; the host
    // must `put` over it rather than `add` a second row.
    await getDb().messages.put({
      id: "client-msg-1",
      sessionId: SESSION,
      role: "user",
      parts: [{ type: "text", text: "on it" }],
      metadata: { relayIdempotencyKey: "idem-1" },
      createdAt: Date.now(),
    })
    const result = await sendManualReplyLocally({ ...input, clientMessageId: "client-msg-1" })

    expect(result.messageId).toBe("client-msg-1")
    expect(await getDb().messages.count()).toBe(1)
    expect((await getDb().messages.get("client-msg-1"))?.metadata?.outboundJobId).toBe(result.jobId)
  })

  it("threads replyTo and threadId into the outbound request", async () => {
    await sendManualReplyLocally({
      ...input,
      replyTo: { messageId: "m-remote" },
      threadId: "th-1",
    })
    expect(enqueueMock.mock.calls[0][0].request).toMatchObject({
      replyTo: { messageId: "m-remote" },
      threadId: "th-1",
    })
  })

  it("never writes a message with zero parts", async () => {
    const result = await sendManualReplyLocally({
      ...input,
      segments: [{ type: "text", text: "" }],
    })
    expect((await getDb().messages.get(result.messageId))?.parts).toEqual([
      { type: "text", text: "" },
    ])
  })
})

describe("approveDraftLocally", () => {
  async function seedDraft(
    over: Partial<Parameters<typeof createDraft>[0]> = {}
  ): Promise<ConnectorDraftRow> {
    return createDraft({
      sessionId: SESSION,
      conversationKey: KEY,
      segments: [{ type: "text", text: "draft text" }],
      ...over,
    })
  }

  it("throws a typed error for an unknown draft", async () => {
    await expect(approveDraftLocally("nope")).rejects.toBeInstanceOf(DraftNotFoundError)
  })

  it("enqueues first, then flips the draft — a failed enqueue leaves it pending", async () => {
    const draft = await seedDraft()
    enqueueMock.mockRejectedValueOnce(new Error("pii gate refused"))

    await expect(
      approveDraftLocally(draft.id, {
        binding: { adapterId: ADAPTER, conversationKey: KEY, conversationRef: REF },
      })
    ).rejects.toThrow("pii gate refused")
    // Ordering is the point: had the flip happened first, a refused send
    // would leave an "approved" draft nobody will ever deliver.
    expect((await getDb().connectorDrafts.get(draft.id))?.status).toBe("pending")
  })

  it("sends the EDITED segments when the operator changed them on the phone", async () => {
    const draft = await seedDraft()
    await getDb().sessions.add({
      id: SESSION,
      title: "chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      platformBinding: { adapterId: ADAPTER, conversationKey: KEY, conversationRef: REF },
    } as never)

    await approveDraftLocally(draft.id, { segments: [{ type: "text", text: "edited on phone" }] })

    expect(enqueueMock.mock.calls[0][0].request.segments).toEqual([
      { type: "text", text: "edited on phone" },
    ])
    expect((await getDb().connectorDrafts.get(draft.id))?.status).toBe("approved")
  })

  it("uses an explicit binding when the draft has no outbound preview and no session row", async () => {
    const draft = await seedDraft()
    const result = await approveDraftLocally(draft.id, {
      binding: { adapterId: ADAPTER, conversationKey: KEY, conversationRef: REF },
    })
    expect(result.jobId).toBeDefined()
    expect(enqueueMock.mock.calls[0][0].request.metadata.idempotencyKey).toBe(
      draftApprovalIdempotencyKey(draft)
    )
  })

  it("approves without a job when no delivery target can be resolved", async () => {
    const draft = await seedDraft()
    const result = await approveDraftLocally(draft.id)
    expect(enqueueMock).not.toHaveBeenCalled()
    expect(result.jobId).toBeUndefined()
    expect((await getDb().connectorDrafts.get(draft.id))?.status).toBe("approved")
  })

  it("is idempotent — a replayed approval never produces a second job", async () => {
    const draft = await seedDraft()
    const binding = { adapterId: ADAPTER, conversationKey: KEY, conversationRef: REF }
    const first = await approveDraftLocally(draft.id, { binding })
    const second = await approveDraftLocally(draft.id, { binding })

    expect(enqueueMock).toHaveBeenCalledTimes(1)
    expect(second.alreadyApproved).toBe(true)
    expect(second.jobId).toBe(first.jobId)
  })
})

describe("rejectDraftLocally", () => {
  it("rejects a pending draft and no-ops on a settled one", async () => {
    const draft = await createDraft({
      sessionId: SESSION,
      conversationKey: KEY,
      segments: [{ type: "text", text: "draft" }],
    })
    await rejectDraftLocally(draft.id)
    expect((await getDb().connectorDrafts.get(draft.id))?.status).toBe("rejected")

    // Second call must not throw or re-transition.
    await rejectDraftLocally(draft.id)
    expect((await getDb().connectorDrafts.get(draft.id))?.status).toBe("rejected")
  })

  it("throws a typed error for an unknown draft", async () => {
    await expect(rejectDraftLocally("nope")).rejects.toBeInstanceOf(DraftNotFoundError)
  })
})

describe("draftApprovalIdempotencyKey", () => {
  it("derives a stable key from the draft id", () => {
    expect(draftApprovalIdempotencyKey({ id: "d-1" })).toBe("cdr-approve:d-1")
  })
})
