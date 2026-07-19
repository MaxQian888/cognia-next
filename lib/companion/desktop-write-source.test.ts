/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"

import { dispatchCommand } from "./desktop-write-source"
import { getDb } from "@/lib/db/schema"

// Stub workflow trigger bridge — the real one talks to the orchestrator
// which runs the actual workflow. We want to assert the handler invokes
// the bridge with the right shape, not execute a real workflow.
jest.mock("@/lib/workflow/runtime/trigger-bridge", () => ({
  dispatchTrigger: jest.fn().mockResolvedValue(undefined),
}))

// Stub twin ingest — the real one creates a TwinJob row via Dexie. We
// could use the real impl with fake-indexeddb, but stubbing keeps the
// test focused on the dispatch contract.
jest.mock("@/lib/twin/ingest", () => ({
  enqueueIngestJob: jest.fn(async (draft: { twinId: string }) => ({
    id: "twj_test_001",
    twinId: draft.twinId,
    kind: "ingest",
    sourceIds: [],
    status: "queued",
    phase: "queued",
    progress: 0,
    queuedAt: Date.now(),
    retryCount: 0,
  })),
}))

// Stub the goal runtime so goal_* dispatch arms exercise the wiring without
// spinning up real goal lifecycle (Dexie rows, abort controllers).
jest.mock("@/lib/goal/runtime", () => {
  const pauseGoal = jest.fn().mockResolvedValue({ id: "g1", status: "paused" })
  const resumeGoal = jest.fn().mockResolvedValue({ id: "g1", status: "active" })
  const stopGoal = jest.fn().mockResolvedValue({ id: "g1", status: "stopped" })
  return { getGoalRuntime: () => ({ pauseGoal, resumeGoal, stopGoal }) }
})

// Stub the plugin runtime store so plugin_set_enabled exercises the live
// enable/disable wiring without spinning up a real PluginManager.
const mockEnablePlugin = jest.fn().mockResolvedValue(undefined)
const mockDisablePlugin = jest.fn().mockResolvedValue(undefined)
jest.mock("@/stores/plugin-runtime/plugin-store", () => ({
  usePluginStore: {
    getState: () => ({ enablePlugin: mockEnablePlugin, disablePlugin: mockDisablePlugin }),
  },
}))

// Stub the external-agent Zustand store so the external_agent_* arms exercise
// the projection + clamping wiring without loading the real persist store.
const mockExternalAgents: Record<string, Record<string, unknown>> = {}
const mockUpdateAgent = jest.fn((id: string, updates: Record<string, unknown>) => {
  if (mockExternalAgents[id]) {
    mockExternalAgents[id] = { ...mockExternalAgents[id], ...updates }
  }
})
jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: {
    getState: () => ({
      getAllAgents: () => Object.values(mockExternalAgents),
      getAgent: (id: string) => mockExternalAgents[id],
      updateAgent: mockUpdateAgent,
    }),
  },
}))

// Stub the shared memory API helpers — the arms should validate + delegate
// with `sourceChannel: "rpc"`, not re-run PII/consolidation logic (covered by
// lib/memory/api tests).
const mockMemorySearch = jest.fn()
jest.mock("@/lib/memory/api/search-memory", () => ({
  searchMemoriesExternal: (...args: unknown[]) => mockMemorySearch(...(args as [])),
}))
const mockMemoryStore = jest.fn()
jest.mock("@/lib/memory/api/store-memory", () => ({
  storeExternalMemory: (...args: unknown[]) => mockMemoryStore(...(args as [])),
}))
const mockMemoryUpdate = jest.fn()
const mockMemoryForget = jest.fn()
jest.mock("@/lib/memory/api/mutate-memory", () => ({
  updateExternalMemory: (...args: unknown[]) => mockMemoryUpdate(...(args as [])),
  forgetExternalMemory: (...args: unknown[]) => mockMemoryForget(...(args as [])),
}))

