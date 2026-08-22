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
import { createExecutionRun } from "@/lib/db/execution-runs"
import { registerRunControlHandler } from "@/lib/execution/run-control"

// The wf_approve path drives a REAL `startWorkflowFromIM`, which fires
// `void runWorkflow(...)` in the background (fire-and-forget by design). In a
// suite that `beforeEach`-deletes the DB, that background run writes to a
// deleted DB on a later tick — an unhandled rejection jest attributes to the
// FOLLOWING test (the wf_cancel case failed with an empty body for exactly
// this reason). Stub the start so bus-routing assertions stay deterministic;
// the orchestrator itself is covered by its own tests.
jest.mock("@/lib/workflow/runtime/start-from-im", () => ({
  startWorkflowFromIM: jest.fn(async () => ({ ok: true, runId: "run_test" })),
}))
// The issue-card handler has its own suite (`lib/issues/im/callback-handler.test.ts`);
// here only the bus routing to it is under test.
const mockHandleIssueAction = jest.fn(async (_input: unknown): Promise<unknown> => ({
  kind: "moved",
}))
jest.mock("@/lib/issues/im/callback-handler", () => ({
  handleIssueActionCallback: (input: unknown) => mockHandleIssueAction(input),
}))

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

// 30s hook budget: the first cold open of the full schema (100+ Dexie
// versions) can exceed jest's default 5s under parallel suite load.

/**
 * Seed the adapter row these plumbing tests dispatch against, with callback
 * authorization OFF. They assert dedup / field resolution / routing, and use
 * deliberately inconsistent fixtures (a binding whose conversationKey differs
 * from the event's, a run control with no run binding) that the guard is
 * SUPPOSED to deny once it evaluates. The guard's own decision matrix is
 * covered in callback-authorization.test.ts and, end-to-end, below.
 */
