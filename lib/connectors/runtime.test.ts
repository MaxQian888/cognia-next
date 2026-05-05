/**
 * Tests for lib/connectors/runtime.ts — Task 37.
 *
 * Verifies that installRuntime wires the bus routeHandler correctly for all
 * 5 route decisions:
 *   - "ai-run"        → ChatSession created, StoredMessage inserted, outbound job enqueued
 *   - "manual-store"  → ChatSession created, StoredMessage inserted, no outbound job
 *   - "draft-prepare" → ChatSession created, StoredMessage inserted, draft created
 *   - "store-only"    → ChatSession created, StoredMessage inserted, no outbound job
 *   - "drop"          → nothing inserted
 *
 * Also verifies session reuse across events with the same conversationKey.
 */

import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { installRuntime } from "./runtime"
import { getBus, __resetBusForTesting } from "./bus"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { RouteDecision } from "./mode-router"
import type { ResolvedBinding } from "./policy-resolve"

// ── helpers ──────────────────────────────────────────────────────────────────

function makeEvent(
  overrides: Partial<NormalizedInboundEvent> & { conversationKey?: string }
): NormalizedInboundEvent {
  return {
    platform: "telegram",
    adapterId: "adapter_1",
    selfId: "bot_1",
    messageId: overrides.messageId ?? crypto.randomUUID(),
    conversationRef: { platform: "telegram", adapterId: "adapter_1" },
    conversationKey: overrides.conversationKey ?? "telegram:adapter_1:chat_42",
    sender: {
      id: "u_alice",
      platform: "telegram",
      adapterId: "adapter_1",
      remoteUserId: "u_alice",
      displayName: "Alice",
    },
    channel: { id: "ch_42", name: "Direct with Alice", kind: "private" },
    segments: [{ type: "text", text: "hello runtime" }],
    plainText: "hello runtime",
    mentions: { selfMentioned: false, users: [] },
    timestamp: Date.now(),
    raw: {},
    ...overrides,
  }
}

const RESOLVED: ResolvedBinding = {
  mode: "auto",
  characterId: "char_abc",
  trigger: {
    rules: [{ kind: "private-default" }],
    blockers: [],
    storeUnmatchedInDraftMode: false,
  },
}

/**
 * Invoke the bus routeHandler directly (bypasses the full bus pipeline so we
 * don't need to seed adapter instances / dedup ledger etc.).
 */
async function callHandler(
  event: NormalizedInboundEvent,
  decision: RouteDecision,
  resolved: ResolvedBinding = RESOLVED
): Promise<void> {
  const bus = getBus()
  if (!bus.routeHandler) throw new Error("routeHandler not installed")
  await bus.routeHandler(event, decision, resolved)
}

// ── setup ─────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  __resetBusForTesting()
  const bus = getBus()
  installRuntime(bus, { sendPrompt: jest.fn() })
})

// ── tests ─────────────────────────────────────────────────────────────────────

describe("installRuntime — ai-run", () => {
  it("creates a ChatSession with platformBinding", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_ai" })
    await callHandler(event, "ai-run")

    const sessions = await getDb().sessions.toArray()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].platformBinding?.conversationKey).toBe("telegram:adapter_1:chat_ai")
    expect(sessions[0].platformBinding?.platform).toBe("telegram")
    expect(sessions[0].characterId).toBe("char_abc")
  })

  it("inserts a user StoredMessage with platformMessage metadata", async () => {
    const event = makeEvent({
      conversationKey: "telegram:adapter_1:chat_ai",
      messageId: "msg_ai_1",
    })
    await callHandler(event, "ai-run")

    const messages = await getDb().messages.toArray()
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe("user")
    expect(messages[0].metadata?.platformMessage?.messageId).toBe("msg_ai_1")
    expect(messages[0].metadata?.platformMessage?.platform).toBe("telegram")
  })

  it("enqueues a placeholder outbound job", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_ai" })
    await callHandler(event, "ai-run")

    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].adapterId).toBe("adapter_1")
    expect(jobs[0].status).toBe("pending")
    expect(jobs[0].request.segments[0]).toMatchObject({
      type: "text",
      text: "[AI reply placeholder]",
    })
  })

  it("writes an outbound.enqueued audit entry", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_ai" })
    await callHandler(event, "ai-run")

    const audits = await getDb().connectorAudit.toArray()
    expect(audits.some((a) => a.kind === "outbound.enqueued")).toBe(true)
  })
})

