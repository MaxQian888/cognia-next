/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

// Dexie `delete()` + `open()` per test is well past the 5 s default hook
// budget when the suite runs alongside the repo's heavier DB suites.
jest.setTimeout(30_000)

import { getDb } from "@/lib/db/schema"
import { createDraft } from "@/lib/db/connector-drafts"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import type { ConversationReference } from "@/types/connectors/event"
import { readForResolution, upsertByConversationKey } from "@/lib/db/conversation-overrides"

import { __resetPendingOverridesForTests, hasPendingOverrideMutation } from "./pending-overrides"
import {
  approveDraftRemotely,
  mutateOverrideRemotely,
  rejectDraftRemotely,
  sendManualReplyRemotely,
} from "./remote"

const ADAPTER = "tg-1"
const KEY = "telegram:tg-1:555"
const SESSION = "s-1"
const REF: ConversationReference = { platform: "telegram", adapterId: ADAPTER }

const manualInput = {
  adapterId: ADAPTER,
  conversationKey: KEY,
  sessionId: SESSION,
  conversationRef: REF,
  segments: [{ type: "text" as const, text: "on it" }],
  idempotencyKey: "idem-1",
  clientMessageId: "client-msg-1",
}

beforeEach(async () => {
  __resetPendingOverridesForTests()
  setActiveRuntimeTargetContext("acct-1", "host-1")
  await getDb().delete()
  await getDb().open()
})

afterEach(() => clearActiveRuntimeTargetContext())

describe("sendManualReplyRemotely", () => {
  it("enqueues the relay RPC and mirrors the message optimistically", async () => {
    const { queueRow, messageId } = await sendManualReplyRemotely(manualInput)

    expect(queueRow.command).toBe("connector_enqueue_outbound")
    // The one key the whole stack dedupes on: the queue row's header, the
    // outbound request metadata, and the host arm's `outboundQueue` lookup.
    expect(queueRow.idempotencyKey).toBe("idem-1")
    expect(queueRow.payload).toMatchObject({
      adapterId: ADAPTER,
      conversationKey: KEY,
      sessionId: SESSION,
      clientMessageId: "client-msg-1",
      request: { metadata: { idempotencyKey: "idem-1" } },
    })

    expect(messageId).toBe("client-msg-1")
    const mirror = await getDb().messages.get("client-msg-1")
    expect(mirror?.role).toBe("user")
    expect(mirror?.parts).toEqual([{ type: "text", text: "on it" }])
    // The host stamps `outboundJobId`; until it syncs down the mirror only
    // carries the relay key so the delivery pill knows to keep waiting.
    expect(mirror?.metadata?.relayIdempotencyKey).toBe("idem-1")
    expect(mirror?.metadata?.outboundJobId).toBeUndefined()
  })

  it("carries replyTo / threadId through to the host", async () => {
    const { queueRow } = await sendManualReplyRemotely({
      ...manualInput,
      replyTo: { messageId: "m-remote" },
      threadId: "th-1",
    })
    expect(queueRow.payload.request).toMatchObject({
      replyTo: { messageId: "m-remote" },
      threadId: "th-1",
    })
  })

  it("labels the row for the offline-queue UI", async () => {
    const { queueRow } = await sendManualReplyRemotely(manualInput, { label: "Reply to Ada" })
    expect(queueRow.label).toBe("Reply to Ada")
  })
})

describe("approveDraftRemotely", () => {
  async function seedDraft() {
    return createDraft({
      sessionId: SESSION,
      conversationKey: KEY,
      segments: [{ type: "text", text: "draft text" }],
    })
  }

  it("relays the approval under a draft-derived key and flips the local mirror", async () => {
    const draft = await seedDraft()
    const row = await approveDraftRemotely(draft.id, undefined)

    expect(row.command).toBe("connector_approve_draft")
    // Derived from the draft id, so a retried approval can never produce a
    // second outbound job on the host.
    expect(row.idempotencyKey).toBe(`cdr-approve:${draft.id}`)
    expect(row.payload).toEqual({ draftId: draft.id })
    expect((await getDb().connectorDrafts.get(draft.id))?.status).toBe("approved")
  })

  it("ships the edited segments the operator actually approved", async () => {
    const draft = await seedDraft()
    const edited = [{ type: "text" as const, text: "edited on phone" }]
    const row = await approveDraftRemotely(draft.id, edited)
    expect(row.payload).toEqual({ draftId: draft.id, segments: edited })
  })

  it("leaves a already-settled draft alone", async () => {
    const draft = await seedDraft()
    await getDb().connectorDrafts.update(draft.id, { status: "rejected" })
    await approveDraftRemotely(draft.id, undefined)
    expect((await getDb().connectorDrafts.get(draft.id))?.status).toBe("rejected")
  })
})

describe("rejectDraftRemotely", () => {
  it("relays the rejection and flips the local mirror", async () => {
    const draft = await createDraft({
      sessionId: SESSION,
      conversationKey: KEY,
      segments: [{ type: "text", text: "draft" }],
    })
    const row = await rejectDraftRemotely(draft.id)
    expect(row.command).toBe("connector_reject_draft")
    expect(row.idempotencyKey).toBe(`cdr-reject:${draft.id}`)
    expect((await getDb().connectorDrafts.get(draft.id))?.status).toBe("rejected")
  })
})

describe("mutateOverrideRemotely", () => {
  it("enqueues the mutation verbatim and applies the optimistic mirror", async () => {
    await upsertByConversationKey({ conversationKey: KEY, sessionId: SESSION })
    const mutation = { kind: "setPinned", conversationKey: KEY, pinned: true } as const

    const row = await mutateOverrideRemotely(mutation)

    expect(row.command).toBe("conversation_overrides_update")
    expect(row.payload).toEqual({ mutation })
    expect((await readForResolution(KEY))?.pinned).toBe(true)
  })

  it("releases the memory marker but leaves the queue row holding the key pending", async () => {
    await upsertByConversationKey({ conversationKey: KEY, sessionId: SESSION })
    await mutateOverrideRemotely({ kind: "setPinned", conversationKey: KEY, pinned: true })

    // The in-memory marker only had to cover the window before the row was
    // persisted; from here the durable row is what keeps a sync pull from
    // clobbering the optimistic write.
    expect(hasPendingOverrideMutation(KEY)).toBe(false)
    const rows = await getDb().mobileOutboundQueue.toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe("pending")
  })

  it("releases the marker even when the enqueue throws", async () => {
    clearActiveRuntimeTargetContext() // makes `enqueue` reject
    await expect(
      mutateOverrideRemotely({ kind: "setPinned", conversationKey: KEY, pinned: true })
    ).rejects.toThrow()
    // A leaked marker would permanently freeze this conversation's sync.
    expect(hasPendingOverrideMutation(KEY)).toBe(false)
  })
})
