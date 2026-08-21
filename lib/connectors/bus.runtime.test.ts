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
import { createAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { upsertByConversationKey, readForResolution } from "@/lib/db/conversation-overrides"
import { getByPlatformUser } from "@/lib/db/platform-identities"
import { listRecent } from "@/lib/db/connector-audit"
import { listRecentGovernanceAuditGaps } from "@/lib/db/governance-ledger"
import { getBus, __resetBusForTesting } from "./bus"
import { LarkFollowUpControlDispatchError } from "./follow-up-control"
import { __resetPruneCounterForTesting } from "./dedup"
import { recordDeliveredMessage } from "./delivered-messages"
import type { NormalizedInboundEvent, PlatformAdapter } from "@/types/connectors"
import type { RouteDecision } from "./mode-router"
import type { ResolvedBinding } from "./policy-resolve"
import type { TriggerPolicy } from "@/types/connectors/policy"

const mockRecordConnectorRouteGovernance = jest.fn().mockResolvedValue("connector-decision")
jest.mock("@/lib/governance/producers/connector", () => ({
  recordConnectorRouteGovernance: (...args: unknown[]) =>
    mockRecordConnectorRouteGovernance(...args),
}))

// Plugin connector hook + PII gate are mocked so the bus inbound block/transform
// path can be driven deterministically (the PII heuristics are tested in their
// own suite). Default: allow + PII-clean.
const mockConnectorDecision = jest.fn(async () => ({ action: "allow" }) as unknown)
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({ dispatchConnectorDecision: mockConnectorDecision }),
}))
const mockPiiDeep = jest.fn(() => true)
jest.mock("@cognia/redact", () => ({
  hasNoLeakingPiiDeep: (...args: unknown[]) => mockPiiDeep(...(args as [])),
  hasNoLeakingPii: () => true,
}))

