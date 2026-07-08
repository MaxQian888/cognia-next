/** @jest-environment jsdom */
/**
 * End-to-end bus runtime test — Task 28.
 *
 * Drives `dispatchInboundFull` through 5 scenarios:
 *   1. Private message in auto mode → routeHandler called with "ai-run".
 *   2. Duplicate of #1 → routeHandler NOT called; audit shows "inbound.deduped".
 *   3. Group message, no @-mention, auto mode → "drop"; no "inbound.received" audit.
 *   4. Same group message but with @-mention → "ai-run".
 *   5. Private message where adapter defaultMode = "manual" → "manual-store".
 */

import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { createAdapterInstance } from "@/lib/db/adapter-instances"
import { upsertByConversationKey, readForResolution } from "@/lib/db/conversation-overrides"
import { getByPlatformUser } from "@/lib/db/platform-identities"
import { listRecent } from "@/lib/db/connector-audit"
import { getBus, __resetBusForTesting } from "./bus"
import { __resetPruneCounterForTesting } from "./dedup"
import type { NormalizedInboundEvent, PlatformAdapter } from "@/types/connectors"
import type { RouteDecision } from "./mode-router"
import type { ResolvedBinding } from "./policy-resolve"
import type { TriggerPolicy } from "@/types/connectors/policy"

// Plugin connector hook + PII gate are mocked so the bus inbound block/transform
// path can be driven deterministically (the PII heuristics are tested in their
// own suite). Default: allow + PII-clean.
const mockConnectorDecision = jest.fn(async () => ({ action: "allow" }) as unknown)
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({ dispatchConnectorDecision: mockConnectorDecision }),
}))
const mockPiiDeep = jest.fn(() => true)
jest.mock("@/lib/twin/ingest/redact", () => ({
  hasNoLeakingPiiDeep: (...args: unknown[]) => mockPiiDeep(...(args as [])),
  hasNoLeakingPii: () => true,
}))

// Inbound OCR is mocked so the image-gate true-branch can be asserted without
// standing up the real OCR provider. The real `hasOcrableInboundImage` predicate
// is kept (requireActual) so the gate still decides correctly.
const mockRunInboundOcr = jest.fn(async () => undefined)
jest.mock("./inbound-ocr", () => ({
  ...jest.requireActual("./inbound-ocr"),
  runInboundOcr: (...args: unknown[]) => mockRunInboundOcr(...(args as [])),
}))

// ── helpers ──────────────────────────────────────────────────────────────────

function makeAdapter(id: string): PlatformAdapter {
  return {
    id,
    meta: {
      type: "telegram",
      displayName: `Bot ${id}`,
      version: "1.0.0",
      capabilities: [],
      transportModes: ["stub"],
      configSchema: {},
    },
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    health: jest.fn().mockReturnValue({ state: "running" }),
    send: jest.fn().mockResolvedValue({ ok: true }),
  } as unknown as PlatformAdapter
}

const AUTO_TRIGGER: TriggerPolicy = {
  rules: [{ kind: "private-default" }, { kind: "self-mention" }],
  blockers: [],
  storeUnmatchedInDraftMode: false,
}

const MANUAL_TRIGGER: TriggerPolicy = {
  rules: [{ kind: "private-default" }],
  blockers: [],
  storeUnmatchedInDraftMode: false,
}

function privateEvent(adapterId: string, messageId: string): NormalizedInboundEvent {
  return {
    platform: "telegram",
    adapterId,
    selfId: "bot_1",
    messageId,
    conversationRef: { platform: "telegram", adapterId },
    conversationKey: `telegram:${adapterId}:private`,
    sender: { id: "u_alice", platform: "telegram", adapterId, remoteUserId: "u_alice" },
    channel: { id: "ch_private", kind: "private" },
    segments: [{ type: "text", text: "hello" }],
    plainText: "hello",
    mentions: { selfMentioned: false, users: [] },
    timestamp: Date.now(),
    raw: {},
  }
}