import { dispatchTrigger } from "@/lib/workflow/runtime/trigger-bridge"
import { enqueueIngestJob } from "@/lib/twin/ingest"
import { getGoalRuntime } from "@/lib/goal/runtime"

beforeEach(async () => {
  jest.clearAllMocks()
  const db = getDb()
  await db.messages.clear().catch(() => undefined)
  await db.connectorDrafts.clear().catch(() => undefined)
  await db.outboundQueue.clear().catch(() => undefined)
  await db.plugins.clear().catch(() => undefined)
})

describe("dispatchCommand: connector_send", () => {
  it("inserts a user message into the named session", async () => {
    const result = (await dispatchCommand("connector_send", {
      sessionId: "s1",
      segments: [{ type: "text", text: "hello" }],
    })) as { messageId: string }
    expect(result.messageId).toMatch(/^m_/)
    const rows = await getDb().messages.where("sessionId").equals("s1").toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].role).toBe("user")
    expect(rows[0].parts).toEqual([{ type: "text", text: "hello" }])
  })

  it("joins multiple segments with newlines", async () => {
    await dispatchCommand("connector_send", {
      sessionId: "s2",
      segments: [
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
      ],
    })
    const [row] = await getDb().messages.where("sessionId").equals("s2").toArray()
    expect(row.parts).toEqual([{ type: "text", text: "line one\nline two" }])
  })

  it("rejects when sessionId is missing", async () => {
    await expect(
      dispatchCommand("connector_send", {
        segments: [{ type: "text", text: "hi" }],
      })
    ).rejects.toThrow(/sessionId is required/)
  })

  it("rejects when segments is not an array", async () => {
    await expect(
      dispatchCommand("connector_send", {
        sessionId: "s1",
        segments: "not-an-array",
      })
    ).rejects.toThrow(/segments must be an array/)
  })

  it("rejects when segments yield no text", async () => {
    await expect(
      dispatchCommand("connector_send", {
        sessionId: "s1",
        segments: [{ type: "image", text: "" }],
      })
    ).rejects.toThrow(/no text content/)
  })
})

describe("dispatchCommand: connector_approve_draft", () => {
  it("transitions a pending draft without a preview to approved", async () => {
    const db = getDb()
    await db.connectorDrafts.add({
      id: "d1",
      conversationKey: "c1",
      sessionId: "s1",
      segments: [{ type: "text", text: "hi" }],
      status: "pending",
      createdAt: Date.now(),
    } as never)

    const result = await dispatchCommand("connector_approve_draft", { draftId: "d1" })
    expect(result).toBe(null)
    const row = await db.connectorDrafts.get("d1")
    expect(row?.status).toBe("approved")
    expect(await db.outboundQueue.count()).toBe(0)
  })

  it("enqueues the draft preview before transitioning it to approved", async () => {
    const db = getDb()
    const outboundPreview = {
      conversationRef: { platform: "telegram" as const, adapterId: "adapter-1", chatId: 5 },
      segments: [{ type: "text" as const, text: "send this" }],
      metadata: { idempotencyKey: "idem-draft-1" },
    }
    await db.connectorDrafts.add({
      id: "d-preview",
      conversationKey: "telegram:adapter-1:5",
      sessionId: "s1",
      segments: outboundPreview.segments,
      outboundPreview,
      status: "pending",
      createdAt: Date.now(),
    } as never)

    await dispatchCommand("connector_approve_draft", { draftId: "d-preview" })

    const draft = await db.connectorDrafts.get("d-preview")
    expect(draft?.status).toBe("approved")
    const jobs = await db.outboundQueue.toArray()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      adapterId: "adapter-1",
      conversationKey: "telegram:adapter-1:5",
      request: outboundPreview,
      idempotencyKey: "idem-draft-1",
      source: "draft-approved",
      status: "pending",
    })
  })

  it("keeps the draft pending when the outbound enqueue fails", async () => {
    const db = getDb()
    await db.connectorDrafts.add({
      id: "d-enqueue-fails",
      conversationKey: "telegram:adapter-1:5",
      sessionId: "s1",
      segments: [{ type: "text", text: "send this" }],
      outboundPreview: {
        conversationRef: { platform: "telegram", adapterId: "adapter-1", chatId: 5 },
        segments: [{ type: "text", text: "send this" }],
        metadata: { idempotencyKey: "idem-draft-failure" },
      },
      status: "pending",
      createdAt: Date.now(),
    } as never)
    const add = jest.spyOn(db.outboundQueue, "add").mockRejectedValueOnce(new Error("disk full"))

    await expect(
      dispatchCommand("connector_approve_draft", { draftId: "d-enqueue-fails" })
    ).rejects.toThrow("disk full")

    expect((await db.connectorDrafts.get("d-enqueue-fails"))?.status).toBe("pending")
    expect(await db.outboundQueue.count()).toBe(0)
    add.mockRestore()
  })

  it("rejects without a draftId", async () => {
    await expect(dispatchCommand("connector_approve_draft", {})).rejects.toThrow(
      /draftId is required/
    )
  })
})

