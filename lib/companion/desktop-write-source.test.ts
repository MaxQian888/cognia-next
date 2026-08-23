/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"

import { getDb } from "@/lib/db/schema"
import { isConnectorRuntimeOwnedHere } from "@/lib/connectors/bootstrap/install-connector-runtime"

const mockActiveRuntimeTarget = jest.fn()
// ADR-0131 §2.7 — relayed Inbox writes only run on the process that owns the
// connector runtime. These tests exercise the host arms, so model an owner;
// the refusal path gets its own test below.
jest.mock("@/lib/connectors/bootstrap/install-connector-runtime", () => ({
  isConnectorRuntimeOwnedHere: jest.fn(() => true),
}))

const ownsRuntimeMock = isConnectorRuntimeOwnedHere as jest.Mock

jest.mock("@/lib/runtime/runtime-target-context", () => ({
  getActiveRuntimeTargetContext: () => mockActiveRuntimeTarget(),
}))

const mockHostStateService = {
  start: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn().mockResolvedValue(undefined),
  snapshot: jest.fn().mockResolvedValue({ protocolVersion: 1, revision: 0 }),
  submit: jest.fn().mockResolvedValue({ protocolVersion: 1, receipts: [] }),
  status: jest.fn().mockReturnValue({ protocolVersion: 1, hostSeq: 0 }),
  projectRuntimeEnvelope: jest.fn().mockResolvedValue(undefined),
}
const mockCreateHostStateService = jest.fn(() => mockHostStateService)
jest.mock("@/lib/sync/host-state-service", () => ({
  createAgentRpcHostStateDispatcher: () => jest.fn(),
  createHostStateService: (...args: unknown[]) => mockCreateHostStateService(...args),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: () => false,
  invoke: jest.fn(),
  transport: { subscribe: jest.fn(() => jest.fn()) },
}))

import { dispatchCommand } from "./desktop-write-source"
import { isRetryable } from "@/lib/queue/retry-policy"

const mockExportForPairing = jest.fn()
jest.mock("@/lib/rag/profile-dek-store", () => ({
  createProfileDekStore: () => ({ exportForPairing: mockExportForPairing }),
}))

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
  registerTwinSource: jest.fn(async (draft: { twinId: string }) => ({
    source: { id: "src_test_001", twinId: draft.twinId },
    created: true,
    revived: false,
  })),
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
  const createGoal = jest.fn().mockResolvedValue({ id: "g-new", status: "active" })
  const updateObjective = jest
    .fn()
    .mockResolvedValue({ goal: { id: "g1", status: "active" }, updatePrompt: "re-aimed" })
  const updateConfig = jest.fn().mockResolvedValue({ id: "g1", status: "active" })
  return {
    getGoalRuntime: () => ({
      pauseGoal,
      resumeGoal,
      stopGoal,
      createGoal,
      updateObjective,
      updateConfig,
    }),
  }
})

const mockGetGoal = jest.fn().mockResolvedValue({ id: "g1", status: "active" })
const mockGetActiveGoalForSession = jest.fn().mockResolvedValue({ id: "g1" })
const mockListGoalsBySession = jest.fn().mockResolvedValue([{ id: "g1" }, { id: "g0" }])
jest.mock("@/lib/db/goals", () => ({
  getGoal: (...args: unknown[]) => mockGetGoal(...(args as [])),
  getActiveGoalForSession: (...args: unknown[]) => mockGetActiveGoalForSession(...(args as [])),
  listGoalsBySession: (...args: unknown[]) => mockListGoalsBySession(...(args as [])),
}))

const mockAgentTaskStart = jest.fn().mockResolvedValue({ ok: true, executionId: "execution-1" })
const mockAgentTaskPause = jest.fn().mockResolvedValue({ ok: true })
const mockAgentTaskResume = jest.fn().mockResolvedValue({ ok: true })
const mockAgentTaskCancel = jest.fn().mockResolvedValue({ ok: true })
const mockAgentTaskComment = jest.fn().mockResolvedValue({ ok: true, commentId: "comment-1" })
const mockAgentTaskMove = jest.fn().mockResolvedValue({ ok: true })
jest.mock("@/lib/companion/agent-task-write-handlers", () => ({
  handleAgentTaskStart: (...args: unknown[]) => mockAgentTaskStart(...args),
  handleAgentTaskPause: (...args: unknown[]) => mockAgentTaskPause(...args),
  handleAgentTaskResume: (...args: unknown[]) => mockAgentTaskResume(...args),
  handleAgentTaskCancel: (...args: unknown[]) => mockAgentTaskCancel(...args),
  handleAgentTaskComment: (...args: unknown[]) => mockAgentTaskComment(...args),
  handleAgentTaskMove: (...args: unknown[]) => mockAgentTaskMove(...args),
}))

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

