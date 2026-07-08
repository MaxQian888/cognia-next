/** @jest-environment jsdom */
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

describe("ConnectorBus.dispatchConnectorCallback — wf_approve / wf_cancel kinds", () => {
  it("approve click does NOT invoke the generic handler and enqueues a workflow outbound", async () => {
    const { createWorkflow } = await import("@/lib/db/workflows")
    const wf = await createWorkflow({ name: "Daily Standup" })
    const conversationKey = "telegram:adp_tg:c1"
    await recordCallbackBinding({
      adapterId: "adp_tg",
      actionId: "wfapp:trigwf1",
      kind: "wf_approve",
      surfaceId: "wfsurf:trigwf1",
      componentId: "approve",
      conversationKey,
      payload: {
        workflowId: wf.id,
        workflowName: "Daily Standup",
        runParams: {},
        triggeredFrom: {
          source: "im",
          adapterId: "adp_tg",
          conversationKey,
          sessionId: "s1",
        },
      },
    })

    const bus = getBus()
    const handler = jest.fn<ReturnType<CallbackHandler>, Parameters<CallbackHandler>>()
    bus.callbackHandler = handler
    await bus.dispatchConnectorCallback(
      makeEvent({ triggerId: "wfapp:trigwf1", value: "approve", conversationKey })
    )
    expect(handler).not.toHaveBeenCalled()

    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].source).toBe("workflow")
    expect((jobs[0].request.segments[0] as { text: string }).text).toContain("已启动")
  })

  it("cancel click skips the start path and enqueues a cancellation outbound", async () => {
    const { createWorkflow } = await import("@/lib/db/workflows")
    const wf = await createWorkflow({ name: "Daily Standup" })
    const conversationKey = "telegram:adp_tg:c1"
    await recordCallbackBinding({
      adapterId: "adp_tg",
      actionId: "wfcan:trigwf2",
      kind: "wf_cancel",
      surfaceId: "wfsurf:trigwf2",
      componentId: "cancel",
      conversationKey,
      payload: {
        workflowId: wf.id,
        workflowName: "Daily Standup",
        runParams: {},
        triggeredFrom: {
          source: "im",
          adapterId: "adp_tg",
          conversationKey,
          sessionId: "s1",
        },
      },
    })

    const bus = getBus()
    const handler = jest.fn<ReturnType<CallbackHandler>, Parameters<CallbackHandler>>()
    bus.callbackHandler = handler
    await bus.dispatchConnectorCallback(
      makeEvent({ triggerId: "wfcan:trigwf2", value: "cancel", conversationKey })
    )
    expect(handler).not.toHaveBeenCalled()

    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(1)
    expect((jobs[0].request.segments[0] as { text: string }).text).toContain("已取消")
    const runs = await getDb().workflowRuns.toArray()
    expect(runs.find((r) => r.workflowId === wf.id)).toBeUndefined()
  })
})

describe("ConnectorBus.dispatchConnectorCallback — wf_fanout_approve / wf_fanout_cancel kinds", () => {
  it("approve click writes a workflowFanoutSubscriptions row + skips the digest handler", async () => {
    const { createWorkflow } = await import("@/lib/db/workflows")
    const wf = await createWorkflow({ name: "Release Pipeline" })
    const conversationKey = "telegram:adp_tg:c1"
    await recordCallbackBinding({
      adapterId: "adp_tg",
      actionId: "wffanoutapp:trigsub1",
      kind: "wf_fanout_approve",
      surfaceId: "wffanout:trigsub1",
      componentId: "approve",
      conversationKey,
      payload: {
        workflowId: wf.id,
        workflowName: "Release Pipeline",
        target: { adapterId: "adp_tg", conversationKey },
        createdBy: "claude-tool",
      },
    })

    const bus = getBus()
    const handler = jest.fn<ReturnType<CallbackHandler>, Parameters<CallbackHandler>>()
    bus.callbackHandler = handler
    await bus.dispatchConnectorCallback(
      makeEvent({ triggerId: "wffanoutapp:trigsub1", value: "approve", conversationKey })
    )
    expect(handler).not.toHaveBeenCalled()

    const subs = await getDb().workflowFanoutSubscriptions.toArray()
    expect(subs).toHaveLength(1)
    expect(subs[0]).toMatchObject({
      workflowId: wf.id,
      adapterId: "adp_tg",
      conversationKey,
      enabled: true,
    })

    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(1)
    expect((jobs[0].request.segments[0] as { text: string }).text).toContain("已订阅")
  })

  it("cancel click skips the subscription write + enqueues a cancellation outbound", async () => {
    const { createWorkflow } = await import("@/lib/db/workflows")
    const wf = await createWorkflow({ name: "Release Pipeline" })
    const conversationKey = "telegram:adp_tg:c1"
    await recordCallbackBinding({
      adapterId: "adp_tg",
      actionId: "wffanoutcan:trigsub2",
      kind: "wf_fanout_cancel",
      surfaceId: "wffanout:trigsub2",
      componentId: "cancel",
      conversationKey,
      payload: {
        workflowId: wf.id,
        workflowName: "Release Pipeline",
        target: { adapterId: "adp_tg", conversationKey },
        createdBy: "claude-tool",
      },
    })

    const bus = getBus()
    const handler = jest.fn<ReturnType<CallbackHandler>, Parameters<CallbackHandler>>()
    bus.callbackHandler = handler
    await bus.dispatchConnectorCallback(
      makeEvent({ triggerId: "wffanoutcan:trigsub2", value: "cancel", conversationKey })
    )
    expect(handler).not.toHaveBeenCalled()

    expect(await getDb().workflowFanoutSubscriptions.toArray()).toHaveLength(0)
    const jobs = await getDb().outboundQueue.toArray()
    expect((jobs[0].request.segments[0] as { text: string }).text).toContain("已取消")
  })
})