describe("dispatchCommand: connector_reject_draft", () => {
  it("transitions a pending draft to rejected", async () => {
    const db = getDb()
    await db.connectorDrafts.add({
      id: "d2",
      conversationKey: "c1",
      sessionId: "s1",
      segments: [{ type: "text", text: "hi" }],
      status: "pending",
      createdAt: Date.now(),
    } as never)

    await dispatchCommand("connector_reject_draft", { draftId: "d2" })
    const row = await db.connectorDrafts.get("d2")
    expect(row?.status).toBe("rejected")
  })

  it("rejects without a draftId", async () => {
    await expect(dispatchCommand("connector_reject_draft", {})).rejects.toThrow(
      /draftId is required/
    )
  })
})

describe("dispatchCommand: workflow_trigger_manual", () => {
  it("invokes the trigger bridge with kind=trigger.manual and an api origin", async () => {
    await dispatchCommand("workflow_trigger_manual", { workflowId: "wf1" })
    expect(dispatchTrigger).toHaveBeenCalledTimes(1)
    expect(dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: "wf1",
        kind: "trigger.manual",
        originAt: expect.any(Number),
      }),
      { triggeredBy: { source: "api" } }
    )
  })

  it("threads the Rust-injected callerDeviceId into triggeredBy (ADR-0060)", async () => {
    await dispatchCommand("workflow_trigger_manual", {
      workflowId: "wf1",
      callerDeviceId: "dev-42",
    })
    expect(dispatchTrigger).toHaveBeenCalledWith(expect.anything(), {
      triggeredBy: { source: "api", deviceId: "dev-42" },
    })
  })

  it("forwards an optional input payload", async () => {
    await dispatchCommand("workflow_trigger_manual", {
      workflowId: "wf1",
      input: { reason: "mobile" },
    })
    expect(dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { reason: "mobile" },
      }),
      expect.anything()
    )
  })

  it("rejects without a workflowId", async () => {
    await expect(dispatchCommand("workflow_trigger_manual", {})).rejects.toThrow(
      /workflowId is required/
    )
  })

  it("surfaces the bridge's error", async () => {
    ;(dispatchTrigger as jest.Mock).mockRejectedValueOnce(new Error("orchestrator boom"))
    await expect(dispatchCommand("workflow_trigger_manual", { workflowId: "wf1" })).rejects.toThrow(
      /orchestrator boom/
    )
  })
})