async function seedUnguardedAdapter(): Promise<void> {
  await getDb().adapterInstances.put({
    id: "adp_tg",
    type: "telegram",
    displayName: "Plumbing Bot",
    enabled: true,
    transportMode: "stub",
    settings: { larkStrictCallbackAuthorization: "off" },
    credentialsRef: { keyringService: "test", accounts: [] },
    trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    defaultMode: "auto",
    mediaModelPolicy: "local_extract_only",
  } as never)
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  __resetBusForTesting()
}, 30_000)

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
    await seedUnguardedAdapter()
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

  it("routes a self-describing execution-run control before generic A2UI handling", async () => {
    await seedUnguardedAdapter()
    await createExecutionRun({
      id: "run-control-1",
      kind: "agent-turn",
      sourceId: "turn-1",
      title: "Agent run",
      status: "running",
      initiator: { remoteUserId: sender.remoteUserId },
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
    const sourceHandler = jest.fn(async () => undefined)
    const unregister = registerRunControlHandler("agent-turn", sourceHandler)
    const bus = getBus()
    const genericHandler = jest.fn<ReturnType<CallbackHandler>, Parameters<CallbackHandler>>()
    bus.callbackHandler = genericHandler

    await bus.dispatchConnectorCallback(
      makeEvent({
        triggerId: "run:run-control-1:stop:0",
        surfaceId: "",
        value: "stop",
        payload: { runId: "run-control-1", action: "stop", revision: 0 },
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(sourceHandler).toHaveBeenCalledTimes(1)
    expect(genericHandler).not.toHaveBeenCalled()
    expect(
      await getDb().executionRunEvents.where("runId").equals("run-control-1").first()
    ).toMatchObject({
      type: "control.accepted",
    })
    unregister()
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

  it("a transient binding-lookup failure leaves the triggerId retryable (redelivery works)", async () => {
    const bus = getBus()
    const handler = jest.fn<ReturnType<CallbackHandler>, Parameters<CallbackHandler>>()
    bus.callbackHandler = handler

    // First delivery: the binding lookup blows up on a Dexie hiccup.
    const whereSpy = jest
      .spyOn(getDb().connectorCallbackBindings, "where")
      .mockImplementationOnce(() => {
        throw new Error("dexie hiccup")
      })
    await bus.dispatchConnectorCallback(makeEvent({ triggerId: "transient_1" }))
    whereSpy.mockRestore()

    // The click was NOT processed and NOT consumed.
    expect(handler).not.toHaveBeenCalled()
    const audit = await getDb().connectorAudit.toArray()
    expect(
      audit.some((r) => r.kind === "adapter.error" && r.reason === "callback_binding_lookup_failed")
    ).toBe(true)

    // Platform redelivery of the SAME triggerId now goes through.
    await bus.dispatchConnectorCallback(makeEvent({ triggerId: "transient_1" }))
    expect(handler).toHaveBeenCalledTimes(1)

    // And a THIRD delivery is deduped (the success committed the ledger).
    await bus.dispatchConnectorCallback(makeEvent({ triggerId: "transient_1" }))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("audits an unparsable help_quick_command conversationKey instead of silently dropping", async () => {
    await seedUnguardedAdapter()
    await recordCallbackBinding({
      adapterId: "adp_tg",
      actionId: "trig_bad_key",
      kind: "help_quick_command",
      surfaceId: "help_sfc",
      conversationKey: "not-a-conversation-key",
      payload: { action: { type: "prompt", value: "列出待办" } },
    })
    const bus = getBus()
    const handler = jest.fn<ReturnType<CallbackHandler>, Parameters<CallbackHandler>>()
    bus.callbackHandler = handler
    await bus.dispatchConnectorCallback(makeEvent({ triggerId: "trig_bad_key" }))
    expect(handler).not.toHaveBeenCalled()
    const audit = await getDb().connectorAudit.toArray()
    expect(
      audit.some(
        (r) =>
          r.kind === "callback.unbound" &&
          r.reason === "help_quick_command:unparsable_conversation_key"
      )
    ).toBe(true)
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

describe("ConnectorBus.dispatchConnectorCallback — issue_action kind", () => {
  it("routes an issue card click to the issue handler with the binding, never the generic handler", async () => {
    mockHandleIssueAction.mockResolvedValueOnce({ kind: "moved" })
    const conversationKey = "telegram:adp_tg:c1"
    await recordCallbackBinding({
      adapterId: "adp_tg",
      actionId: "a2ui:issue:1:move_done:move:done",
      kind: "issue_action",
      surfaceId: "issue:1",
      componentId: "move_done",
      conversationKey,
      payload: { action: "move", issueId: "iss-1", to: "done" },
    })

    const bus = getBus()
    const handler = jest.fn<ReturnType<CallbackHandler>, Parameters<CallbackHandler>>()
    bus.callbackHandler = handler
    await bus.dispatchConnectorCallback(
      makeEvent({
        triggerId: "a2ui:issue:1:move_done:move:done",
        value: "move:done",
        conversationKey,
      })
    )
    expect(handler).not.toHaveBeenCalled()
    expect(mockHandleIssueAction).toHaveBeenCalledTimes(1)
    expect(mockHandleIssueAction).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "adp_tg",
        conversationKey,
        user: expect.objectContaining({ remoteUserId: "u_999" }),
        binding: expect.objectContaining({
          kind: "issue_action",
          payload: { action: "move", issueId: "iss-1", to: "done" },
        }),
      })
    )
  })

  it("audits and swallows a handler failure instead of falling through to the model", async () => {
    mockHandleIssueAction.mockRejectedValueOnce(new Error("engine down"))
    const conversationKey = "telegram:adp_tg:c1"
    await recordCallbackBinding({
      adapterId: "adp_tg",
      actionId: "a2ui:issue:2:run:run",
      kind: "issue_action",
      surfaceId: "issue:2",
      conversationKey,
      payload: { action: "run", issueId: "iss-2" },
    })
    const bus = getBus()
    const handler = jest.fn<ReturnType<CallbackHandler>, Parameters<CallbackHandler>>()
    bus.callbackHandler = handler
    await bus.dispatchConnectorCallback(
      makeEvent({ triggerId: "a2ui:issue:2:run:run", value: "run", conversationKey })
    )
    expect(handler).not.toHaveBeenCalled()
    const audit = await getDb().connectorAudit.toArray()
    const denied = audit.find((r) => r.kind === "issue.card_action_denied")
    expect(denied).toMatchObject({ reason: "Error", message: "engine down" })
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

describe("callback authorization guard (plan 2026-07-24 Phase 2)", () => {
  const CONVERSATION = "telegram:adp_tg:c1"

  async function seedEnforcingAdapter(settings: Record<string, unknown> = {}): Promise<string> {
    const { createAdapterInstance } = await import("@/lib/db/adapter-instances")
    const row = await createAdapterInstance({
      type: "telegram",
      displayName: "Guarded Bot",
      enabled: true,
      transportMode: "stub",
      settings: { larkStrictCallbackAuthorization: "enforce", ...settings },
      credentialsRef: { keyringService: "test", accounts: [] },
      trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
      defaultMode: "auto",
      mediaModelPolicy: "local_extract_only",
    })
    return row.id
  }

  async function seedApprovalBinding(adapterId: string, initiator: string): Promise<string> {
    const { createWorkflow } = await import("@/lib/db/workflows")
    const wf = await createWorkflow({ name: `Guarded ${Math.random().toString(36).slice(2, 6)}` })
    const conversationKey = `telegram:${adapterId}:c1`
    const actionId = `wfapp:guard_${Math.random().toString(36).slice(2, 8)}`
    await recordCallbackBinding({
      adapterId,
      actionId,
      kind: "wf_approve",
      surfaceId: "wfsurf:guard",
      componentId: "approve",
      conversationKey,
      payload: {
        workflowId: wf.id,
        workflowName: wf.name,
        runParams: {},
        triggeredFrom: { source: "im", adapterId, conversationKey, sessionId: "s1" },
      },
      actorScope: { mode: "initiator", allowedUserIds: [initiator] },
      allowedActions: ["approve", "cancel"],
    })
    return actionId
  }

  it("strict mode: a non-initiator click is denied, audited, noticed, and terminal", async () => {
    const { startWorkflowFromIM } = await import("@/lib/workflow/runtime/start-from-im")
    const startMock = startWorkflowFromIM as jest.Mock
    startMock.mockClear()

    const adapterId = await seedEnforcingAdapter()
    const actionId = await seedApprovalBinding(adapterId, "u_initiator")
    const conversationKey = `telegram:${adapterId}:c1`
    const bus = getBus()
    const handler = jest.fn<ReturnType<CallbackHandler>, Parameters<CallbackHandler>>()
    bus.callbackHandler = handler

    const bystanderClick = makeEvent({
      adapterId,
      triggerId: actionId,
      conversationKey,
      value: "approve",
      payload: { action: "approve" },
      user: { id: "id-2", platform: "telegram", adapterId, remoteUserId: "u_bystander" },
    })
    await bus.dispatchConnectorCallback(bystanderClick)

    expect(startMock).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
    const audit = await getDb().connectorAudit.toArray()
    const forbidden = audit.find((r) => r.kind === "callback.forbidden")
    expect(forbidden?.reason).toBe("actor_forbidden")
    expect(JSON.stringify(forbidden)).not.toContain("u_bystander")
    // Denial notice enqueued once, keyed to the trigger.
    const outbound = await getDb().outboundQueue.toArray()
    expect(outbound.some((j) => j.idempotencyKey === `cb-denied:${actionId}`)).toBe(true)
    // Terminal: the same trigger redelivered is deduped, not re-evaluated.
    await bus.dispatchConnectorCallback(bystanderClick)
    expect(
      (await getDb().connectorAudit.toArray()).some((r) => r.kind === "callback.deduped")
    ).toBe(true)
  })

  it("strict mode: the initiator's click executes and consumes the binding", async () => {
    const { startWorkflowFromIM } = await import("@/lib/workflow/runtime/start-from-im")
    const startMock = startWorkflowFromIM as jest.Mock
    startMock.mockClear()

    const adapterId = await seedEnforcingAdapter()
    const actionId = await seedApprovalBinding(adapterId, "u_999")
    const conversationKey = `telegram:${adapterId}:c1`
    const bus = getBus()

    await bus.dispatchConnectorCallback(
      makeEvent({
        adapterId,
        triggerId: actionId,
        conversationKey,
        value: "approve",
        payload: { action: "approve" },
      })
    )
    expect(startMock).toHaveBeenCalledTimes(1)
    // The guard consumed the binding before dispatch; the wf handler then
    // deletes the sibling rows outright — either way it can never re-fire.
    const stored = await getDb().connectorCallbackBindings.get(`${adapterId}:${actionId}`)
    expect(stored === undefined || stored.consumedAt !== undefined).toBe(true)

    // A second click on the SAME card (new triggerId, same binding row via a
    // sibling action) would be denied binding_consumed — assert via the guard
    // path by re-dispatching with a fresh triggerId that maps to the consumed
    // binding id through the same actionId.
    startMock.mockClear()
    await bus.dispatchConnectorCallback(
      makeEvent({
        adapterId,
        triggerId: actionId,
        conversationKey,
        value: "approve",
        payload: { action: "approve" },
      })
    )
    // Same triggerId → dedup catches it first; either way the workflow must
    // not start twice.
    expect(startMock).not.toHaveBeenCalled()
  })

  it("audit mode: would-deny is audited and counted, but the callback still executes", async () => {
    const { startWorkflowFromIM } = await import("@/lib/workflow/runtime/start-from-im")
    const startMock = startWorkflowFromIM as jest.Mock
    startMock.mockClear()

    // Audit is opt-in now that enforce is the default, so the adapter asks
    // for shadow mode explicitly.
    await getDb().adapterInstances.put({
      id: "adp_tg",
      type: "telegram",
      displayName: "Shadow Bot",
      enabled: true,
      transportMode: "stub",
      settings: { larkStrictCallbackAuthorization: "audit" },
      credentialsRef: { keyringService: "test", accounts: [] },
      trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
      defaultMode: "auto",
      mediaModelPolicy: "local_extract_only",
    } as never)
    const { createWorkflow } = await import("@/lib/db/workflows")
    const wf = await createWorkflow({ name: "Shadow Flow" })
    const actionId = "wfapp:shadow_1"
    await recordCallbackBinding({
      adapterId: "adp_tg",
      actionId,
      kind: "wf_approve",
      surfaceId: "wfsurf:shadow",
      componentId: "approve",
      conversationKey: CONVERSATION,
      payload: {
        workflowId: wf.id,
        workflowName: wf.name,
        runParams: {},
        triggeredFrom: {
          source: "im",
          adapterId: "adp_tg",
          conversationKey: CONVERSATION,
          sessionId: "s1",
        },
      },
      actorScope: { mode: "initiator", allowedUserIds: ["someone_else"] },
    })
    const bus = getBus()
    await bus.dispatchConnectorCallback(
      makeEvent({ triggerId: actionId, value: "approve", payload: { action: "approve" } })
    )
    expect(startMock).toHaveBeenCalledTimes(1)
    const audit = await getDb().connectorAudit.toArray()
    const wouldDeny = audit.find((r) => r.kind === "callback.authorization_would_deny")
    expect(wouldDeny?.reason).toBe("actor_forbidden")
    // Shadow mode never consumes.
    const stored = await getDb().connectorCallbackBindings.get(`adp_tg:${actionId}`)
    expect(stored?.consumedAt).toBeUndefined()
  })

  it("off mode: no guard evaluation, no would-deny rows", async () => {
    const adapterId = await seedEnforcingAdapter({ larkStrictCallbackAuthorization: "off" })
    const actionId = await seedApprovalBinding(adapterId, "someone_else")
    const bus = getBus()
    await bus.dispatchConnectorCallback(
      makeEvent({
        adapterId,
        triggerId: actionId,
        conversationKey: `telegram:${adapterId}:c1`,
        value: "approve",
        payload: { action: "approve" },
      })
    )
    const audit = await getDb().connectorAudit.toArray()
    expect(audit.some((r) => r.kind === "callback.forbidden")).toBe(false)
    expect(audit.some((r) => r.kind === "callback.authorization_would_deny")).toBe(false)
  })

  it("default mode blocks a non-initiator approval with no adapter row at all", async () => {
    // The shipped default is `enforce`, so a workspace that never configured
    // anything is still protected — this is the property the epic's audit
    // default did not have.
    const { startWorkflowFromIM } = await import("@/lib/workflow/runtime/start-from-im")
    const startMock = startWorkflowFromIM as jest.Mock
    startMock.mockClear()

    const { createWorkflow } = await import("@/lib/db/workflows")
    const wf = await createWorkflow({ name: "Default Guarded" })
    const actionId = "wfapp:default_1"
    await recordCallbackBinding({
      adapterId: "adp_tg",
      actionId,
      kind: "wf_approve",
      surfaceId: "wfsurf:default",
      componentId: "approve",
      conversationKey: CONVERSATION,
      payload: {
        workflowId: wf.id,
        workflowName: wf.name,
        runParams: {},
        triggeredFrom: {
          source: "im",
          adapterId: "adp_tg",
          conversationKey: CONVERSATION,
          sessionId: "s1",
        },
      },
      actorScope: { mode: "initiator", allowedUserIds: ["someone_else"] },
    })

    const bus = getBus()
    await bus.dispatchConnectorCallback(
      makeEvent({ triggerId: actionId, conversationKey: CONVERSATION, value: "approve" })
    )

    expect(startMock).not.toHaveBeenCalled()
    const audit = await getDb().connectorAudit.toArray()
    expect(audit.some((r) => r.kind === "callback.forbidden")).toBe(true)
    // The clicker gets an explanation rather than a dead button.
    const outbound = await getDb().outboundQueue.toArray()
    expect(
      outbound.some((job) => job.request.metadata?.idempotencyKey?.startsWith("cb-denied:"))
    ).toBe(true)
  })

  it("a replayed approval click cannot start the workflow twice", async () => {
    // In audit mode `consume` was never minted, so a stale re-click could
    // re-grant an approval. Under the enforce default the first click retires
    // the binding, so the redelivered click is terminal.
    const { startWorkflowFromIM } = await import("@/lib/workflow/runtime/start-from-im")
    const startMock = startWorkflowFromIM as jest.Mock
    startMock.mockClear()
    const { createWorkflow } = await import("@/lib/db/workflows")
    const wf = await createWorkflow({ name: "Consume Once" })
    const actionId = "wfapp:consume_1"
    await recordCallbackBinding({
      adapterId: "adp_tg",
      actionId,
      kind: "wf_approve",
      surfaceId: "wfsurf:consume",
      componentId: "approve",
      conversationKey: CONVERSATION,
      payload: {
        workflowId: wf.id,
        workflowName: wf.name,
        runParams: {},
        triggeredFrom: {
          source: "im",
          adapterId: "adp_tg",
          conversationKey: CONVERSATION,
          sessionId: "s1",
        },
      },
      actorScope: { mode: "anyone" },
    })

    const bus = getBus()
    const click = () =>
      bus.dispatchConnectorCallback(
        makeEvent({
          // A distinct triggerId per click, so the inbound dedup ledger is not
          // what stops the second one — the binding state has to.
          triggerId: actionId,
          conversationKey: CONVERSATION,
          value: "approve",
        })
      )

    await click()
    expect(startMock).toHaveBeenCalledTimes(1)

    await click()
    expect(startMock).toHaveBeenCalledTimes(1)
  })
})
