/**
 * Integration test for the bus-level help / welcome wiring + the
 * `help_quick_command` callback short-circuit. Drives the real
 * `ConnectorBus.dispatchInboundFull` / `dispatchConnectorCallback` against a
 * fake-indexeddb so the thin bus hooks (which the unit tests in
 * `help-dispatch.test.ts` cannot exercise) are covered end-to-end.
 */

import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { createAdapterInstance } from "@/lib/db/adapter-instances"
import { getBus, __resetBusForTesting } from "@/lib/connectors/bus"
import { __resetPruneCounterForTesting } from "@/lib/connectors/dedup"
import { recordCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import {
  awaitApproval,
  pendingApprovalCount,
  __resetApprovalRegistryForTesting,
} from "@/lib/connectors/hitl/approval-registry"
import type { NormalizedInboundEvent, PlatformAdapter } from "@/types/connectors"
import type { ConnectorCallbackEvent } from "@/types/connectors/interaction"
import type { TriggerPolicy } from "@/types/connectors/policy"

const AUTO_TRIGGER: TriggerPolicy = {
  rules: [{ kind: "private-default" }, { kind: "self-mention" }],
  blockers: [],
  storeUnmatchedInDraftMode: false,
}

function makeAdapter(id: string): PlatformAdapter {
  return {
    id,
    meta: {
      type: "lark",
      displayName: `Bot ${id}`,
      version: "1.0.0",
      capabilities: [],
      transportModes: ["gateway"],
      configSchema: {},
    },
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    health: jest.fn().mockReturnValue({ state: "running" }),
    send: jest.fn().mockResolvedValue({ ok: true }),
  } as unknown as PlatformAdapter
}

function privateEvent(adapterId: string, messageId: string, text: string): NormalizedInboundEvent {
  return {
    platform: "lark",
    adapterId,
    selfId: "bot_1",
    messageId,
    conversationRef: { platform: "lark", adapterId, channelId: "oc_1" },
    conversationKey: `lark:${adapterId}:oc_1`,
    sender: { id: "lark:u1", platform: "lark", adapterId, remoteUserId: "u1" },
    channel: { id: `lark:${adapterId}:oc_1`, kind: "private", platformChannelId: "oc_1" },
    segments: [{ type: "text", text }],
    plainText: text,
    mentions: { selfMentioned: false, users: [] },
    timestamp: Date.now(),
    raw: {},
    kind: "create",
  }
}

function memberAddedEvent(adapterId: string, eventId: string): NormalizedInboundEvent {
  return {
    platform: "lark",
    adapterId,
    selfId: "bot_1",
    messageId: `lark.member:${eventId}`,
    conversationRef: { platform: "lark", adapterId, channelId: "oc_group" },
    conversationKey: `lark:${adapterId}:oc_group`,
    sender: { id: "lark:op", platform: "lark", adapterId, remoteUserId: "op" },
    channel: { id: `lark:${adapterId}:oc_group`, kind: "group", platformChannelId: "oc_group" },
    segments: [],
    plainText: "",
    mentions: { selfMentioned: false, users: [] },
    timestamp: Date.now(),
    raw: { header: { event_type: "im.chat.member.bot.added_v1" } },
    kind: "system",
    systemKind: "member_added",
  }
}

async function seedAdapter(over: Record<string, unknown> = {}): Promise<string> {
  const row = await createAdapterInstance({
    type: "lark",
    displayName: "Help Bot",
    enabled: true,
    transportMode: "gateway",
    settings: {
      quickCommands: [{ triggerKey: "agenda", action: { type: "prompt", value: "列出待办" } }],
    },
    credentialsRef: { keyringService: "test", accounts: [] },
    trigger: AUTO_TRIGGER,
    defaultMode: "auto",
    ...over,
  })
  return row.id
}

async function outboundCount(): Promise<number> {
  return getDb().outboundQueue.count()
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  __resetBusForTesting()
  __resetPruneCounterForTesting()
})