describe("dispatchCommand: workflow approvals", () => {
  afterEach(async () => {
    const { __resetApprovalRegistryForTesting } =
      await import("@/lib/workflow/runtime/approval-registry")
    __resetApprovalRegistryForTesting()
  })

  it("lists pending approvals oldest first", async () => {
    const { registerPendingApproval } = await import("@/lib/workflow/runtime/approval-registry")
    registerPendingApproval({
      approvalId: "apr_1",
      runId: "run_1",
      workflowId: "wf_1",
      stepId: "n_gate",
      title: "Ship?",
      requestedAt: 5,
    })
    const result = (await dispatchCommand("workflow_approval_list", {})) as {
      approvals: Array<{ approvalId: string }>
    }
    expect(result.approvals.map((a) => a.approvalId)).toEqual(["apr_1"])
  })

  it("resolves a pending approval with the caller device identity", async () => {
    const { registerPendingApproval, approvalWakeKey } =
      await import("@/lib/workflow/runtime/approval-registry")
    const { subscribeWake } = await import("@/lib/workflow/runtime/wake-bus")
    registerPendingApproval({
      approvalId: "apr_2",
      runId: "run_2",
      workflowId: "wf_2",
      stepId: "n_gate",
      title: "Ship?",
      requestedAt: 5,
    })
    const wait = subscribeWake(approvalWakeKey("run_2", "n_gate"))
    const result = await dispatchCommand("workflow_approval_respond", {
      approvalId: "apr_2",
      decision: "approved",
      callerDeviceId: "dev-9",
    })
    expect(result).toEqual({ ok: true })
    await expect(wait).resolves.toMatchObject({
      data: { decision: "approved", respondedBy: "device:dev-9" },
    })
  })

  it("reports not-found for unknown approvals", async () => {
    const result = await dispatchCommand("workflow_approval_respond", {
      approvalId: "apr_gone",
      decision: "rejected",
    })
    expect(result).toEqual({ ok: false, reason: "not-found" })
  })

  it("rejects malformed decisions", async () => {
    await expect(
      dispatchCommand("workflow_approval_respond", { approvalId: "apr_x", decision: "maybe" })
    ).rejects.toThrow(/decision must be/)
  })
})

describe("dispatchCommand: workflow_step_result", () => {
  afterEach(async () => {
    const { __resetRemoteStepBrokerForTesting } =
      await import("@/lib/workflow/runtime/remote-step-broker")
    __resetRemoteStepBrokerForTesting()
  })

  it("feeds chunks into the broker and resolves the pending dispatch", async () => {
    const { dispatchRemoteStep, chunkRemoteStepResult } =
      await import("@/lib/workflow/runtime/remote-step-broker")
    let requestId = ""
    const emit = jest.fn(async (_event: string, payload: unknown) => {
      const p = payload as { requestId?: string }
      if (p.requestId) requestId = p.requestId
    })
    const promise = dispatchRemoteStep(
      {
        targetDeviceId: "dev-5",
        kind: "action.mobile.location",
        params: {},
        runId: "run_s",
        stepId: "n_s",
        workflowId: "wf_s",
        timeoutMs: 5_000,
      },
      { emit, isTauriFn: () => true }
    )
    await new Promise((r) => setTimeout(r, 0))
    const [chunk] = chunkRemoteStepResult(requestId, { ok: true, output: { latitude: 1 } })
    const outcome = await dispatchCommand("workflow_step_result", {
      ...chunk,
      callerDeviceId: "dev-5",
    })
    expect(outcome).toEqual({ ok: true, complete: true })
    await expect(promise).resolves.toEqual({ latitude: 1 })
  })

  it("rejects chunks from a non-target device and requires identity", async () => {
    const outcome = await dispatchCommand("workflow_step_result", {
      requestId: "rst_ghost",
      seq: 0,
      total: 1,
      chunk: "{}",
      callerDeviceId: "dev-x",
    })
    expect(outcome).toEqual({ ok: false, reason: "not-found" })
    await expect(
      dispatchCommand("workflow_step_result", { requestId: "rst_x", seq: 0, total: 1, chunk: "{}" })
    ).rejects.toThrow(/callerDeviceId is required/)
  })
})