describe("installRuntime — manual-store", () => {
  it("creates ChatSession and StoredMessage; no outbound job", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_manual" })
    await callHandler(event, "manual-store")

    const sessions = await getDb().sessions.toArray()
    expect(sessions).toHaveLength(1)

    const messages = await getDb().messages.toArray()
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe("user")

    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(0)
  })
})

describe("installRuntime — draft-prepare", () => {
  it("creates ChatSession, StoredMessage, and a ConnectorDraft", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_draft" })
    await callHandler(event, "draft-prepare")

    const sessions = await getDb().sessions.toArray()
    expect(sessions).toHaveLength(1)

    const messages = await getDb().messages.toArray()
    expect(messages).toHaveLength(1)

    const drafts = await getDb().connectorDrafts.toArray()
    expect(drafts).toHaveLength(1)
    expect(drafts[0].status).toBe("pending")
    expect(drafts[0].conversationKey).toBe("telegram:adapter_1:chat_draft")
    expect(drafts[0].sourceMessageId).toBe(messages[0].id)
  })
})

describe("installRuntime — store-only", () => {
  it("creates ChatSession and StoredMessage; no outbound job, no draft", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_store" })
    await callHandler(event, "store-only")

    const sessions = await getDb().sessions.toArray()
    expect(sessions).toHaveLength(1)

    const messages = await getDb().messages.toArray()
    expect(messages).toHaveLength(1)

    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(0)

    const drafts = await getDb().connectorDrafts.toArray()
    expect(drafts).toHaveLength(0)
  })
})

describe("installRuntime — drop", () => {
  it("does NOT insert ChatSession or StoredMessage", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_drop" })
    await callHandler(event, "drop")

    const sessions = await getDb().sessions.toArray()
    expect(sessions).toHaveLength(0)

    const messages = await getDb().messages.toArray()
    expect(messages).toHaveLength(0)
  })
})

describe("installRuntime — session reuse", () => {
  it("reuses existing session on second event with same conversationKey", async () => {
    const key = "telegram:adapter_1:chat_reuse"
    const event1 = makeEvent({ conversationKey: key, messageId: "msg_1" })
    const event2 = makeEvent({ conversationKey: key, messageId: "msg_2" })

    await callHandler(event1, "manual-store")
    await callHandler(event2, "manual-store")

    const sessions = await getDb().sessions.toArray()
    // Must have exactly one session
    expect(sessions).toHaveLength(1)

    const messages = await getDb().messages.toArray()
    // Both messages must belong to the same session
    expect(messages).toHaveLength(2)
    expect(messages[0].sessionId).toBe(sessions[0].id)
    expect(messages[1].sessionId).toBe(sessions[0].id)
  })

  it("uses channel.name as session title when present", async () => {
    const event = makeEvent({
      conversationKey: "telegram:adapter_1:chat_named",
      channel: { id: "ch_x", name: "My Group", kind: "group" },
    })
    await callHandler(event, "store-only")
    const sessions = await getDb().sessions.toArray()
    expect(sessions[0].title).toBe("My Group")
  })

  it("falls back to sender.displayName when channel.name is absent", async () => {
    const event = makeEvent({
      conversationKey: "telegram:adapter_1:chat_noname",
      channel: { id: "ch_x", kind: "private" },
      sender: {
        id: "u_alice",
        platform: "telegram",
        adapterId: "adapter_1",
        remoteUserId: "u_alice",
        displayName: "Alice",
      },
    })
    await callHandler(event, "store-only")
    const sessions = await getDb().sessions.toArray()
    expect(sessions[0].title).toBe("Alice")
  })
})