// `bus.ts` imports the GENERALIZED name (`maybeHandleRunControlFollowUp`);
// `maybeHandleLarkFollowUpControl` is only the back-compat alias. Stubbing the
// alias alone left the real implementation wired into the bus, so both
// follow-up-control tests below were asserting against unstubbed behaviour.
// Override both names off the same jest.fn so either import site is stubbed.
const mockMaybeHandleLarkFollowUpControl = jest.fn(async (..._args: unknown[]) => false)
jest.mock("./follow-up-control", () => ({
  ...jest.requireActual("./follow-up-control"),
  maybeHandleRunControlFollowUp: (...args: unknown[]) =>
    mockMaybeHandleLarkFollowUpControl(...args),
  maybeHandleLarkFollowUpControl: (...args: unknown[]) =>
    mockMaybeHandleLarkFollowUpControl(...args),
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
    mockMaybeHandleLarkFollowUpControl.mockReset()
    mockMaybeHandleLarkFollowUpControl.mockResolvedValue(false)
    mockRunInboundOcr.mockClear()
    mockRecordConnectorRouteGovernance.mockReset().mockResolvedValue("connector-decision")

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
    // 30s hook budget: the first cold open of the full schema (100+ Dexie
    // versions) can exceed jest's default 5s under parallel suite load.
  }, 30_000)

  it("short-circuits a matched follow-up control and completes its durable inbound job", async () => {
    mockMaybeHandleLarkFollowUpControl.mockResolvedValue(true)
    const event = privateEvent(autoAdapterId, "msg_follow_up")

    await getBus().dispatchInboundFull(event)
    await getBus().flushInboundTurns()

    expect(routeHandler).not.toHaveBeenCalled()
    const job = await getDb()
      .connectorInboundJobs.filter((row) => row.sourceMessageId === event.messageId)
      .first()
    expect(job?.status).toBe("completed")
    expect(
      (await listRecent(autoAdapterId)).some((row) => row.reason === "lark_follow_up_control")
    ).toBe(true)
  })

  it("does not reinterpret a failed matched follow-up label as an AI prompt", async () => {
    mockMaybeHandleLarkFollowUpControl.mockRejectedValue(
      new LarkFollowUpControlDispatchError(new Error("control storage unavailable"))
    )
    const event = privateEvent(autoAdapterId, "msg_follow_up_failed")

    await getBus().dispatchInboundFull(event)
    await getBus().flushInboundTurns()

    expect(routeHandler).not.toHaveBeenCalled()
    const job = await getDb()
      .connectorInboundJobs.filter((row) => row.sourceMessageId === event.messageId)
      .first()
    expect(job?.status).toBe("completed")
    expect(
      (await listRecent(autoAdapterId)).some(
        (row) => row.reason === "lark_follow_up_control_failed"
      )
    ).toBe(true)
  })

  it("falls through normally when no follow-up registration matches", async () => {
    await getBus().dispatchInboundFull(privateEvent(autoAdapterId, "msg_not_follow_up"))
    await getBus().flushInboundTurns()
    expect(routeHandler).toHaveBeenCalledTimes(1)
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
    await bus.flushInboundTurns()
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
    await bus.flushInboundTurns()
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
    await bus.flushInboundTurns()
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
    await bus.flushInboundTurns()

    expect(routeHandler).toHaveBeenCalledTimes(1)
    const [, decision] = routeHandler.mock.calls[0] as [
      NormalizedInboundEvent,
      RouteDecision,
      ResolvedBinding,
    ]
    expect(decision).toBe("ai-run")
    expect(mockRecordConnectorRouteGovernance).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: autoAdapterId,
        messageId: "msg_priv_1",
        mode: "auto",
        evaluation: expect.objectContaining({ matched: true, blocked: false }),
        route: "ai-run",
      })
    )

    const auditRows = await listRecent(autoAdapterId)
    expect(auditRows.some((r) => r.kind === "inbound.received")).toBe(true)
  })

  it("keeps inbound routing available when governance projection fails", async () => {
    mockRecordConnectorRouteGovernance.mockRejectedValueOnce(new Error("ledger unavailable"))

    await getBus().dispatchInboundFull(privateEvent(autoAdapterId, "msg_governance_failed"))
    await getBus().flushInboundTurns()

    expect(routeHandler).toHaveBeenCalledTimes(1)
    await expect(listRecentGovernanceAuditGaps()).resolves.toEqual([
      expect.objectContaining({
        eventType: "governance.projection.failed",
        subjectKey: `cognia:connector-route:${autoAdapterId}:msg_governance_failed`,
        data: {
          producer: "connector-route",
          operation: "record",
          errorType: "Error",
        },
      }),
    ])
  })

  it("binds the durable inbound job to the execution run before handler side effects", async () => {
    const bus = getBus()
    routeHandler.mockImplementationOnce(
      async (_event, _decision, _resolved, _override, _row, ctx) => {
        await ctx.bindExecutionRun("execution:bound")
      }
    )
    await bus.dispatchInboundFull(privateEvent(autoAdapterId, "msg_bound_run"))
    await bus.flushInboundTurns()

    const job = await getDb()
      .connectorInboundJobs.filter((row) => row.sourceMessageId === "msg_bound_run")
      .first()
    expect(job).toEqual(
      expect.objectContaining({ status: "completed", executionRunId: "execution:bound" })
    )
  })

  it("keeps unsafe live-steer payloads durable for safe-boundary replay", async () => {
    const bus = getBus()
    await updateAdapterInstance(autoAdapterId, { activeRunDispatchMode: "steer" })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    routeHandler.mockImplementationOnce(async () => gate).mockResolvedValueOnce(undefined)
    bus.liveSteerHandler = jest.fn(async () => ({
      activeRun: true,
      accepted: true,
      executionRunId: "execution:unsafe",
    }))

    await bus.dispatchInboundFull(privateEvent(autoAdapterId, "msg_active_safe_boundary"))
    mockPiiDeep.mockReturnValue(false)
    await bus.dispatchInboundFull(privateEvent(autoAdapterId, "msg_unsafe_steer"))

    expect(bus.liveSteerHandler).not.toHaveBeenCalled()
    const queued = await getDb()
      .connectorInboundJobs.filter((row) => row.sourceMessageId === "msg_unsafe_steer")
      .first()
    expect(queued).toEqual(expect.objectContaining({ status: "steering" }))

    release()
    await bus.flushInboundTurns()
    expect(routeHandler.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        messageId: "msg_unsafe_steer",
        channelData: expect.objectContaining({ dispatchIntent: "steer-replay" }),
      })
    )
    const audit = await listRecent(autoAdapterId)
    expect(audit).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "live_steer_pii_blocked" })])
    )
  })

  it("records an unmentioned Lark probe durably before enabling all-message delivery", async () => {
    const bus = getBus()
    const now = Date.now()
    const row = await createAdapterInstance({
      type: "lark",
      displayName: "Probe Bot",
      enabled: true,
      transportMode: "stub",
      settings: {
        unmentionedDeliveryProbe: {
          consoleConfirmed: true,
          startedAt: now - 1_000,
          expiresAt: now + 60_000,
        },
      },
      credentialsRef: { keyringService: "test", accounts: [] },
      trigger: AUTO_TRIGGER,
      defaultMode: "auto",
      inboundActivationPolicy: "mention_activates",
      deliveryReadiness: "mentions_only",
    })
    const larkAdapter = makeAdapter(row.id)
    Object.defineProperty(larkAdapter.meta, "type", { value: "lark" })
    bus.registerAdapter(larkAdapter)
    const conversationKey = `lark:${row.id}:oc-1:omt-1`
    const event: NormalizedInboundEvent = {
      platform: "lark",
      adapterId: row.id,
      selfId: "ou_bot",
      messageId: "om_probe",
      conversationKey,
      conversationAddress: {
        conversationKey,
        platform: "lark",
        adapterId: row.id,
        scopeKind: "thread",
        containerId: "oc-1",
        topicId: "omt-1",
      },
      conversationRef: {
        platform: "lark",
        adapterId: row.id,
        channelId: "oc-1",
        threadTs: "omt-1",
        threadRootMessageId: "om_probe",
      },
      sender: {
        id: "ou_human",
        platform: "lark",
        adapterId: row.id,
        remoteUserId: "ou_human",
        kind: "human",
      },
      channel: { id: conversationKey, kind: "thread", platformChannelId: "oc-1" },
      segments: [{ type: "text", text: "probe" }],
      plainText: "probe",
      mentions: { selfMentioned: false, users: [] },
      timestamp: now,
      raw: {},
    }

    await bus.dispatchInboundFull(event)
    expect((await getDb().adapterInstances.get(row.id))?.deliveryReadiness).toBe(
      "all_messages_verified"
    )
    expect(
      await getDb()
        .connectorInboundJobs.filter((job) => job.sourceMessageId === "om_probe")
        .first()
    ).toEqual(
      expect.objectContaining({
        status: "history_only",
        recoveryReason: "delivery_probe_observed",
      })
    )
    expect(routeHandler).not.toHaveBeenCalled()
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

  it("falls back to the bot-wide default SLA when the conversation has none (slice 1B)", async () => {
    const bus = getBus()
    await updateAdapterInstance(autoAdapterId, { defaultSlaResponseMinutes: 15 } as never)
    const conversationKey = `telegram:${autoAdapterId}:private`
    await upsertByConversationKey({ conversationKey, sessionId: "s_default_sla" })

    const before = Date.now()
    await bus.dispatchInboundFull(privateEvent(autoAdapterId, "msg_sla_default_1"))

    const row = await readForResolution(conversationKey)
    expect(row?.nextResponseDueAt).toBeDefined()
    expect(row!.nextResponseDueAt!).toBeGreaterThanOrEqual(before + 15 * 60_000 - 1000)
    expect(row!.nextResponseDueAt!).toBeLessThanOrEqual(Date.now() + 15 * 60_000 + 1000)
  })

  it("stamps the bot-default SLA on a conversation without an override row when a session is bound", async () => {
    const bus = getBus()
    await updateAdapterInstance(autoAdapterId, { defaultSlaResponseMinutes: 10 } as never)
    const conversationKey = `telegram:${autoAdapterId}:private`
    // No override row, but a bound platform session → the bus can create the row.
    await getDb().sessions.add({
      id: "s_bound_sla",
      title: "bound",
      kind: "direct",
      createdAt: 1,
      updatedAt: 1,
      platformBinding: {
        platform: "telegram",
        adapterId: autoAdapterId,
        conversationKey,
        conversationRef: { platform: "telegram", adapterId: autoAdapterId },
      },
      platformConversationKey: conversationKey,
    } as never)

    await bus.dispatchInboundFull(privateEvent(autoAdapterId, "msg_sla_default_2"))

    const row = await readForResolution(conversationKey)
    expect(row?.sessionId).toBe("s_bound_sla")
    expect(row?.nextResponseDueAt).toBeDefined()
  })

  it("leaves the SLA deadline unset for a first-ever inbound with no session (runtime backfills it)", async () => {
    const bus = getBus()
    await updateAdapterInstance(autoAdapterId, { defaultSlaResponseMinutes: 10 } as never)
    const conversationKey = `telegram:${autoAdapterId}:private`
    await bus.dispatchInboundFull(privateEvent(autoAdapterId, "msg_sla_default_3"))
    expect(await readForResolution(conversationKey)).toBeUndefined()
    // The pipeline still reached the route handler.
    expect(routeHandler).toHaveBeenCalled()
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
    await bus.flushInboundTurns()
    expect(routeHandler).toHaveBeenCalledTimes(1)
    routeHandler.mockReset()

    // Duplicate dispatch
    await bus.dispatchInboundFull(event)
    await bus.flushInboundTurns()
    expect(routeHandler).not.toHaveBeenCalled()

    const auditRows = await listRecent(autoAdapterId)
    expect(auditRows.some((r) => r.kind === "inbound.deduped")).toBe(true)
  })

  it("persists dispatch mode before execution and completes the durable job", async () => {
    const bus = getBus()
    await updateAdapterInstance(autoAdapterId, { activeRunDispatchMode: "steer" })
    const event = privateEvent(autoAdapterId, "msg_durable_steer")

    await bus.dispatchInboundFull(event)
    const queued = await getDb()
      .connectorInboundJobs.toCollection()
      .filter((job) => job.sourceMessageId === event.messageId)
      .first()
    expect(queued).toEqual(
      expect.objectContaining({
        dispatchMode: "steer",
      })
    )

    await bus.flushInboundTurns()
    expect(await getDb().connectorInboundJobs.get(queued!.id)).toEqual(
      expect.objectContaining({ dispatchMode: "steer", status: "completed" })
    )
  })

  it("leaves a failed model turn recovery-required instead of replaying it", async () => {
    const bus = getBus()
    routeHandler.mockRejectedValueOnce(new Error("ambiguous side effect"))
    const event = privateEvent(autoAdapterId, "msg_recovery_required")

    await bus.dispatchInboundFull(event)
    await bus.flushInboundTurns()

    expect(
      await getDb()
        .connectorInboundJobs.toCollection()
        .filter((job) => job.sourceMessageId === event.messageId)
        .first()
    ).toEqual(
      expect.objectContaining({
        status: "recovery_required",
        recoveryReason: "route_handler_failed",
        lastError: "ambiguous side effect",
      })
    )
  })

  it("dedup is scoped per conversation: same messageId in two chats both deliver", async () => {
    // Telegram message_id (and Slack ts) are only unique per CHAT — the
    // pre-fix (adapterId, messageId) dedup key permanently dropped the
    // second chat's message.
    const bus = getBus()
    const inChat = (chat: string): NormalizedInboundEvent => ({
      ...privateEvent(autoAdapterId, "42"),
      conversationKey: `telegram:${autoAdapterId}:${chat}`,
      channel: { id: `ch_${chat}`, kind: "private" },
    })
    await bus.dispatchInboundFull(inChat("chatA"))
    await bus.dispatchInboundFull(inChat("chatB"))
    await bus.flushInboundTurns()
    expect(routeHandler).toHaveBeenCalledTimes(2)

    // A true redelivery (same chat, same id) still dedups.
    routeHandler.mockReset()
    await bus.dispatchInboundFull(inChat("chatA"))
    await bus.flushInboundTurns()
    expect(routeHandler).not.toHaveBeenCalled()
    const auditRows = await listRecent(autoAdapterId)
    expect(auditRows.some((r) => r.kind === "inbound.deduped")).toBe(true)
  })

  it("prunes the rate-limit buckets to the 60s window on write (bounded map)", async () => {
    const bus = getBus()
    const state = bus.__getPolicyStateForTesting()
    // Seed a stale foreign bucket and stale entries in the event's own bucket.
    // Keys are tenant-scoped (`${tenant}|${user}:${channel}`); this fixture
    // has no tenant, so both use the "-" scope.
    state.recentByUserAndChannel["-|ghost:ch_gone"] = [Date.now() - 120_000]
    state.recentByUserAndChannel["-|u_alice:ch_private"] = [Date.now() - 120_000]

    await bus.dispatchInboundFull(privateEvent(autoAdapterId, "msg_prune_1"))
    await bus.flushInboundTurns()

    const map = bus.__getPolicyStateForTesting().recentByUserAndChannel
    // Stale foreign bucket deleted entirely; own bucket keeps only the fresh stamp.
    expect(map["-|ghost:ch_gone"]).toBeUndefined()
    expect(map["-|u_alice:ch_private"]).toHaveLength(1)
    expect(map["-|u_alice:ch_private"][0]).toBeGreaterThan(Date.now() - 5_000)
  })

  it("scenario 3: group message no @-mention in auto mode → drop, no inbound.received audit", async () => {
    const bus = getBus()
    await bus.dispatchInboundFull(groupEvent(autoAdapterId, "msg_group_no_mention", false))
    await bus.flushInboundTurns()

    expect(routeHandler).not.toHaveBeenCalled()

    const auditRows = await listRecent(autoAdapterId)
    expect(auditRows.some((r) => r.kind === "inbound.received")).toBe(false)
    // drop is silent — no audit entry for the drop itself
  })

  it("scenario 4: group message with @-mention → ai-run", async () => {
    const bus = getBus()
    await bus.dispatchInboundFull(groupEvent(autoAdapterId, "msg_group_mention", true))
    await bus.flushInboundTurns()

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

  it("resolves the replied-to author from the delivered-message ledger before policy eval", async () => {
    // A third adapter whose ONLY trigger rule is `reply-to-bot`.
    const replyRow = await createAdapterInstance({
      type: "telegram",
      displayName: "Reply Bot",
      enabled: true,
      transportMode: "stub",
      settings: {},
      credentialsRef: { keyringService: "test", accounts: [] },
      trigger: {
        rules: [{ kind: "reply-to-bot" }],
        blockers: [],
        storeUnmatchedInDraftMode: false,
      },
      defaultMode: "auto",
    })
    const bus = getBus()
    bus.registerAdapter(makeAdapter(replyRow.id))

    const conversationKey = `telegram:${replyRow.id}:group`
    // We delivered platform message "bot_out_7" into this group earlier.
    await recordDeliveredMessage(replyRow.id, conversationKey, "bot_out_7")

    const replyToOurs: NormalizedInboundEvent = {
      ...groupEvent(replyRow.id, "msg_reply_ours", false),
      conversationKey,
      replyTo: { messageId: "bot_out_7", snippet: "…" },
    }
    await bus.dispatchInboundFull(replyToOurs)
    await bus.flushInboundTurns()
    expect(routeHandler).toHaveBeenCalledTimes(1)
    const [seen, decision] = routeHandler.mock.calls[0] as [NormalizedInboundEvent, RouteDecision]
    expect(decision).toBe("ai-run")
    expect(seen.replyTo?.parentSenderId).toBe("bot_1")
    expect(seen.channelData?.replyParentResolvedBy).toBe("ledger")

    // A reply to a message we never sent stays unknown → not a reply to the bot → dropped.
    routeHandler.mockClear()
    const replyToHuman: NormalizedInboundEvent = {
      ...groupEvent(replyRow.id, "msg_reply_human", false),
      conversationKey,
      replyTo: { messageId: "human_msg_1", snippet: "…" },
    }
    await bus.dispatchInboundFull(replyToHuman)
    await bus.flushInboundTurns()
    expect(routeHandler).not.toHaveBeenCalled()

    // Adapter-supplied parent authors are trusted as-is (no ledger stamp).
    const replyWithParent: NormalizedInboundEvent = {
      ...groupEvent(replyRow.id, "msg_reply_parent", false),
      conversationKey,
      replyTo: { messageId: "x", snippet: "…", parentSenderId: "u_other" },
    }
    await bus.dispatchInboundFull(replyWithParent)
    await bus.flushInboundTurns()
    expect(routeHandler).not.toHaveBeenCalled()
  })

  it("scenario 5: private message in manual mode → manual-store, regardless of match", async () => {
    const bus = getBus()
    await bus.dispatchInboundFull(privateEvent(manualAdapterId, "msg_manual_1"))
    await bus.flushInboundTurns()

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
    await bus.flushInboundTurns()

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
    await bus.flushInboundTurns()

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
    await bus.flushInboundTurns()
    expect(routeHandler).toHaveBeenCalledTimes(1)
    // The seam must not create an override row or a status for an absent one.
    expect(await readForResolution(ck)).toBeUndefined()
  })
})