describe("dispatchCommand: device_capabilities_report", () => {
  const seedDevice = async (deviceId: string) => {
    await getDb().pairedDevices.put({
      deviceId,
      label: "Test phone",
      platform: "ios",
      pubkey: "pk",
      appVersion: "1.0.0",
      pairedAt: 1,
      lastSeenAt: 1,
    })
  }

  beforeEach(async () => {
    await getDb()
      .pairedDevices.clear()
      .catch(() => undefined)
  })

  it("persists a validated capability manifest onto the caller's row", async () => {
    await seedDevice("dev-cap")
    const result = await dispatchCommand("device_capabilities_report", {
      callerDeviceId: "dev-cap",
      capabilities: ["camera", "geolocation", "not-a-real-cap", 42],
    })
    expect(result).toBeNull()
    const row = await getDb().pairedDevices.get("dev-cap")
    expect(row?.capabilities).toEqual(["camera", "geolocation"])
    expect(row?.capabilitiesReportedAt).toEqual(expect.any(Number))
  })

  it("accepts plugin-scoped capability ids", async () => {
    await seedDevice("dev-plug")
    await dispatchCommand("device_capabilities_report", {
      callerDeviceId: "dev-plug",
      capabilities: ["plugin:demo"],
    })
    const row = await getDb().pairedDevices.get("dev-plug")
    expect(row?.capabilities).toEqual(["plugin:demo"])
  })

  it("rejects without the Rust-injected callerDeviceId", async () => {
    await expect(
      dispatchCommand("device_capabilities_report", { capabilities: ["camera"] })
    ).rejects.toThrow(/callerDeviceId is required/)
  })

  it("rejects a non-array capabilities payload", async () => {
    await expect(
      dispatchCommand("device_capabilities_report", {
        callerDeviceId: "dev-cap",
        capabilities: "camera",
      })
    ).rejects.toThrow(/must be an array/)
  })
})

describe("dispatchCommand: twin_ingest_source", () => {
  it("enqueues an ingest job for the named twin", async () => {
    const result = (await dispatchCommand("twin_ingest_source", {
      twinId: "default",
      kind: "document",
      format: "markdown",
      text: "hello world",
    })) as { jobId: string }
    expect(result.jobId).toBe("twj_test_001")
    expect(enqueueIngestJob).toHaveBeenCalledTimes(1)
    expect(enqueueIngestJob).toHaveBeenCalledWith(
      expect.objectContaining({ twinId: "default", sourceIds: [] })
    )
  })

  it("rejects without a twinId", async () => {
    await expect(dispatchCommand("twin_ingest_source", {})).rejects.toThrow(/twinId is required/)
  })

  it("scopes the ingest to the supplied sourceIds", async () => {
    await dispatchCommand("twin_ingest_source", {
      twinId: "default",
      sourceIds: ["src_a", "src_b"],
    })
    expect(enqueueIngestJob).toHaveBeenCalledWith(
      expect.objectContaining({ twinId: "default", sourceIds: ["src_a", "src_b"] })
    )
  })

  it("treats an omitted sourceIds as ingest-all (empty array)", async () => {
    await dispatchCommand("twin_ingest_source", { twinId: "default" })
    expect(enqueueIngestJob).toHaveBeenCalledWith(
      expect.objectContaining({ twinId: "default", sourceIds: [] })
    )
  })

  it("rejects a malformed sourceIds", async () => {
    await expect(
      dispatchCommand("twin_ingest_source", { twinId: "default", sourceIds: "src_a" })
    ).rejects.toThrow(/sourceIds must be an array/)
    await expect(
      dispatchCommand("twin_ingest_source", { twinId: "default", sourceIds: [1, 2] })
    ).rejects.toThrow(/sourceIds must be an array/)
  })
})

