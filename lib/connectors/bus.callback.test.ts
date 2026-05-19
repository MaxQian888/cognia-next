/**
 * Tests for ConnectorBus.dispatchConnectorCallback — Group 4.
 *
 * Verifies the 4-step pipeline (dedup → binding lookup → audit → handler)
 * and the audit-row matrix (callback.received / callback.deduped /
 * callback.unbound / callback.handler_failed).
 */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { __resetBusForTesting, getBus, type CallbackHandler } from "./bus"
import type { ConnectorCallbackEvent } from "@/types/connectors/interaction"
import type { PlatformIdentity } from "@/types/connectors/event"
import { recordCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"

const sender: PlatformIdentity = {
  id: "id-1",
  platform: "telegram",
  adapterId: "adp_tg",
  remoteUserId: "u_999",
  displayName: "Tester",
}

function makeEvent(overrides: Partial<ConnectorCallbackEvent> = {}): ConnectorCallbackEvent {
  return {
    platform: "telegram",
    adapterId: "adp_tg",
    selfId: "bot_1",
    triggerId: "trig_001",
    surfaceId: "sfc_from_event",
    componentId: "btn_1",
    actionType: "button",
    value: "confirm",
    payload: undefined,
    originatingMessageId: "msg_1",
    conversationKey: "telegram:adp_tg:c1",
    user: sender,
    timestamp: 1700000000000,
    raw: {},
    ...overrides,
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  __resetBusForTesting()
})

describe("ConnectorBus.dispatchConnectorCallback", () => {
  it("calls the handler and writes a callback.received audit row", async () => {
    const bus = getBus()
    const handler = jest.fn<ReturnType<CallbackHandler>, Parameters<CallbackHandler>>()
    bus.callbackHandler = handler
    await bus.dispatchConnectorCallback(makeEvent())
    expect(handler).toHaveBeenCalledTimes(1)
    const audit = await getDb().connectorAudit.toArray()
    expect(audit.some((r) => r.kind === "callback.received")).toBe(true)
  })

  it("dedupes a redelivered callback by triggerId (namespace=callback)", async () => {
    const bus = getBus()
    const handler = jest.fn<ReturnType<CallbackHandler>, Parameters<CallbackHandler>>()
    bus.callbackHandler = handler
    await bus.dispatchConnectorCallback(makeEvent({ triggerId: "dup_id" }))
    await bus.dispatchConnectorCallback(makeEvent({ triggerId: "dup_id" }))
    expect(handler).toHaveBeenCalledTimes(1)
    const audit = await getDb().connectorAudit.toArray()
    expect(audit.some((r) => r.kind === "callback.deduped")).toBe(true)
  })

  it("dedups callbacks SEPARATELY from inbound messages with the same id", async () => {
    // namespace isolation: an inbound message recording id `shared` should
    // NOT prevent a callback with id `shared` from dispatching.
    const { recordAndCheckInbound } = await import("./dedup")
    await recordAndCheckInbound("adp_tg", "shared", "inbound")
    const bus = getBus()
    const handler = jest.fn<ReturnType<CallbackHandler>, Parameters<CallbackHandler>>()
    bus.callbackHandler = handler
    await bus.dispatchConnectorCallback(makeEvent({ triggerId: "shared" }))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("resolves surfaceId/componentId/conversationKey from connectorCallbackBindings when present", async () => {
    await recordCallbackBinding({
      adapterId: "adp_tg",
      actionId: "trig_with_binding",
      surfaceId: "sfc_from_binding",
      componentId: "btn_from_binding",
      conversationKey: "telegram:adp_tg:other",
    })
    const bus = getBus()
    let received: ConnectorCallbackEvent | null = null
    bus.callbackHandler = (evt) => {
      received = evt
    }
    await bus.dispatchConnectorCallback(
      makeEvent({
        triggerId: "trig_with_binding",
        surfaceId: "sfc_from_event",
        componentId: "btn_from_event",
        conversationKey: "telegram:adp_tg:c1",
      })
    )
    expect(received).not.toBeNull()
    expect(received!.surfaceId).toBe("sfc_from_binding")
    expect(received!.componentId).toBe("btn_from_binding")
    expect(received!.conversationKey).toBe("telegram:adp_tg:other")
  })

  it("falls through to event surfaceId when no binding is found", async () => {
    const bus = getBus()
    let received: ConnectorCallbackEvent | null = null
    bus.callbackHandler = (evt) => {
      received = evt
    }
    await bus.dispatchConnectorCallback(makeEvent({ triggerId: "unbound" }))
    expect(received!.surfaceId).toBe("sfc_from_event")
  })

  it("aborts with callback.unbound when no surfaceId can be resolved", async () => {
    const bus = getBus()
    const handler = jest.fn<ReturnType<CallbackHandler>, Parameters<CallbackHandler>>()
    bus.callbackHandler = handler
    await bus.dispatchConnectorCallback(makeEvent({ triggerId: "orphan", surfaceId: "" }))
    expect(handler).not.toHaveBeenCalled()
    const audit = await getDb().connectorAudit.toArray()
    expect(audit.some((r) => r.kind === "callback.unbound")).toBe(true)
  })

  it("audits callback.handler_failed when handler throws", async () => {
    const bus = getBus()
    bus.callbackHandler = () => {
      throw new Error("kaboom")
    }
    await bus.dispatchConnectorCallback(makeEvent({ triggerId: "boom" }))
    const audit = await getDb().connectorAudit.toArray()
    expect(audit.some((r) => r.kind === "callback.handler_failed")).toBe(true)
  })

  it("is a no-op when callbackHandler is null (still writes audit)", async () => {
    const bus = getBus()
    bus.callbackHandler = null
    await bus.dispatchConnectorCallback(makeEvent({ triggerId: "no_handler" }))
    const audit = await getDb().connectorAudit.toArray()
    expect(audit.some((r) => r.kind === "callback.received")).toBe(true)
  })
})

// ── ADR-0026 — skill_invoke binding kind ─────────────────────────────
describe("ConnectorBus.dispatchConnectorCallback — skill_invoke kind", () => {
  it("routes Confirm click to the built-in skill dispatcher with hitlBypass=true", async () => {
    // Register a trivial test skill that records its invocation.
    const { registerBuiltInSkill, __resetSharedBuiltInSkillRegistry } =
      await import("@/lib/skills/built-in/registry")
    __resetSharedBuiltInSkillRegistry()
    let executed = false
    const { z } = await import("zod")
    registerBuiltInSkill({
      id: "test.skill",
      family: "test",
      label: { en: "test", "zh-CN": "测试" },
      description: { en: "test", "zh-CN": "测试" },
      platforms: "any",
      mutation: "write",
      imAccess: "always",
      mcpToolName: "test_skill",
      inputSchema: z.object({ x: z.string() }),
      execute: async () => {
        executed = true
        return { ok: true }
      },
      hitlSurface: () => ({
        components: {},
        dataModel: {},
        rootId: "sfc_t",
      }),
    })

    await recordCallbackBinding({
      adapterId: "adp_tg",
      actionId: "trig_skill_confirm",
      kind: "skill_invoke",
      surfaceId: "sfc_t",
      conversationKey: "telegram:adp_tg:c1",
      payload: { skillId: "test.skill", args: { x: "hi" } },
    })

    const bus = getBus()
    const handler = jest.fn<ReturnType<CallbackHandler>, Parameters<CallbackHandler>>()
    bus.callbackHandler = handler

    await bus.dispatchConnectorCallback(
      makeEvent({ triggerId: "trig_skill_confirm", value: "confirm" })
    )

    expect(executed).toBe(true)
    // Standard digest handler is bypassed.
    expect(handler).not.toHaveBeenCalled()

    __resetSharedBuiltInSkillRegistry()
  })

  it("audits builtin_skill_hitl_rejected on Cancel click", async () => {
    await recordCallbackBinding({
      adapterId: "adp_tg",
      actionId: "trig_skill_cancel",
      kind: "skill_invoke",
      surfaceId: "sfc_t",
      payload: { skillId: "anything", args: {} },
    })
    const bus = getBus()
    const handler = jest.fn<ReturnType<CallbackHandler>, Parameters<CallbackHandler>>()
    bus.callbackHandler = handler
    await bus.dispatchConnectorCallback(
      makeEvent({ triggerId: "trig_skill_cancel", value: "cancel" })
    )
    expect(handler).not.toHaveBeenCalled()
    const audit = await getDb().connectorAudit.toArray()
    expect(audit.some((r) => r.kind === "builtin_skill_hitl_rejected")).toBe(true)
  })

  it("audits builtin_skill_failed when the dispatcher throws", async () => {
    const { registerBuiltInSkill, __resetSharedBuiltInSkillRegistry } =
      await import("@/lib/skills/built-in/registry")
    __resetSharedBuiltInSkillRegistry()
    const { z } = await import("zod")
    registerBuiltInSkill({
      id: "test.boom",
      family: "test",
      label: { en: "t", "zh-CN": "t" },
      description: { en: "t", "zh-CN": "t" },
      platforms: "any",
      mutation: "write",
      imAccess: "always",
      mcpToolName: "test_boom",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        throw new Error("upstream 500")
      },
      hitlSurface: () => ({
        components: {},
        dataModel: {},
        rootId: "sfc_t",
      }),
    })

    await recordCallbackBinding({
      adapterId: "adp_tg",
      actionId: "trig_skill_boom",
      kind: "skill_invoke",
      surfaceId: "sfc_t",
      payload: { skillId: "test.boom", args: {} },
    })

    const bus = getBus()
    await bus.dispatchConnectorCallback(
      makeEvent({ triggerId: "trig_skill_boom", value: "confirm" })
    )
    const audit = await getDb().connectorAudit.toArray()
    // The dispatcher itself wrote builtin_skill_failed; the bus
    // doesn't re-audit because the dispatcher already did.
    expect(audit.some((r) => r.kind === "builtin_skill_failed")).toBe(true)

    __resetSharedBuiltInSkillRegistry()
  })
})