// The write arm goes through the lifecycle service, not the store: a store
// write persisted the new value and left the runtime untouched, so disabling
// an agent from the phone flipped the toggle while the process kept running.
const mockUpdateConfig = jest.fn(async (id: string, updates: Record<string, unknown>) => {
  if (mockExternalAgents[id]) {
    mockExternalAgents[id] = { ...mockExternalAgents[id], ...updates }
  }
})
jest.mock("@/lib/ai/agent/external/lifecycle/service", () => ({
  getExternalAgentLifecycleService: async () => ({ updateConfig: mockUpdateConfig }),
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
  await db.characters.clear().catch(() => undefined)
  await db.skills.clear().catch(() => undefined)
  await db.adapterInstances.clear().catch(() => undefined)
  await db.twinProfile.clear().catch(() => undefined)
  mockActiveRuntimeTarget.mockReturnValue({ accountId: "local-default", targetId: "target-a" })
})

describe("dispatchCommand: HostState authority", () => {
  it("validates the caller scope and reuses the authoritative service", async () => {
    const payload = {
      protocolVersion: 1,
      accountId: "local-default",
      callerAccountId: "local-default",
      runtimeTargetId: "target-a",
      authoritativeHostId: "host-a",
    }

    await expect(dispatchCommand("host_state_status", payload)).resolves.toEqual({
      protocolVersion: 1,
      hostSeq: 0,
    })
    await expect(dispatchCommand("host_state_snapshot", payload)).resolves.toEqual({
      protocolVersion: 1,
      revision: 0,
    })
    expect(mockCreateHostStateService).toHaveBeenCalledTimes(1)
    expect(mockHostStateService.start).toHaveBeenCalledTimes(1)
    expect(mockHostStateService.snapshot).toHaveBeenCalledWith({
      protocolVersion: 1,
      accountId: "local-default",
      runtimeTargetId: "target-a",
    })
  })

  it("routes host_state_submit to the authoritative service without the routing fields", async () => {
    const payload = {
      protocolVersion: 1,
      accountId: "local-default",
      callerAccountId: "local-default",
      runtimeTargetId: "target-a",
      authoritativeHostId: "host-a",
      callerDeviceId: "device-a",
      callerDeviceGrants: ["workspace.write"],
      mutations: [{ kind: "noop" }],
    }

    await expect(dispatchCommand("host_state_submit", payload)).resolves.toEqual({
      protocolVersion: 1,
      receipts: [],
    })
    // `authoritativeHostId` / `callerAccountId` / `callerDevice*` are
    // transport-level authority fields injected by Rust — the service takes the
    // caller as a separate argument and must never see them as request body.
    expect(mockHostStateService.submit).toHaveBeenCalledWith(
      {
        protocolVersion: 1,
        accountId: "local-default",
        runtimeTargetId: "target-a",
        mutations: [{ kind: "noop" }],
      },
      { deviceId: "device-a", grants: ["workspace.write"] }
    )
  })

  /**
   * A payload that reached this arm without Rust's `bind_authority` has no
   * verified caller. Both malformed fields are passed through UNCHANGED so the
   * service throws `host_state_caller_unbound`; normalising the grant list to
   * `[]` here made the service's array check unreachable, and the batch came
   * back as ordinary per-action `host_state_forbidden` receipts that read like
   * a permission problem instead of the routing bug they are.
   */
  it("passes an unbound caller through so the service fails the batch loudly", async () => {
    await dispatchCommand("host_state_submit", {
      protocolVersion: 1,
      accountId: "local-default",
      callerAccountId: "local-default",
      runtimeTargetId: "target-a",
      authoritativeHostId: "host-a",
      callerDeviceGrants: "not-an-array",
      mutations: [],
    })

    expect(mockHostStateService.submit).toHaveBeenCalledWith(expect.anything(), {
      deviceId: "",
      grants: "not-an-array",
    })
  })

  it("rejects a host_state_submit outside the active runtime target", async () => {
    await expect(
      dispatchCommand("host_state_submit", {
        callerAccountId: "other-account",
        runtimeTargetId: "target-a",
        authoritativeHostId: "host-a",
      })
    ).rejects.toThrow("host_state_scope_mismatch")
    expect(mockHostStateService.submit).not.toHaveBeenCalled()
  })

  it("rejects a HostState request outside the active runtime target", async () => {
    await expect(
      dispatchCommand("host_state_status", {
        callerAccountId: "other-account",
        runtimeTargetId: "target-a",
        authoritativeHostId: "host-a",
      })
    ).rejects.toThrow("host_state_scope_mismatch")
  })
})

describe("dispatchCommand: Agent task board", () => {
  it.each([
    ["agent_task_start", mockAgentTaskStart],
    ["agent_task_pause", mockAgentTaskPause],
    ["agent_task_resume", mockAgentTaskResume],
    ["agent_task_cancel", mockAgentTaskCancel],
    ["agent_task_comment", mockAgentTaskComment],
    ["agent_task_move", mockAgentTaskMove],
  ] as const)("dispatches %s to the single-Agent task handler", async (command, handler) => {
    const payload = { agentId: "agent-1", taskId: "task-1" }
    await dispatchCommand(command, payload)
    expect(handler).toHaveBeenCalledWith(payload)
  })
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

describe("dispatchCommand: Twin profile PII gate", () => {
  it("rejects unsafe remote profile text before persistence", async () => {
    await expect(
      dispatchCommand("twin_profile_update", {
        twinId: "twin-1",
        op: "setVoiceSummary",
        voiceSummary: "Contact alice@example.com",
      })
    ).rejects.toThrow("unredacted PII")

    expect(await getDb().twinProfile.get("twin-1")).toBeUndefined()
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

    // ADR-0131: the arm reports what it did, so the phone learns the job id
    // (and whether the approval was a replay) instead of a bare `null`.
    const result = await dispatchCommand("connector_approve_draft", { draftId: "d1" })
    expect(result).toEqual({ draftId: "d1", jobId: undefined, alreadyApproved: false })
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
    const add = jest
      .spyOn(db.outboundQueue, "bulkAdd")
      .mockRejectedValueOnce(new Error("disk full"))

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

// ─────────────────────────────────────────────────────────────────────────
// ADR-0131 §2.7 — runtime-ownership guard
// ─────────────────────────────────────────────────────────────────────────

describe("relayed inbox writes on a process that lost the connector runtime", () => {
  beforeEach(() => ownsRuntimeMock.mockReturnValue(false))
  afterEach(() => ownsRuntimeMock.mockReturnValue(true))

  it.each(["connector_enqueue_outbound", "connector_approve_draft", "connector_reject_draft"])(
    "refuses %s instead of enqueuing a job nothing will deliver",
    async (command) => {
      // During a desktop ⇄ brain handoff the bridge can route a phone's reply to
      // the side that just released the lease. Running it there would enqueue an
      // outbound job no runner picks up — or double-send once the real owner
      // also handles the retry.
      await expect(dispatchCommand(command, { draftId: "d1" })).rejects.toThrow(
        /connector_runtime_not_owner/
      )
    }
  )

  it("throws a message the durable queue treats as RETRYABLE", async () => {
    // The phone's queue must replay across the handoff window (5 attempts of
    // backoff ≈ 31 s), not dead-letter the reply. `isRetryable` keys off the
    // message, so the wording is load-bearing.
    const error = await dispatchCommand("connector_reject_draft", { draftId: "d1" }).catch(
      (e: unknown) => e
    )
    expect(isRetryable(error)).toBe(true)
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
    await __resetApprovalRegistryForTesting()
  })

  it("lists pending approvals oldest first", async () => {
    const { registerPendingApproval } = await import("@/lib/workflow/runtime/approval-registry")
    await registerPendingApproval({
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
    const { registerPendingApproval } = await import("@/lib/workflow/runtime/approval-registry")
    const { getWorkflowWaitpoint } = await import("@/lib/db/workflow-waitpoints")
    await registerPendingApproval({
      approvalId: "apr_2",
      runId: "run_2",
      workflowId: "wf_2",
      stepId: "n_gate",
      title: "Ship?",
      requestedAt: 5,
    })
    const result = await dispatchCommand("workflow_approval_respond", {
      approvalId: "apr_2",
      decision: "approved",
      callerDeviceId: "dev-9",
    })
    expect(result).toEqual({ ok: true })
    await expect(getWorkflowWaitpoint("apr_2")).resolves.toMatchObject({
      status: "resolved",
      resolution: { outcome: "approved", respondedBy: "device:dev-9" },
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
      allowRemoteTerminal: false,
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
      expect.objectContaining({ twinId: "default", sourceIds: ["src_test_001"] })
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
  /** A caught-up stream exactly as `inject_caller_event_streams` reports one. */
  const READY_STREAM = [{ leaseId: "esl_ws", transport: "ws", state: "ready", openedAt: 1 }]
  /** Grants a device holds once the desktop's remote-control toggle is on. */
  const CONTROL_GRANTS = ["host.observe", "agent.run", "workspace.read", "workspace.write"]
  /** What `insert_default_grants` hands every freshly paired member device. */
  const DEFAULT_GRANTS = ["host.observe", "agent.run", "workspace.read"]

  it("attach marks the session watched, detach clears it", async () => {
    const { isSessionAttached, __resetRemoteAttachForTests } =
      await import("./remote-attach-registry")
    __resetRemoteAttachForTests()

    const attachResult = await dispatchCommand("session_attach", {
      sessionId: "s-att",
      callerDeviceId: "dev-1",
      callerEventStreams: READY_STREAM,
      callerDeviceGrants: CONTROL_GRANTS,
    })
    expect(attachResult).toMatchObject({
      mode: "control",
      downgradeReason: null,
      eventPlane: "ready",
      leaseTtlMs: 90_000,
      renewIntervalMs: 30_000,
    })
    expect(isSessionAttached("s-att")).toBe(true)

    const detachResult = await dispatchCommand("session_detach", {
      sessionId: "s-att",
      callerDeviceId: "dev-1",
    })
    expect(detachResult).toBe(null)
    expect(isSessionAttached("s-att")).toBe(false)
    __resetRemoteAttachForTests()
  })

  /**
   * The per-session capability answer. It comes from the same table
   * `host_state_submit` authorizes against, so a composer can never offer an
   * action that would 403 — and an observer is told up front rather than
   * discovering it one rejected submit at a time.
   */
  it("reports the intents this caller may actually submit here", async () => {
    const { __resetRemoteAttachForTests } = await import("./remote-attach-registry")
    __resetRemoteAttachForTests()

    const controller = (await dispatchCommand("session_attach", {
      sessionId: "s-actions",
      callerDeviceId: "dev-control",
      callerEventStreams: READY_STREAM,
      callerDeviceGrants: CONTROL_GRANTS,
    })) as { supportedActions: string[] }
    expect(controller.supportedActions).toEqual([
      "session.rename",
      "session.archive",
      "draft.replace",
      "message.enqueue",
      "turn.steer",
      "turn.followup",
      "turn.abort",
      "approval.respond",
      "elicitation.respond",
    ])
    // Remote Control is not Agent Control and is not owner: creating a session
    // and rewriting a transcript stay out.
    expect(controller.supportedActions).not.toContain("session.create")
    expect(controller.supportedActions).not.toContain("transcript.truncate")

    const observer = (await dispatchCommand("session_attach", {
      sessionId: "s-actions",
      callerDeviceId: "dev-observe",
      callerEventStreams: READY_STREAM,
      callerDeviceGrants: DEFAULT_GRANTS,
    })) as { mode: string; supportedActions: string[] }
    expect(observer).toMatchObject({ mode: "observe", downgradeReason: "missing-capability" })
    expect(observer.supportedActions).toEqual([])
    __resetRemoteAttachForTests()
  })

  /**
   * Attention decides only whether a native push is suppressed, so it is
   * client-reported. An absent or bogus value must read as `unknown` and
   * suppress nothing — the failure mode of the alternative is a decision
   * prompt that no device is ever shown.
   */
  it("treats an unreported or bogus attention as unknown, which suppresses no push", async () => {
    const { __resetRemoteAttachForTests, approvalPushTargets } =
      await import("./remote-attach-registry")
    __resetRemoteAttachForTests()

    await dispatchCommand("session_attach", {
      sessionId: "s-att2",
      callerDeviceId: "dev-1",
      callerEventStreams: READY_STREAM,
      callerDeviceGrants: CONTROL_GRANTS,
      attention: "definitely-not-a-state",
    })
    expect(approvalPushTargets("s-att2")).toEqual(["dev-1"])

    await dispatchCommand("session_attach", {
      sessionId: "s-att2",
      callerDeviceId: "dev-1",
      callerEventStreams: READY_STREAM,
      callerDeviceGrants: CONTROL_GRANTS,
      attention: "foreground",
    })
    expect(approvalPushTargets("s-att2")).toEqual([])
    __resetRemoteAttachForTests()
  })

  /**
   * `callerEventStreams` is injected by `inject_caller_event_streams`. A payload
   * without it reached this arm through a path that did not report the device's
   * streams, and claiming control on that basis would hand approvals to a
   * device that cannot receive them. Same for a malformed entry.
   */
  it("attaches as an observer when the RPC boundary reports no usable event stream", async () => {
    const { __resetRemoteAttachForTests, approvalPushTargets } =
      await import("./remote-attach-registry")
    __resetRemoteAttachForTests()

    await expect(
      dispatchCommand("session_attach", {
        sessionId: "s-obs",
        callerDeviceId: "dev-1",
        callerDeviceGrants: CONTROL_GRANTS,
      })
    ).resolves.toMatchObject({
      mode: "observe",
      downgradeReason: "event-plane-not-ready",
      eventPlane: "disconnected",
    })
    expect(approvalPushTargets("s-obs")).toEqual([])

    await expect(
      dispatchCommand("session_attach", {
        sessionId: "s-obs2",
        callerDeviceId: "dev-1",
        callerDeviceGrants: CONTROL_GRANTS,
        callerEventStreams: [{ leaseId: "x", transport: "carrier-pigeon", state: "ready" }],
      })
    ).resolves.toMatchObject({ mode: "observe", downgradeReason: "event-plane-not-ready" })
    __resetRemoteAttachForTests()
  })

  /**
   * Grants are server-injected too. A payload that arrived without them reached
   * this arm through a path that never consulted the SecurityStore, and reading
   * that as "control" would grant on the strength of a missing field.
   */
  it("attaches as an observer when the RPC boundary reports no grants", async () => {
    const { __resetRemoteAttachForTests, isSessionAttached } =
      await import("./remote-attach-registry")
    __resetRemoteAttachForTests()

    await expect(
      dispatchCommand("session_attach", {
        sessionId: "s-nogrants",
        callerDeviceId: "dev-1",
        callerEventStreams: READY_STREAM,
      })
    ).resolves.toMatchObject({ mode: "observe", downgradeReason: "missing-capability" })
    expect(isSessionAttached("s-nogrants")).toBe(false)
    __resetRemoteAttachForTests()
  })

  it("attach rejects without sessionId or a server-bound caller", async () => {
    await expect(dispatchCommand("session_attach", { callerDeviceId: "d" })).rejects.toThrow(
      /sessionId is required/
    )
    await expect(dispatchCommand("session_attach", { sessionId: "s" })).rejects.toThrow(
      /callerDeviceId is required/
    )
  })

  it("detach rejects without sessionId or a server-bound caller", async () => {
    await expect(dispatchCommand("session_detach", { callerDeviceId: "d" })).rejects.toThrow(
      /sessionId is required/
    )
    await expect(dispatchCommand("session_detach", { sessionId: "s" })).rejects.toThrow(
      /callerDeviceId is required/
    )
  })

  /**
   * The reason `callerDeviceId` exists. `rpc.rs::inject_caller_device_id`
   * overwrites it from the verified JWT, so a client-supplied `deviceId` is
   * whatever the caller felt like typing — and the attach registry decides who
   * the Host routes an approval prompt to.
   */
  it("ignores a client-asserted deviceId and attaches only the verified caller", async () => {
    const { attachedDeviceIds, __resetRemoteAttachForTests } =
      await import("./remote-attach-registry")
    __resetRemoteAttachForTests()

    await dispatchCommand("session_attach", {
      sessionId: "s-spoof",
      deviceId: "victim-device",
      callerDeviceId: "attacker-device",
      callerEventStreams: READY_STREAM,
      callerDeviceGrants: CONTROL_GRANTS,
    })
    expect(attachedDeviceIds("s-spoof")).toEqual(["attacker-device"])

    // ...and the spoofed id cannot detach the real watcher either.
    await dispatchCommand("session_detach", {
      sessionId: "s-spoof",
      deviceId: "attacker-device",
      callerDeviceId: "victim-device",
    })
    expect(attachedDeviceIds("s-spoof")).toEqual(["attacker-device"])
    __resetRemoteAttachForTests()
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

describe("dispatchCommand: goal_create / goal_update / goal_status", () => {
  it("goal_create delegates to the canonical runtime and marks the origin remote", async () => {
    const res = (await dispatchCommand("goal_create", {
      sessionId: "s1",
      rawObjective: "Ship the release",
      nameHints: ["Ada"],
      startPaused: true,
    })) as { goal: { id: string } }

    // `origin: "remote"` is the load-bearing bit: the operator is not at the
    // desktop's Continue button, so the manual-continue gate must treat this
    // as headless (ADR-0070 Phase 2).
    expect(getGoalRuntime().createGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s1",
        rawObjective: "Ship the release",
        nameHints: ["Ada"],
        startPaused: true,
        origin: "remote",
      })
    )
    expect(res.goal.id).toBe("g-new")
  })

  it("goal_create defaults nameHints to empty and startPaused to false", async () => {
    await dispatchCommand("goal_create", { sessionId: "s1", rawObjective: "Ship it" })
    expect(getGoalRuntime().createGoal).toHaveBeenCalledWith(
      expect.objectContaining({ nameHints: [], startPaused: false })
    )
  })

  it("goal_create rejects a missing session, a blank objective, or malformed hints", async () => {
    await expect(dispatchCommand("goal_create", { rawObjective: "x" })).rejects.toThrow(
      /goal_create.sessionId is required/
    )
    await expect(
      dispatchCommand("goal_create", { sessionId: "s1", rawObjective: "   " })
    ).rejects.toThrow(/goal_create.rawObjective is required/)
    await expect(
      dispatchCommand("goal_create", { sessionId: "s1", rawObjective: "x", nameHints: [1] })
    ).rejects.toThrow(/nameHints must be an array of strings/)
    expect(getGoalRuntime().createGoal).not.toHaveBeenCalled()
  })

  it("goal_update re-aims the objective and returns the model-facing prompt", async () => {
    const res = (await dispatchCommand("goal_update", {
      goalId: "g1",
      rawObjective: "New aim",
      nameHints: [],
    })) as { goal: unknown; updatePrompt?: string }

    expect(getGoalRuntime().updateObjective).toHaveBeenCalledWith("g1", "New aim", [])
    expect(res.updatePrompt).toBe("re-aimed")
  })

  it("goal_update patches config and can do both in one call", async () => {
    await dispatchCommand("goal_update", { goalId: "g1", config: { maxTurns: 5 } })
    expect(getGoalRuntime().updateConfig).toHaveBeenCalledWith("g1", { maxTurns: 5 })
    expect(getGoalRuntime().updateObjective).not.toHaveBeenCalled()

    await dispatchCommand("goal_update", {
      goalId: "g1",
      rawObjective: "New aim",
      config: { maxTurns: 5 },
    })
    expect(getGoalRuntime().updateObjective).toHaveBeenCalled()
    expect(getGoalRuntime().updateConfig).toHaveBeenCalledTimes(2)
  })

  it("goal_update falls back to the persisted goal when nothing changed", async () => {
    // `updateObjective` answers null for a missing/terminal goal or an
    // unchanged objective — the caller still gets the goal it referenced.
    ;(getGoalRuntime().updateObjective as jest.Mock).mockResolvedValueOnce(null)
    const res = (await dispatchCommand("goal_update", {
      goalId: "g1",
      rawObjective: "Same aim",
    })) as { goal: { id: string } | null }

    expect(mockGetGoal).toHaveBeenCalledWith("g1")
    expect(res.goal).toEqual({ id: "g1", status: "active" })
  })

  it("goal_update requires a goalId and at least one of objective/config", async () => {
    await expect(dispatchCommand("goal_update", { rawObjective: "x" })).rejects.toThrow(
      /goal_update.goalId is required/
    )
    await expect(dispatchCommand("goal_update", { goalId: "g1" })).rejects.toThrow(
      /requires rawObjective and\/or config/
    )
    await expect(
      dispatchCommand("goal_update", { goalId: "g1", rawObjective: "  " })
    ).rejects.toThrow(/must be a non-empty string/)
  })

  it("goal_status reads one goal by id", async () => {
    await expect(dispatchCommand("goal_status", { goalId: "g1" })).resolves.toEqual({
      goal: { id: "g1", status: "active" },
    })
    expect(mockGetActiveGoalForSession).not.toHaveBeenCalled()
  })

  it("goal_status answers a session with its active goal plus the full list", async () => {
    await expect(dispatchCommand("goal_status", { sessionId: "s1" })).resolves.toEqual({
      activeGoal: { id: "g1" },
      goals: [{ id: "g1" }, { id: "g0" }],
    })
  })

  it("goal_status normalizes a missing goal to null rather than undefined", async () => {
    mockGetGoal.mockResolvedValueOnce(undefined)
    await expect(dispatchCommand("goal_status", { goalId: "nope" })).resolves.toEqual({
      goal: null,
    })
  })

  it("goal_status requires goalId or sessionId", async () => {
    await expect(dispatchCommand("goal_status", {})).rejects.toThrow(
      /goal_status requires goalId or sessionId/
    )
  })
})

describe("dispatchCommand: character_upsert / character_delete / character_bind_twin", () => {
  it("character_upsert creates without an id and updates with one", async () => {
    const created = (await dispatchCommand("character_upsert", {
      draft: { name: "Ada", systemPrompt: "be precise" },
    })) as { character: { id: string; name: string } }
    expect(created.character.name).toBe("Ada")

    await dispatchCommand("character_upsert", {
      id: created.character.id,
      draft: { name: "Ada Lovelace" },
    })
    const row = await getDb().characters.get(created.character.id)
    expect(row?.name).toBe("Ada Lovelace")
    // An update must not create a second row.
    expect(await getDb().characters.count()).toBe(1)
  })

  it("character_upsert rejects a missing or non-object draft", async () => {
    await expect(dispatchCommand("character_upsert", {})).rejects.toThrow(
      /character_upsert.draft is required/
    )
    await expect(dispatchCommand("character_upsert", { draft: "nope" })).rejects.toThrow(
      /character_upsert.draft is required/
    )
  })

  it("character_delete removes the row and requires an id", async () => {
    const created = (await dispatchCommand("character_upsert", {
      draft: { name: "Temp", systemPrompt: "" },
    })) as { character: { id: string } }

    await expect(dispatchCommand("character_delete", { id: created.character.id })).resolves.toBe(
      null
    )
    expect(await getDb().characters.get(created.character.id)).toBeUndefined()
    await expect(dispatchCommand("character_delete", {})).rejects.toThrow(
      /character_delete.id is required/
    )
  })

  it("character_bind_twin binds a twin and clears it on an explicit null", async () => {
    const created = (await dispatchCommand("character_upsert", {
      draft: { name: "Bound", systemPrompt: "" },
    })) as { character: { id: string } }

    await dispatchCommand("character_bind_twin", {
      characterId: created.character.id,
      twinId: "twin-1",
    })
    expect((await getDb().characters.get(created.character.id))?.twinId).toBe("twin-1")

    // `null` is the unbind signal — it must not become the string "null".
    await dispatchCommand("character_bind_twin", {
      characterId: created.character.id,
      twinId: null,
    })
    expect((await getDb().characters.get(created.character.id))?.twinId).toBeUndefined()
  })

  it("character_bind_twin requires a characterId", async () => {
    await expect(dispatchCommand("character_bind_twin", { twinId: "t1" })).rejects.toThrow(
      /character_bind_twin.characterId is required/
    )
  })
})

describe("dispatchCommand: skill_set_enabled", () => {
  beforeEach(async () => {
    await getDb().skills.put({ id: "sk1", status: "disabled" } as never)
  })

  it("translates the boolean RPC into the stored status enum", async () => {
    await dispatchCommand("skill_set_enabled", { id: "sk1", enabled: true })
    expect((await getDb().skills.get("sk1"))?.status).toBe("enabled")

    await dispatchCommand("skill_set_enabled", { id: "sk1", enabled: false })
    expect((await getDb().skills.get("sk1"))?.status).toBe("disabled")
  })

  it("requires an id and a real boolean", async () => {
    await expect(dispatchCommand("skill_set_enabled", { enabled: true })).rejects.toThrow(
      /skill_set_enabled.id is required/
    )
    await expect(
      dispatchCommand("skill_set_enabled", { id: "sk1", enabled: "yes" })
    ).rejects.toThrow(/skill_set_enabled.enabled must be boolean/)
  })
})

describe("dispatchCommand: adapter_update_policy", () => {
  const quietHours = { from: "22:00", to: "07:00", tz: "Asia/Shanghai" }

  beforeEach(async () => {
    await getDb().adapterInstances.put({
      id: "ad1",
      defaultMode: "manual",
      muted: false,
      quietHours,
    } as never)
  })

  it("applies only the fields the caller actually sent", async () => {
    await dispatchCommand("adapter_update_policy", { id: "ad1", muted: true })
    const row = await getDb().adapterInstances.get("ad1")
    expect(row?.muted).toBe(true)
    // Untouched fields survive — this is a patch, not a replace.
    expect(row?.defaultMode).toBe("manual")
    expect(row?.quietHours).toEqual(quietHours)
  })

  it("accepts the three known modes and ignores anything else", async () => {
    await dispatchCommand("adapter_update_policy", { id: "ad1", defaultMode: "auto" })
    expect((await getDb().adapterInstances.get("ad1"))?.defaultMode).toBe("auto")

    await dispatchCommand("adapter_update_policy", { id: "ad1", defaultMode: "chaos" })
    expect((await getDb().adapterInstances.get("ad1"))?.defaultMode).toBe("auto")
  })

  it("replaces a complete quiet window and ignores a partial one", async () => {
    const next = { from: "23:00", to: "06:00", tz: "UTC" }
    await dispatchCommand("adapter_update_policy", { id: "ad1", quietHours: next })
    expect((await getDb().adapterInstances.get("ad1"))?.quietHours).toEqual(next)

    await dispatchCommand("adapter_update_policy", { id: "ad1", quietHours: { from: "01:00" } })
    expect((await getDb().adapterInstances.get("ad1"))?.quietHours).toEqual(next)
  })

  it("unsets the quiet window on an explicit null", async () => {
    // Dexie's UpdateSpec rejects `null` for a non-nullable field, so the handler
    // hand-rolls the unset through `modify` — the distinction between "leave
    // unchanged" (absent) and "clear" (null) is the whole point of this arm.
    await dispatchCommand("adapter_update_policy", { id: "ad1", quietHours: null })
    const row = await getDb().adapterInstances.get("ad1")
    expect(row).toBeDefined()
    expect(row?.quietHours).toBeUndefined()
  })

  it("requires an id", async () => {
    await expect(dispatchCommand("adapter_update_policy", { muted: true })).rejects.toThrow(
      /adapter_update_policy.id is required/
    )
  })
})

describe("dispatchCommand: app_settings_update", () => {
  it("persists the patch and answers with the merged settings", async () => {
    const res = (await dispatchCommand("app_settings_update", {
      patch: { theme: "dark" },
    })) as { settings: { theme?: string } }
    expect(res.settings.theme).toBe("dark")
  })

  it("rejects a missing or non-object patch", async () => {
    await expect(dispatchCommand("app_settings_update", {})).rejects.toThrow(
      /app_settings_update.patch is required/
    )
    await expect(dispatchCommand("app_settings_update", { patch: "dark" })).rejects.toThrow(
      /app_settings_update.patch is required/
    )
  })
})

describe("dispatchCommand: twin_profile_get", () => {
  it("returns the stored profile, which is keyed by the twin id (1:1)", async () => {
    await getDb().twinProfile.put({ id: "t1", twinId: "t1", entities: [] } as never)
    await expect(dispatchCommand("twin_profile_get", { twinId: "t1" })).resolves.toEqual({
      profile: { id: "t1", twinId: "t1", entities: [] },
    })
  })

  it("normalizes an absent profile to null rather than undefined", async () => {
    await expect(dispatchCommand("twin_profile_get", { twinId: "missing" })).resolves.toEqual({
      profile: null,
    })
  })

  it("requires a twinId", async () => {
    await expect(dispatchCommand("twin_profile_get", {})).rejects.toThrow(
      /twin_profile_get.twinId is required/
    )
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
    expect(mockUpdateConfig).toHaveBeenCalledWith("a1", { enabled: false })
    expect(mockExternalAgents.a1.enabled).toBe(false)
    // The store is never written directly, or the runtime would drift from it.
    expect(mockUpdateAgent).not.toHaveBeenCalled()
  })

  it("external_agent_update clamps an unsupported permission mode per protocol", async () => {
    // Codex (codex-app-server) cannot enforce `dontAsk` → clamps to a supported
    // mode (never `dontAsk`).
    await dispatchCommand("external_agent_update", {
      id: "a2",
      patch: { defaultPermissionMode: "dontAsk" },
    })
    const applied = mockUpdateConfig.mock.calls.at(-1)?.[1] as { defaultPermissionMode: string }
    expect(applied.defaultPermissionMode).not.toBe("dontAsk")
  })

  it("external_agent_update passes a supported mode through unchanged", async () => {
    await dispatchCommand("external_agent_update", {
      id: "a1",
      patch: { defaultPermissionMode: "acceptEdits" },
    })
    expect(mockUpdateConfig).toHaveBeenCalledWith("a1", { defaultPermissionMode: "acceptEdits" })
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

describe("dispatchCommand: retrieval profile DEK pairing", () => {
  it("exports key material only through content protocol v1 and clears the temporary bytes", async () => {
    const rawKey = Uint8Array.from({ length: 32 }, (_, index) => index)
    mockExportForPairing.mockResolvedValue({
      profileId: "memory-shared",
      keyId: "dek-1",
      rawKey,
    })

    const result = (await dispatchCommand("retrieval_profile_dek_export", {
      profileId: "memory-shared",
      contentProtocolVersion: 1,
    })) as Record<string, unknown>

    expect(mockExportForPairing).toHaveBeenCalledWith("memory-shared", {
      authenticated: true,
      protocolVersion: 1,
    })
    expect(result).toMatchObject({
      protocolVersion: 1,
      profileId: "memory-shared",
      keyId: "dek-1",
      rawKey: expect.any(String),
    })
    expect(rawKey.every((byte) => byte === 0)).toBe(true)
  })

  it("rejects missing profile ids and old clients before reading key material", async () => {
    await expect(
      dispatchCommand("retrieval_profile_dek_export", { contentProtocolVersion: 1 })
    ).rejects.toThrow("profileId is required")
    await expect(
      dispatchCommand("retrieval_profile_dek_export", {
        profileId: "memory-shared",
        contentProtocolVersion: 0,
      })
    ).rejects.toThrow("upgrade_required")
    expect(mockExportForPairing).not.toHaveBeenCalled()
  })
})

describe("dispatchCommand: session attachment upload", () => {
  const { getDb } = jest.requireActual("@/lib/db/schema") as typeof import("@/lib/db/schema")

  /** A minimal PNG payload, so the commit's magic-byte sniff is satisfied. */
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

  const toBase64 = (bytes: Uint8Array) =>
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")

  async function hashOf(bytes: Uint8Array): Promise<string> {
    const { sha256Bytes } = await import("@/lib/ocr/hash")
    return sha256Bytes(bytes)
  }

  beforeEach(async () => {
    await getDb().sessionAttachmentUploads.clear()
  })

  it("carries a file across and hands back a ref the message can name", async () => {
    const hash = await hashOf(PNG)
    const init = (await dispatchCommand("session_attachment_upload_init", {
      sessionId: "s-up",
      callerDeviceId: "dev-1",
      name: "shot.png",
      mediaType: "image/png",
      size: PNG.byteLength,
      hash,
    })) as { uploadId: string; chunkSize: number; resumeOffset: number; complete: boolean }

    expect(init.resumeOffset).toBe(0)
    expect(init.complete).toBe(false)
    expect(init.chunkSize).toBeGreaterThan(0)

    const chunk = await dispatchCommand("session_attachment_upload_chunk", {
      uploadId: init.uploadId,
      callerDeviceId: "dev-1",
      offset: 0,
      dataBase64: toBase64(PNG),
    })
    expect(chunk).toEqual({ receivedBytes: PNG.byteLength, complete: true })

    const committed = (await dispatchCommand("session_attachment_upload_commit", {
      uploadId: init.uploadId,
      callerDeviceId: "dev-1",
    })) as { ref: string; mediaType: string }
    expect(committed.ref).toBe(`cognia-upload:${init.uploadId}`)
    expect(committed.mediaType).toBe("image/png")
  })

  /**
   * `rpc.rs::inject_caller_device_id` overwrites whatever the client sent, so
   * this arm must read only the injected field. Trusting a self-asserted one
   * would let any paired device append to — or resolve — another device's file.
   */
  it("refuses every arm without the server-injected caller", async () => {
    for (const [command, payload] of [
      [
        "session_attachment_upload_init",
        { sessionId: "s", name: "a.png", mediaType: "image/png", size: 4, hash: "a".repeat(64) },
      ],
      ["session_attachment_upload_chunk", { uploadId: "u", offset: 0, dataBase64: "AAAA" }],
      ["session_attachment_upload_commit", { uploadId: "u" }],
      ["session_attachment_upload_abort", { uploadId: "u" }],
    ] as const) {
      await expect(dispatchCommand(command, { ...payload, deviceId: "spoofed" })).rejects.toThrow(
        /callerDeviceId is required/
      )
    }
  })

  it("rejects a malformed chunk instead of silently storing fewer bytes", async () => {
    const hash = await hashOf(PNG)
    const init = (await dispatchCommand("session_attachment_upload_init", {
      sessionId: "s-bad",
      callerDeviceId: "dev-1",
      name: "shot.png",
      mediaType: "image/png",
      size: PNG.byteLength,
      hash,
    })) as { uploadId: string }

    await expect(
      dispatchCommand("session_attachment_upload_chunk", {
        uploadId: init.uploadId,
        callerDeviceId: "dev-1",
        offset: 0,
        dataBase64: "not base64!!",
      })
    ).rejects.toThrow(/not valid base64/)
    await expect(
      dispatchCommand("session_attachment_upload_chunk", {
        uploadId: init.uploadId,
        callerDeviceId: "dev-1",
        offset: 0,
        dataBase64: "",
      })
    ).rejects.toThrow(/dataBase64 is required/)
  })

  it("aborting frees the staging slot", async () => {
    const hash = await hashOf(PNG)
    const init = (await dispatchCommand("session_attachment_upload_init", {
      sessionId: "s-abort",
      callerDeviceId: "dev-1",
      name: "shot.png",
      mediaType: "image/png",
      size: PNG.byteLength,
      hash,
    })) as { uploadId: string }

    expect(
      await dispatchCommand("session_attachment_upload_abort", {
        uploadId: init.uploadId,
        callerDeviceId: "dev-1",
      })
    ).toBeNull()
    // Re-initing the same content now opens a NEW upload rather than rejoining
    // the aborted one, which is how the client learns the slot was released.
    const reopened = (await dispatchCommand("session_attachment_upload_init", {
      sessionId: "s-abort",
      callerDeviceId: "dev-1",
      name: "shot.png",
      mediaType: "image/png",
      size: PNG.byteLength,
      hash,
    })) as { uploadId: string; resumeOffset: number }
    expect(reopened.uploadId).not.toBe(init.uploadId)
    expect(reopened.resumeOffset).toBe(0)
  })
})

describe("dispatchCommand: unknown command", () => {
  it("returns the versioned host feature contract with least-privilege defaults", async () => {
    await expect(dispatchCommand("host_feature_manifest", {})).resolves.toMatchObject({
      schemaVersion: 2,
      hostBuildId: expect.any(String),
      platform: expect.any(String),
      generatedAt: expect.any(Number),
      protocol: { min: 1, max: 2 },
      deviceGrants: ["host.observe"],
      features: {
        "claude.host-tools": {
          version: 1,
          operations: expect.arrayContaining(["claude_send", "claude_interrupt"]),
        },
      },
      limits: {
        rpcJsonBodyBytes: 64 * 1024,
        skillUploadChunkBytes: 32 * 1024,
      },
    })
  })

  it("projects only the authenticated caller grants supplied by the RPC boundary", async () => {
    await expect(
      dispatchCommand("host_feature_manifest", {
        callerDeviceGrants: ["host.observe", "agent.run"],
      })
    ).resolves.toMatchObject({
      deviceGrants: ["host.observe", "agent.run"],
    })
  })

  it("throws an explicit error", async () => {
    await expect(dispatchCommand("not_a_real_command", {})).rejects.toThrow(
      /unknown desktop-write command: not_a_real_command/
    )
  })
})