describe("dispatchCommand: plugin_set_enabled", () => {
  it("drives the live PluginManager enablePlugin when enabling", async () => {
    await dispatchCommand("plugin_set_enabled", { id: "p1", enabled: true })
    expect(mockEnablePlugin).toHaveBeenCalledWith("p1")
    expect(mockDisablePlugin).not.toHaveBeenCalled()
  })

  it("drives the live PluginManager disablePlugin when disabling", async () => {
    await dispatchCommand("plugin_set_enabled", { id: "p1", enabled: false })
    expect(mockDisablePlugin).toHaveBeenCalledWith("p1")
    expect(mockEnablePlugin).not.toHaveBeenCalled()
  })

  it("falls back to a flag write when no manager is initialized", async () => {
    mockEnablePlugin.mockRejectedValueOnce(
      new Error("Verified plugin lifecycle action requires an initialized PluginManager for enable")
    )
    await getDb().plugins.add({
      id: "p2",
      manifest: { id: "p2" },
      enabled: false,
      updatedAt: 1,
    } as never)
    await dispatchCommand("plugin_set_enabled", { id: "p2", enabled: true })
    const row = await getDb().plugins.get("p2")
    expect(row?.enabled).toBe(true)
  })

  it("re-throws a genuine enable failure (dependency error)", async () => {
    mockEnablePlugin.mockRejectedValueOnce(new Error("Required dependency dep-x is disabled"))
    await expect(
      dispatchCommand("plugin_set_enabled", { id: "p3", enabled: true })
    ).rejects.toThrow(/Required dependency/)
  })

  it("rejects without an id or non-boolean enabled", async () => {
    await expect(dispatchCommand("plugin_set_enabled", { enabled: true })).rejects.toThrow(
      /id is required/
    )
    await expect(dispatchCommand("plugin_set_enabled", { id: "p1" })).rejects.toThrow(
      /must be boolean/
    )
  })
})

describe("dispatchCommand: session_attach / session_detach", () => {
  it("attach marks the session watched, detach clears it", async () => {
    const { isSessionAttached, __resetRemoteAttachForTests } =
      await import("./remote-attach-registry")
    __resetRemoteAttachForTests()

    const attachResult = await dispatchCommand("session_attach", {
      sessionId: "s-att",
      deviceId: "dev-1",
    })
    expect(attachResult).toBe(null)
    expect(isSessionAttached("s-att")).toBe(true)

    const detachResult = await dispatchCommand("session_detach", {
      sessionId: "s-att",
      deviceId: "dev-1",
    })
    expect(detachResult).toBe(null)
    expect(isSessionAttached("s-att")).toBe(false)
    __resetRemoteAttachForTests()
  })

  it("attach rejects without sessionId or deviceId", async () => {
    await expect(dispatchCommand("session_attach", { deviceId: "d" })).rejects.toThrow(
      /sessionId is required/
    )
    await expect(dispatchCommand("session_attach", { sessionId: "s" })).rejects.toThrow(
      /deviceId is required/
    )
  })

  it("detach rejects without sessionId or deviceId", async () => {
    await expect(dispatchCommand("session_detach", { deviceId: "d" })).rejects.toThrow(
      /sessionId is required/
    )
    await expect(dispatchCommand("session_detach", { sessionId: "s" })).rejects.toThrow(
      /deviceId is required/
    )
  })
})