function groupEvent(
  adapterId: string,
  messageId: string,
  selfMentioned: boolean
): NormalizedInboundEvent {
  return {
    platform: "telegram",
    adapterId,
    selfId: "bot_1",
    messageId,
    conversationRef: { platform: "telegram", adapterId },
    conversationKey: `telegram:${adapterId}:group`,
    sender: { id: "u_bob", platform: "telegram", adapterId, remoteUserId: "u_bob" },
    channel: { id: "ch_group", kind: "group" },
    segments: [{ type: "text", text: selfMentioned ? "@bot help" : "just chatting" }],
    plainText: selfMentioned ? "@bot help" : "just chatting",
    mentions: { selfMentioned, users: [] },
    timestamp: Date.now(),
    raw: {},
  }
}

// ── test suite ────────────────────────────────────────────────────────────────

describe("ConnectorBus dispatchInboundFull — end-to-end", () => {
  let autoAdapterId: string
  let manualAdapterId: string

  const routeHandler = jest.fn()

  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    __resetBusForTesting()
    __resetPruneCounterForTesting()
    routeHandler.mockReset()
    mockConnectorDecision.mockReset()
    mockConnectorDecision.mockResolvedValue({ action: "allow" })
    mockPiiDeep.mockReset()
    mockPiiDeep.mockReturnValue(true)
    mockRunInboundOcr.mockClear()

    // Seed adapter instances
    const autoRow = await createAdapterInstance({
      type: "telegram",
      displayName: "Auto Bot",
      enabled: true,
      transportMode: "stub",
      settings: {},
      credentialsRef: { keyringService: "test", accounts: [] },
      trigger: AUTO_TRIGGER,
      defaultMode: "auto",
    })
    autoAdapterId = autoRow.id

    const manualRow = await createAdapterInstance({
      type: "telegram",
      displayName: "Manual Bot",
      enabled: true,
      transportMode: "stub",
      settings: {},
      credentialsRef: { keyringService: "test", accounts: [] },
      trigger: MANUAL_TRIGGER,
      defaultMode: "manual",
    })
    manualAdapterId = manualRow.id

    const bus = getBus()
    bus.registerAdapter(makeAdapter(autoAdapterId))
    bus.registerAdapter(makeAdapter(manualAdapterId))
    bus.routeHandler = routeHandler
  })

  it("runs inbound OCR only when an inbound image carries inline bytes (gate)", async () => {
    const bus = getBus()
    // Text-only inbound → gate false → OCR skipped.
    await bus.dispatchInboundFull(privateEvent(autoAdapterId, "msg_text_no_ocr"))
    expect(mockRunInboundOcr).not.toHaveBeenCalled()
    // Inbound image with inline bytes → gate true → OCR invoked.
    const imageEvent: NormalizedInboundEvent = {
      ...privateEvent(autoAdapterId, "msg_image_ocr"),
      segments: [{ type: "image", url: "img://x", dataBase64: "AAAA" } as never],
    }
    await bus.dispatchInboundFull(imageEvent)
    expect(mockRunInboundOcr).toHaveBeenCalledTimes(1)
  })

  it("plugin onConnectorInbound block stops the turn (routeHandler not called)", async () => {
    mockConnectorDecision.mockResolvedValue({ action: "block", reason: "spam" })
    const bus = getBus()
    await bus.dispatchInboundFull(privateEvent(autoAdapterId, "msg_blocked"))
    expect(routeHandler).not.toHaveBeenCalled()
    const auditRows = await listRecent(autoAdapterId)
    expect(auditRows.some((r) => r.kind === "plugin.inbound_blocked")).toBe(true)
  })

  it("plugin onConnectorInbound transform rewrites the event the route sees", async () => {
    mockConnectorDecision.mockResolvedValue({
      action: "transform",
      segments: [{ type: "text", text: "rewritten by plugin" }],
    })
    const bus = getBus()
    await bus.dispatchInboundFull(privateEvent(autoAdapterId, "msg_xform"))
    expect(routeHandler).toHaveBeenCalledTimes(1)
    const [evt] = routeHandler.mock.calls[0] as [NormalizedInboundEvent]
    expect(evt.plainText).toBe("rewritten by plugin")
    const auditRows = await listRecent(autoAdapterId)
    expect(auditRows.some((r) => r.kind === "plugin.inbound_transformed")).toBe(true)
  })

  it("a PII-injecting inbound transform is rejected; the original is kept", async () => {
    mockConnectorDecision.mockResolvedValue({
      action: "transform",
      segments: [{ type: "text", text: "leaks pii" }],
    })
    mockPiiDeep.mockReturnValue(false)
    const bus = getBus()
    await bus.dispatchInboundFull(privateEvent(autoAdapterId, "msg_pii"))
    expect(routeHandler).toHaveBeenCalledTimes(1)
    const [evt] = routeHandler.mock.calls[0] as [NormalizedInboundEvent]
    expect(evt.plainText).not.toBe("leaks pii")
    const auditRows = await listRecent(autoAdapterId)
    expect(auditRows.some((r) => r.kind === "plugin.transform_pii_blocked")).toBe(true)
  })

  it("scenario 1: private message in auto mode → ai-run", async () => {
    const bus = getBus()
    const event = privateEvent(autoAdapterId, "msg_priv_1")
    await bus.dispatchInboundFull(event)

    expect(routeHandler).toHaveBeenCalledTimes(1)
    const [, decision] = routeHandler.mock.calls[0] as [
      NormalizedInboundEvent,
      RouteDecision,
      ResolvedBinding,
    ]
    expect(decision).toBe("ai-run")

    const auditRows = await listRecent(autoAdapterId)
    expect(auditRows.some((r) => r.kind === "inbound.received")).toBe(true)
  })

  it("stamps the response-SLA deadline on inbound when the conversation has an SLA target", async () => {
    const bus = getBus()
    const conversationKey = `telegram:${autoAdapterId}:private`
    await upsertByConversationKey({
      conversationKey,
      sessionId: "s_sla",
      slaResponseMinutes: 30,
    })

    const before = Date.now()
    await bus.dispatchInboundFull(privateEvent(autoAdapterId, "msg_sla_1"))

    const row = await readForResolution(conversationKey)
    expect(row?.nextResponseDueAt).toBeDefined()
    // ~30 minutes out (no quiet hours), allowing for test wall-clock drift.
    expect(row!.nextResponseDueAt!).toBeGreaterThanOrEqual(before + 30 * 60_000 - 1000)
    expect(row!.nextResponseDueAt!).toBeLessThanOrEqual(Date.now() + 30 * 60_000 + 1000)
  })

  it("records the inbound sender in the platform-identity directory", async () => {
    const bus = getBus()
    await bus.dispatchInboundFull(privateEvent(autoAdapterId, "msg_identity_1"))
    const identity = await getByPlatformUser("telegram", "u_alice")
    expect(identity).toBeDefined()
    expect(identity?.adapterId).toBe(autoAdapterId)
  })

  it("does not stamp an SLA deadline when no SLA target is configured", async () => {
    const bus = getBus()
    const conversationKey = `telegram:${autoAdapterId}:private`
    await upsertByConversationKey({ conversationKey, sessionId: "s_nosla" })

    await bus.dispatchInboundFull(privateEvent(autoAdapterId, "msg_nosla_1"))

    const row = await readForResolution(conversationKey)
    expect(row?.nextResponseDueAt).toBeUndefined()
  })

  it("reopens a resolved conversation and stamps a fresh SLA deadline on inbound", async () => {
    const bus = getBus()
    const conversationKey = `telegram:${autoAdapterId}:private`
    await upsertByConversationKey({
      conversationKey,
      sessionId: "s_resolved",
      status: "resolved",
      slaResponseMinutes: 30,
    })

    await bus.dispatchInboundFull(privateEvent(autoAdapterId, "msg_resolved_1"))

    const row = await readForResolution(conversationKey)
    // Step 3.5 reopened it; Step 3.6 then started the response clock.
    expect(row?.status).toBe("open")
    expect(row?.nextResponseDueAt).toBeDefined()
  })

  it("scenario 2: duplicate of scenario 1 → deduped, handler NOT called", async () => {
    const bus = getBus()
    const event = privateEvent(autoAdapterId, "msg_priv_dup")

    // First dispatch
    await bus.dispatchInboundFull(event)
    expect(routeHandler).toHaveBeenCalledTimes(1)
    routeHandler.mockReset()

    // Duplicate dispatch
    await bus.dispatchInboundFull(event)
    expect(routeHandler).not.toHaveBeenCalled()

    const auditRows = await listRecent(autoAdapterId)
    expect(auditRows.some((r) => r.kind === "inbound.deduped")).toBe(true)
  })

  it("scenario 3: group message no @-mention in auto mode → drop, no inbound.received audit", async () => {
    const bus = getBus()
    await bus.dispatchInboundFull(groupEvent(autoAdapterId, "msg_group_no_mention", false))

    expect(routeHandler).not.toHaveBeenCalled()

    const auditRows = await listRecent(autoAdapterId)
    expect(auditRows.some((r) => r.kind === "inbound.received")).toBe(false)
    // drop is silent — no audit entry for the drop itself
  })

  it("scenario 4: group message with @-mention → ai-run", async () => {
    const bus = getBus()
    await bus.dispatchInboundFull(groupEvent(autoAdapterId, "msg_group_mention", true))

    expect(routeHandler).toHaveBeenCalledTimes(1)
    const [, decision] = routeHandler.mock.calls[0] as [
      NormalizedInboundEvent,
      RouteDecision,
      ResolvedBinding,
    ]
    expect(decision).toBe("ai-run")

    const auditRows = await listRecent(autoAdapterId)
    expect(auditRows.some((r) => r.kind === "inbound.received")).toBe(true)
  })

  it("scenario 5: private message in manual mode → manual-store, regardless of match", async () => {
    const bus = getBus()
    await bus.dispatchInboundFull(privateEvent(manualAdapterId, "msg_manual_1"))

    expect(routeHandler).toHaveBeenCalledTimes(1)
    const [, decision] = routeHandler.mock.calls[0] as [
      NormalizedInboundEvent,
      RouteDecision,
      ResolvedBinding,
    ]
    expect(decision).toBe("manual-store")

    const auditRows = await listRecent(manualAdapterId)
    expect(auditRows.some((r) => r.kind === "inbound.received")).toBe(true)
  })

  it("missing adapter instance → adapter.error audit, handler NOT called", async () => {
    const bus = getBus()
    const event = privateEvent("nonexistent_adapter", "msg_x")
    await bus.dispatchInboundFull(event)

    expect(routeHandler).not.toHaveBeenCalled()

    const auditRows = await listRecent("nonexistent_adapter")
    expect(auditRows.some((r) => r.kind === "adapter.error")).toBe(true)
  })

  // ── v83 lifecycle auto-reopen seam (Step 3.5) ────────────────────────────
  it("reopens a resolved conversation on fresh inbound and still routes ai-run", async () => {
    const bus = getBus()
    const ck = `telegram:${autoAdapterId}:private`
    await upsertByConversationKey({ conversationKey: ck, sessionId: "sess_x", status: "resolved" })

    await bus.dispatchInboundFull(privateEvent(autoAdapterId, "msg_reopen"))

    // Routing is unchanged by the seam.
    expect(routeHandler).toHaveBeenCalledTimes(1)
    const [, decision] = routeHandler.mock.calls[0] as [
      NormalizedInboundEvent,
      RouteDecision,
      ResolvedBinding,
    ]
    expect(decision).toBe("ai-run")
    // The conversation is reopened.
    expect((await readForResolution(ck))?.status).toBe("open")
  })

  it("wakes a snoozed conversation on fresh inbound", async () => {
    const bus = getBus()
    const ck = `telegram:${autoAdapterId}:private`
    await upsertByConversationKey({
      conversationKey: ck,
      sessionId: "sess_x",
      status: "snoozed",
      snoozeUntil: Date.now() + 999_999,
    })
    await bus.dispatchInboundFull(privateEvent(autoAdapterId, "msg_wake"))
    const row = await readForResolution(ck)
    expect(row?.status).toBe("open")
    expect(row?.snoozeUntil).toBeUndefined()
  })

  it("regression: an open/absent-status conversation is untouched by the seam", async () => {
    const bus = getBus()
    const ck = `telegram:${autoAdapterId}:private`
    // No override row at all → seam is a strict no-op; routing proceeds normally.
    await bus.dispatchInboundFull(privateEvent(autoAdapterId, "msg_open"))
    expect(routeHandler).toHaveBeenCalledTimes(1)
    // The seam must not create an override row or a status for an absent one.
    expect(await readForResolution(ck)).toBeUndefined()
  })
})
