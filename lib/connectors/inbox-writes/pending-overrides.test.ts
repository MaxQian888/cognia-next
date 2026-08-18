/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

// Dexie `delete()` + `open()` per test is well past the 5 s default hook
// budget when the suite runs alongside the repo's heavier DB suites.
jest.setTimeout(30_000)

import { getDb } from "@/lib/db/schema"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"

import {
  __resetPendingOverridesForTests,
  hasPendingOverrideMutation,
  markPendingOverrideMutation,
  pendingOverrideConversationKeys,
} from "./pending-overrides"

const KEY = "telegram:tg-1:555"
const OTHER = "slack:sl-1:C1"

beforeEach(async () => {
  __resetPendingOverridesForTests()
  // The durable queue is scoped to an (account, target) pair; a thin client
  // always has one active while it is relaying.
  setActiveRuntimeTargetContext("acct-1", "host-1")
  await getDb().delete()
  await getDb().open()
})

afterEach(() => clearActiveRuntimeTargetContext())

describe("markPendingOverrideMutation", () => {
  it("marks and releases", () => {
    expect(hasPendingOverrideMutation(KEY)).toBe(false)
    const release = markPendingOverrideMutation(KEY)
    expect(hasPendingOverrideMutation(KEY)).toBe(true)
    release()
    expect(hasPendingOverrideMutation(KEY)).toBe(false)
  })

  it("refcounts overlapping mutations on one conversation", () => {
    // Two controls flipped in quick succession: the first release must not
    // open the window for a sync pull while the second write is still going.
    const releaseA = markPendingOverrideMutation(KEY)
    const releaseB = markPendingOverrideMutation(KEY)
    releaseA()
    expect(hasPendingOverrideMutation(KEY)).toBe(true)
    releaseB()
    expect(hasPendingOverrideMutation(KEY)).toBe(false)
  })

  it("is safe to release twice", () => {
    const release = markPendingOverrideMutation(KEY)
    release()
    release()
    expect(hasPendingOverrideMutation(KEY)).toBe(false)
  })
})

describe("pendingOverrideConversationKeys", () => {
  it("unions memory markers with unfinished queue rows", async () => {
    markPendingOverrideMutation(KEY)
    await enqueue({
      command: "conversation_overrides_update",
      idempotencyKey: "k-1",
      payload: { mutation: { kind: "setPinned", conversationKey: OTHER, pinned: true } },
    })

    expect(await pendingOverrideConversationKeys()).toEqual(new Set([KEY, OTHER]))
  })

  it("survives a reload — the queue row keeps the key pending with no memory marker", async () => {
    await enqueue({
      command: "conversation_overrides_update",
      idempotencyKey: "k-1",
      payload: { mutation: { kind: "setStatus", conversationKey: KEY, status: "resolved" } },
    })
    __resetPendingOverridesForTests() // simulate the reload

    expect(await pendingOverrideConversationKeys()).toEqual(new Set([KEY]))
  })

  it("reads the legacy `{ input }` payload shape too", async () => {
    await enqueue({
      command: "conversation_overrides_update",
      idempotencyKey: "k-1",
      payload: { input: { conversationKey: KEY, sessionId: "s-1" } },
    })
    expect(await pendingOverrideConversationKeys()).toEqual(new Set([KEY]))
  })

  it("ignores rows for other commands", async () => {
    await enqueue({
      command: "connector_enqueue_outbound",
      idempotencyKey: "k-1",
      payload: { conversationKey: KEY },
    })
    expect(await pendingOverrideConversationKeys()).toEqual(new Set())
  })

  it("stops treating a key as pending once its row reaches a terminal status", async () => {
    const row = await enqueue({
      command: "conversation_overrides_update",
      idempotencyKey: "k-1",
      payload: { mutation: { kind: "setPinned", conversationKey: KEY, pinned: true } },
    })
    expect(await pendingOverrideConversationKeys()).toEqual(new Set([KEY]))

    // The host applied it; its row is now authoritative and the sync handler
    // must be allowed to overwrite the optimistic mirror again.
    await getDb().mobileOutboundQueue.update(row.id, { status: "sent" })
    expect(await pendingOverrideConversationKeys()).toEqual(new Set())
  })

  it("still keeps `failed` rows pending — they will be retried", async () => {
    const row = await enqueue({
      command: "conversation_overrides_update",
      idempotencyKey: "k-1",
      payload: { mutation: { kind: "setPinned", conversationKey: KEY, pinned: true } },
    })
    await getDb().mobileOutboundQueue.update(row.id, { status: "failed" })
    expect(await pendingOverrideConversationKeys()).toEqual(new Set([KEY]))
  })

  it("degrades to the memory markers when Dexie throws", async () => {
    markPendingOverrideMutation(KEY)
    await getDb().close()
    // A closed database makes the query reject; the sync handler still has to
    // run rather than blow up mid-pull.
    expect(await pendingOverrideConversationKeys()).toEqual(new Set([KEY]))
  })
})