describe("dispatchCommand: goal_pause / goal_resume / goal_stop", () => {
  it("goal_pause routes to GoalRuntime.pauseGoal and returns the goal", async () => {
    const result = (await dispatchCommand("goal_pause", { goalId: "g1" })) as { goal: unknown }
    expect(getGoalRuntime().pauseGoal).toHaveBeenCalledWith("g1")
    expect(result.goal).toEqual({ id: "g1", status: "paused" })
  })

  it("goal_resume routes to GoalRuntime.resumeGoal", async () => {
    await dispatchCommand("goal_resume", { goalId: "g1" })
    expect(getGoalRuntime().resumeGoal).toHaveBeenCalledWith("g1")
  })

  it("goal_stop routes to GoalRuntime.stopGoal", async () => {
    await dispatchCommand("goal_stop", { goalId: "g1" })
    expect(getGoalRuntime().stopGoal).toHaveBeenCalledWith("g1")
  })

  it("rejects when goalId is missing", async () => {
    await expect(dispatchCommand("goal_pause", {})).rejects.toThrow(/goal_pause.goalId is required/)
    await expect(dispatchCommand("goal_stop", {})).rejects.toThrow(/goal_stop.goalId is required/)
  })
})

describe("dispatchCommand: external_agent_list / external_agent_update", () => {
  beforeEach(() => {
    for (const k of Object.keys(mockExternalAgents)) delete mockExternalAgents[k]
    mockExternalAgents.a1 = {
      id: "a1",
      name: "Claude Code",
      protocol: "acp",
      transport: "stdio",
      enabled: true,
      defaultPermissionMode: "default",
    }
    mockExternalAgents.a2 = {
      id: "a2",
      name: "Codex",
      protocol: "codex-app-server",
      transport: "stdio",
      enabled: false,
      defaultPermissionMode: "plan",
    }
  })

  it("external_agent_list projects a compact summary of every agent", async () => {
    const res = (await dispatchCommand("external_agent_list", {})) as {
      agents: Array<{ id: string; defaultPermissionMode: string }>
    }
    expect(res.agents).toHaveLength(2)
    expect(res.agents.map((a) => a.id).sort()).toEqual(["a1", "a2"])
    // Falls back to "default" when unset.
    const noMode = { id: "a3", name: "x", protocol: "acp", transport: "stdio", enabled: true }
    mockExternalAgents.a3 = noMode
    const res2 = (await dispatchCommand("external_agent_list", {})) as {
      agents: Array<{ id: string; defaultPermissionMode: string }>
    }
    expect(res2.agents.find((a) => a.id === "a3")?.defaultPermissionMode).toBe("default")
  })

  it("external_agent_update toggles enabled", async () => {
    await dispatchCommand("external_agent_update", { id: "a1", patch: { enabled: false } })
    expect(mockUpdateAgent).toHaveBeenCalledWith("a1", { enabled: false })
    expect(mockExternalAgents.a1.enabled).toBe(false)
  })

  it("external_agent_update clamps an unsupported permission mode per protocol", async () => {
    // Codex (codex-app-server) cannot enforce `dontAsk` → clamps to a supported
    // mode (never `dontAsk`).
    await dispatchCommand("external_agent_update", {
      id: "a2",
      patch: { defaultPermissionMode: "dontAsk" },
    })
    const applied = mockUpdateAgent.mock.calls.at(-1)?.[1] as { defaultPermissionMode: string }
    expect(applied.defaultPermissionMode).not.toBe("dontAsk")
  })

  it("external_agent_update passes a supported mode through unchanged", async () => {
    await dispatchCommand("external_agent_update", {
      id: "a1",
      patch: { defaultPermissionMode: "acceptEdits" },
    })
    expect(mockUpdateAgent).toHaveBeenCalledWith("a1", { defaultPermissionMode: "acceptEdits" })
  })

  it("rejects a missing id, missing patch, invalid mode, or empty patch", async () => {
    await expect(dispatchCommand("external_agent_update", {})).rejects.toThrow(/id is required/)
    await expect(dispatchCommand("external_agent_update", { id: "a1" })).rejects.toThrow(
      /patch is required/
    )
    await expect(
      dispatchCommand("external_agent_update", { id: "missing", patch: { enabled: true } })
    ).rejects.toThrow(/agent not found/)
    await expect(
      dispatchCommand("external_agent_update", { id: "a1", patch: { enabled: "yes" } })
    ).rejects.toThrow(/enabled must be boolean/)
    await expect(
      dispatchCommand("external_agent_update", {
        id: "a1",
        patch: { defaultPermissionMode: "nope" },
      })
    ).rejects.toThrow(/defaultPermissionMode is invalid/)
    await expect(dispatchCommand("external_agent_update", { id: "a1", patch: {} })).rejects.toThrow(
      /no editable fields/
    )
  })
})

