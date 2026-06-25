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

import { dispatchTrigger } from "@/lib/workflow/runtime/trigger-bridge"
import { enqueueIngestJob } from "@/lib/twin/ingest"
import { getGoalRuntime } from "@/lib/goal/runtime"

beforeEach(async () => {
  jest.clearAllMocks()
  const db = getDb()
  await db.messages.clear().catch(() => undefined)
  await db.connectorDrafts.clear().catch(() => undefined)
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
  it("transitions a pending draft to approved", async () => {
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
  it("invokes the trigger bridge with kind=trigger.manual", async () => {
    await dispatchCommand("workflow_trigger_manual", { workflowId: "wf1" })
    expect(dispatchTrigger).toHaveBeenCalledTimes(1)
    expect(dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: "wf1",
        kind: "trigger.manual",
        originAt: expect.any(Number),
      })
    )
  })

  it("forwards an optional input payload", async () => {
    await dispatchCommand("workflow_trigger_manual", {
      workflowId: "wf1",
      input: { reason: "mobile" },
    })
    expect(dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { reason: "mobile" },
      })
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

describe("dispatchCommand: unknown command", () => {
  it("throws an explicit error", async () => {
    await expect(dispatchCommand("not_a_real_command", {})).rejects.toThrow(
      /unknown desktop-write command: not_a_real_command/
    )
  })
})