describe("bus help/welcome wiring", () => {
  it("serves a help card and skips the route handler on a help trigger", async () => {
    const adapterId = await seedAdapter()
    const bus = getBus()
    bus.registerAdapter(makeAdapter(adapterId))
    const routeHandler = jest.fn()
    bus.routeHandler = routeHandler

    await bus.dispatchInboundFull(privateEvent(adapterId, "m_help", "/help"))

    expect(routeHandler).not.toHaveBeenCalled()
    const jobs = await getDb().outboundQueue.toArray()
    // One help card (the help short-circuit returns before welcome fires).
    expect(jobs).toHaveLength(1)
    expect(jobs[0].request.segments[0].type).toBe("a2ui")
    const audit = await getDb().connectorAudit.toArray()
    expect(audit.some((r) => r.kind === "inbound.help_served")).toBe(true)
  })

  it("pushes a welcome card on bot member_added, once per conversation", async () => {
    const adapterId = await seedAdapter()
    const bus = getBus()
    bus.registerAdapter(makeAdapter(adapterId))

    await bus.dispatchInboundFull(memberAddedEvent(adapterId, "e1"))
    await bus.dispatchInboundFull(memberAddedEvent(adapterId, "e2"))

    // Second member_added on the same conversation must NOT re-welcome.
    expect(await outboundCount()).toBe(1)
    const audit = await getDb().connectorAudit.toArray()
    expect(audit.filter((r) => r.kind === "inbound.welcome_sent")).toHaveLength(1)
  })

  it("does not welcome when welcomeCardEnabled is false", async () => {
    const adapterId = await seedAdapter({ welcomeCardEnabled: false })
    const bus = getBus()
    bus.registerAdapter(makeAdapter(adapterId))
    await bus.dispatchInboundFull(memberAddedEvent(adapterId, "e1"))
    expect(await outboundCount()).toBe(0)
  })

  it("serves a control-command reply and skips the route handler on /status", async () => {
    const adapterId = await seedAdapter()
    const bus = getBus()
    bus.registerAdapter(makeAdapter(adapterId))
    const routeHandler = jest.fn()
    bus.routeHandler = routeHandler

    await bus.dispatchInboundFull(privateEvent(adapterId, "m_status", "/status"))

    expect(routeHandler).not.toHaveBeenCalled()
    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].request.segments[0].type).toBe("text")
    const audit = await getDb().connectorAudit.toArray()
    expect(audit.some((r) => r.kind === "command.applied")).toBe(true)
  })

  it("/model persists the modelOverride and skips the route handler", async () => {
    const adapterId = await seedAdapter()
    const bus = getBus()
    bus.registerAdapter(makeAdapter(adapterId))
    const routeHandler = jest.fn()
    bus.routeHandler = routeHandler

    await bus.dispatchInboundFull(privateEvent(adapterId, "m_model", "/model gpt-5"))

    expect(routeHandler).not.toHaveBeenCalled()
    const override = await getDb()
      .conversationOverrides.where("conversationKey")
      .equals(`lark:${adapterId}:oc_1`)
      .first()
    expect(override?.modelOverride).toBe("gpt-5")
  })

  it("/help still serves the rich help card (control dispatcher defers)", async () => {
    const adapterId = await seedAdapter()
    const bus = getBus()
    bus.registerAdapter(makeAdapter(adapterId))
    bus.routeHandler = jest.fn()

    await bus.dispatchInboundFull(privateEvent(adapterId, "m_help2", "/help"))

    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(1)
    // Rich A2UI card, NOT the plain-text control reply.
    expect(jobs[0].request.segments[0].type).toBe("a2ui")
  })

  it("resolves a pending tool approval when a tool_approve button callback fires", async () => {
    __resetApprovalRegistryForTesting()
    const adapterId = await seedAdapter()
    const bus = getBus()
    bus.registerAdapter(makeAdapter(adapterId))

    const actionId = "tapa:abcd1234"
    await recordCallbackBinding({
      adapterId,
      actionId,
      surfaceId: "tool_approve:sfc",
      componentId: "allow",
      conversationKey: `lark:${adapterId}:oc_1`,
      kind: "tool_approve",
      payload: { sessionId: "sess_x", requestId: "req_x", toolName: "Bash", decision: "allow" },
    })

    // A suspended turn is awaiting this approval.
    const pending = awaitApproval("sess_x", "req_x", { ttlMs: 0 })
    expect(pendingApprovalCount()).toBe(1)

    const callback: ConnectorCallbackEvent = {
      platform: "lark",
      adapterId,
      selfId: "bot_1",
      triggerId: actionId,
      surfaceId: "tool_approve:sfc",
      componentId: "allow",
      actionType: "button",
      value: "allow",
      conversationKey: `lark:${adapterId}:oc_1`,
      user: { id: "lark:u1", platform: "lark", adapterId, remoteUserId: "u1" },
      timestamp: Date.now(),
      raw: {},
    }
    await bus.dispatchConnectorCallback(callback)

    await expect(pending).resolves.toEqual({ decision: "allow" })
    const audit = await getDb().connectorAudit.toArray()
    expect(audit.some((r) => r.kind === "tool_approve.granted")).toBe(true)
  })

  it("runs a quick command when its help-card button callback fires", async () => {
    const adapterId = await seedAdapter()
    const bus = getBus()
    bus.registerAdapter(makeAdapter(adapterId))
    const routeHandler = jest.fn()
    bus.routeHandler = routeHandler

    const actionId = "a2ui:help_sfc:qc_0:qc:agenda"
    await recordCallbackBinding({
      adapterId,
      actionId,
      surfaceId: "help_sfc",
      componentId: "qc_0",
      conversationKey: `lark:${adapterId}:oc_1`,
      kind: "help_quick_command",
      payload: { action: { type: "prompt", value: "列出待办" } },
    })

    const callback: ConnectorCallbackEvent = {
      platform: "lark",
      adapterId,
      selfId: "bot_1",
      triggerId: actionId,
      surfaceId: "help_sfc",
      componentId: "qc_0",
      actionType: "button",
      value: "qc:agenda",
      conversationKey: `lark:${adapterId}:oc_1`,
      user: { id: "lark:u1", platform: "lark", adapterId, remoteUserId: "u1" },
      timestamp: Date.now(),
      raw: {},
    }
    await bus.dispatchConnectorCallback(callback)

    expect(routeHandler).toHaveBeenCalledTimes(1)
    const [event, decision] = routeHandler.mock.calls[0] as [NormalizedInboundEvent, string]
    expect(event.plainText).toBe("列出待办")
    expect(event.mentions.selfMentioned).toBe(true)
    expect(decision).toBe("ai-run")
  })
})