describe("dispatchCommand: memory_* (ADR-0069)", () => {
  const MEMORY_ROW = {
    id: "m1",
    scope: "global",
    type: "semantic",
    text: "User prefers pnpm",
    tags: [],
    importance: 7,
    vectorDocId: "m1",
    createdAt: 1,
    updatedAt: 2,
    lastAccessedAt: 2,
    accessCount: 1,
    version: 1,
    status: "active",
    pinned: false,
    provenance: "external",
  }

  it("memory_search validates the query and projects wire rows", async () => {
    await expect(dispatchCommand("memory_search", {})).rejects.toThrow(/query is required/)
    mockMemorySearch.mockResolvedValue({
      ok: true,
      hits: [{ memory: MEMORY_ROW, relevance: 0.9, score: 0.8 }],
    })
    const result = (await dispatchCommand("memory_search", { query: "pnpm", k: 3 })) as {
      ok: boolean
      hits: Array<{ memory: Record<string, unknown> }>
    }
    expect(mockMemorySearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: "pnpm", topK: 3 })
    )
    expect(result.ok).toBe(true)
    expect(result.hits[0].memory.id).toBe("m1")
    expect(result.hits[0].memory.vectorDocId).toBeUndefined()
  })

  it("memory_search passes policy blocks through unchanged", async () => {
    mockMemorySearch.mockResolvedValue({ ok: false, reason: "disabled" })
    expect(await dispatchCommand("memory_search", { query: "q" })).toEqual({
      ok: false,
      reason: "disabled",
    })
  })

  it("memory_store validates text and stamps the rpc channel", async () => {
    await expect(dispatchCommand("memory_store", { text: "  " })).rejects.toThrow(
      /text is required/
    )
    mockMemoryStore.mockResolvedValue({ ok: true, stored: true, consolidated: false })
    await dispatchCommand("memory_store", { text: "User prefers pnpm", importance: 9 })
    expect(mockMemoryStore).toHaveBeenCalledWith(
      expect.objectContaining({ text: "User prefers pnpm", importance: 9 }),
      { channel: "rpc" }
    )
  })

  it("memory_update / memory_forget validate ids and delegate", async () => {
    await expect(dispatchCommand("memory_update", {})).rejects.toThrow(/id is required/)
    await expect(dispatchCommand("memory_forget", { id: " " })).rejects.toThrow(/id is required/)
    mockMemoryUpdate.mockResolvedValue({ ok: true })
    mockMemoryForget.mockResolvedValue({ ok: true })
    await dispatchCommand("memory_update", { id: "m1", text: "new", pinned: true })
    expect(mockMemoryUpdate).toHaveBeenCalledWith(
      "m1",
      expect.objectContaining({ text: "new", pinned: true })
    )
    expect(await dispatchCommand("memory_forget", { id: "m1" })).toEqual({ ok: true })
    expect(mockMemoryForget).toHaveBeenCalledWith("m1")
  })

  it("memory_list is policy-gated and clamps the limit", async () => {
    // Default settings row (fake-indexeddb) has memory enabled by default.
    const result = (await dispatchCommand("memory_list", { limit: 999 })) as { ok: boolean }
    expect(result.ok).toBe(true)
  })
})

describe("dispatchCommand: unknown command", () => {
  it("throws an explicit error", async () => {
    await expect(dispatchCommand("not_a_real_command", {})).rejects.toThrow(
      /unknown desktop-write command: not_a_real_command/
    )
  })
})
