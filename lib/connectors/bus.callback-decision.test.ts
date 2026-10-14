/** @jest-environment jsdom */

import type {
  ConnectorCallbackBindingKind,
  ConnectorCallbackBindingRow,
  ConnectorCallbackDecision,
  ConnectorCallbackEvent,
} from "@/types/connectors/interaction"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import { getBus, __resetBusForTesting } from "./bus"
import { appendAudit } from "./audit"
import { isRecordedInbound, recordAndCheckInbound } from "./dedup"
import { resolveCallbackBinding } from "./adapters/_shared/a2ui-mapper"
import { authorizeConnectorCallback, notifyCallbackDenied } from "./callback-authorization"
import { applyToolApprovalCallback } from "./hitl/tool-approval"
import { applyPlanApprovalCallback } from "./hitl/plan-approval"
import { applyAskUserCallback } from "./hitl/ask-user-question"
import { handleWorkflowApprovalCallback } from "@/lib/a2ui/workflow-approval-handler"
import { runBuiltInSkill } from "@/lib/skills/built-in/dispatcher"
import { handleIssueActionCallback } from "@/lib/issues/im/callback-handler"
import { handleNotificationActionCallback } from "@/lib/notifications/im-callback-handler"

jest.mock("./dedup", () => ({
  isRecordedInbound: jest.fn(),
  recordAndCheckInbound: jest.fn(),
}))
jest.mock("./audit", () => ({ appendAudit: jest.fn() }))
jest.mock("./adapters/_shared/a2ui-mapper", () => ({ resolveCallbackBinding: jest.fn() }))
jest.mock("@/lib/db/adapter-instances", () => ({ getAdapterInstance: jest.fn() }))
jest.mock("@/lib/db/conversation-overrides", () => ({
  readForResolution: jest.fn(async () => null),
}))
jest.mock("./callback-authorization", () => ({
  authorizeConnectorCallback: jest.fn(),
  notifyCallbackDenied: jest.fn(),
  resolveLarkCallbackConversation: jest.fn(async () => null),
}))
jest.mock("./hitl/approval-card-state", () => ({ settleApprovalCard: jest.fn() }))
jest.mock("./hitl/tool-approval", () => ({ applyToolApprovalCallback: jest.fn() }))
jest.mock("./hitl/plan-approval", () => ({ applyPlanApprovalCallback: jest.fn() }))
jest.mock("./hitl/ask-user-question", () => ({ applyAskUserCallback: jest.fn() }))
jest.mock("./hitl/ask-user-registry", () => ({ getPendingAskUserBySurface: jest.fn() }))
jest.mock("./hitl/approval-registry", () => ({ resolveApproval: jest.fn() }))
jest.mock("@/lib/a2ui/workflow-approval-handler", () => ({
  handleWorkflowApprovalCallback: jest.fn(),
}))
jest.mock("@/lib/skills/built-in/dispatcher", () => ({ runBuiltInSkill: jest.fn() }))
jest.mock("@/lib/execution/run-control", () => ({ executeRunControlCommand: jest.fn() }))
jest.mock("@/lib/issues/im/callback-handler", () => ({ handleIssueActionCallback: jest.fn() }))
jest.mock("@/lib/notifications/im-callback-handler", () => ({
  handleNotificationActionCallback: jest.fn(),
}))

function event(overrides: Partial<ConnectorCallbackEvent> = {}): ConnectorCallbackEvent {
  return {
    platform: "lark",
    adapterId: "lark-bot",
    selfId: "bot",
    triggerId: "button-click",
    surfaceId: "surface",
    componentId: "button",
    actionType: "button",
    value: "approve",
    conversationKey: "lark:lark-bot:chat",
    user: {
      id: "identity",
      platform: "lark",
      adapterId: "lark-bot",
      remoteUserId: "user",
    },
    timestamp: 1,
    raw: {},
    ...overrides,
  }
}

function binding(
  kind: ConnectorCallbackBindingKind,
  payload?: Record<string, unknown>
): ConnectorCallbackBindingRow {
  return {
    id: "lark-bot:button-click",
    adapterId: "lark-bot",
    actionId: "button-click",
    surfaceId: "surface",
    kind,
    createdAt: 1,
    payload,
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  __resetBusForTesting()
  jest.clearAllMocks()
  jest.mocked(isRecordedInbound).mockResolvedValue(false)
  jest.mocked(recordAndCheckInbound).mockResolvedValue(true)
  jest.mocked(appendAudit).mockResolvedValue(undefined as never)
  jest.mocked(resolveCallbackBinding).mockResolvedValue(undefined)
  jest.mocked(getAdapterInstance).mockResolvedValue(undefined)
  jest.mocked(authorizeConnectorCallback).mockResolvedValue({ allowed: true, mode: "enforce" })
  jest.mocked(notifyCallbackDenied).mockResolvedValue(undefined)
  jest.mocked(applyToolApprovalCallback).mockReturnValue({ granted: true, resolved: true })
  jest.mocked(applyPlanApprovalCallback).mockReturnValue({ approved: true, resolved: true })
  jest
    .mocked(applyAskUserCallback)
    .mockResolvedValue({ handled: true, resolved: true, op: "select" })
  jest.mocked(handleWorkflowApprovalCallback).mockResolvedValue(undefined)
  jest.mocked(runBuiltInSkill).mockResolvedValue(undefined as never)
  jest.mocked(handleIssueActionCallback).mockReset()
  jest.mocked(handleNotificationActionCallback).mockReset()
})

describe("ConnectorBus callback decisions", () => {
  it("keeps the reception audit without waiting for its write before acceptance", async () => {
    const bus = getBus()
    const finishAudit = deferred()
    const onDecision = jest.fn()
    bus.callbackHandler = jest.fn()
    jest.mocked(appendAudit).mockImplementationOnce(async () => {
      await finishAudit.promise
      return undefined as never
    })
    try {
      await bus.dispatchConnectorCallback(event(), { onDecision })
      expect(appendAudit).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "callback.received" })
      )
      expect(onDecision).toHaveBeenCalledTimes(1)
      expect(onDecision).toHaveBeenCalledWith({
        status: "accepted",
        kind: "generic",
        action: "approve",
      })
      expect(bus.callbackHandler).toHaveBeenCalledTimes(1)
    } finally {
      finishAudit.resolve()
    }
  })

  it("accepts exactly once before a digest handler finishes", async () => {
    const bus = getBus()
    const entered = deferred()
    const finish = deferred()
    const onDecision = jest.fn<void, [ConnectorCallbackDecision]>()
    bus.callbackHandler = jest.fn(async () => {
      entered.resolve()
      await finish.promise
    })
    const dispatch = bus.dispatchConnectorCallback(event(), { onDecision })
    await entered.promise
    expect(onDecision).toHaveBeenCalledTimes(1)
    expect(onDecision).toHaveBeenCalledWith({
      status: "accepted",
      kind: "generic",
      action: "approve",
    })
    expect(onDecision.mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(bus.callbackHandler).mock.invocationCallOrder[0]
    )
    finish.resolve()
    await expect(dispatch).resolves.toBe("terminal")
    expect(onDecision).toHaveBeenCalledTimes(1)
  })

  it("reports deduped before writing its audit row", async () => {
    const onDecision = jest.fn()
    jest.mocked(isRecordedInbound).mockResolvedValue(true)
    jest.mocked(appendAudit).mockImplementationOnce(async () => {
      expect(onDecision).toHaveBeenCalledWith({ status: "deduped" })
      return undefined as never
    })
    await getBus().dispatchConnectorCallback(event(), { onDecision })
    expect(onDecision).toHaveBeenCalledTimes(1)
    expect(onDecision).toHaveBeenCalledWith({ status: "deduped" })
    expect(resolveCallbackBinding).not.toHaveBeenCalled()
  })

  it("reports concurrent redelivery as in_flight without consuming it", async () => {
    const bus = getBus()
    const entered = deferred()
    const finish = deferred()
    bus.callbackHandler = async () => {
      entered.resolve()
      await finish.promise
    }
    const dispatch = bus.dispatchConnectorCallback(event())
    await entered.promise
    const onDecision = jest.fn()
    await expect(bus.dispatchConnectorCallback(event(), { onDecision })).resolves.toBe("retry")
    expect(onDecision).toHaveBeenCalledTimes(1)
    expect(onDecision).toHaveBeenCalledWith({ status: "in_flight" })
    expect(recordAndCheckInbound).not.toHaveBeenCalled()
    finish.resolve()
    await dispatch
  })

  it("reports expired when neither a binding nor a surface exists", async () => {
    const onDecision = jest.fn()
    await getBus().dispatchConnectorCallback(event({ surfaceId: "" }), { onDecision })
    expect(onDecision).toHaveBeenCalledTimes(1)
    expect(onDecision).toHaveBeenCalledWith({ status: "expired" })
  })

  it("reports denied before a slow denial notification", async () => {
    const bus = getBus()
    bus.callbackHandler = jest.fn()
    const onDecision = jest.fn()
    jest.mocked(authorizeConnectorCallback).mockResolvedValue({
      allowed: false,
      mode: "enforce",
      reason: "actor_forbidden",
      auditFields: {},
    })
    jest.mocked(notifyCallbackDenied).mockImplementationOnce(async () => {
      expect(onDecision).toHaveBeenCalledWith({ status: "denied", reason: "actor_forbidden" })
    })
    await bus.dispatchConnectorCallback(event(), { onDecision })
    expect(onDecision).toHaveBeenCalledTimes(1)
    expect(onDecision).toHaveBeenCalledWith({ status: "denied", reason: "actor_forbidden" })
    expect(bus.callbackHandler).not.toHaveBeenCalled()
  })

  it("accepts shadow-mode denials that the bus still routes", async () => {
    const bus = getBus()
    bus.callbackHandler = jest.fn()
    const onDecision = jest.fn()
    jest.mocked(authorizeConnectorCallback).mockResolvedValue({
      allowed: false,
      mode: "audit",
      reason: "actor_forbidden",
      auditFields: {},
    })
    await bus.dispatchConnectorCallback(event(), { onDecision })
    expect(onDecision).toHaveBeenCalledTimes(1)
    expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ status: "accepted" }))
  })

  it("reports a retryable binding failure exactly once", async () => {
    const onDecision = jest.fn()
    jest.mocked(resolveCallbackBinding).mockRejectedValueOnce(new Error("database unavailable"))
    await expect(getBus().dispatchConnectorCallback(event(), { onDecision })).resolves.toBe("retry")
    expect(onDecision).toHaveBeenCalledTimes(1)
    expect(onDecision).toHaveBeenCalledWith({ status: "failed" })
    expect(recordAndCheckInbound).not.toHaveBeenCalled()
  })

  it("guarantees failed when the route has no handler", async () => {
    const onDecision = jest.fn()
    await getBus().dispatchConnectorCallback(event(), { onDecision })
    expect(onDecision).toHaveBeenCalledTimes(1)
    expect(onDecision).toHaveBeenCalledWith({ status: "failed" })
  })

  it("contains observer failures and does not report a second decision", async () => {
    const bus = getBus()
    bus.callbackHandler = jest.fn()
    const onDecision = jest.fn(() => {
      throw new Error("transport closed")
    })
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      await expect(bus.dispatchConnectorCallback(event(), { onDecision })).resolves.toBe("terminal")
      expect(onDecision).toHaveBeenCalledTimes(1)
      expect(bus.callbackHandler).toHaveBeenCalledTimes(1)
    } finally {
      error.mockRestore()
    }
  })

  it("reports a failure before the route can be determined", async () => {
    const onDecision = jest.fn()
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined)
    jest.mocked(isRecordedInbound).mockRejectedValueOnce(new Error("ledger unavailable"))
    try {
      await getBus().dispatchConnectorCallback(event(), { onDecision })
      expect(onDecision).toHaveBeenCalledTimes(1)
      expect(onDecision).toHaveBeenCalledWith({ status: "failed" })
    } finally {
      error.mockRestore()
    }
  })

  it.each(["allow", "deny", "allow_session"] as const)(
    "reports the authoritative tool approval decision %s",
    async (decision) => {
      const onDecision = jest.fn()
      jest.mocked(resolveCallbackBinding).mockResolvedValue(
        binding("tool_approve", {
          sessionId: "session",
          requestId: "request",
          toolName: "Bash",
          decision,
        })
      )
      await getBus().dispatchConnectorCallback(event(), { onDecision })
      expect(onDecision).toHaveBeenCalledTimes(1)
      expect(onDecision).toHaveBeenCalledWith({
        status: "accepted",
        kind: "tool_approve",
        decision,
      })
    }
  )

  it.each(["tool_approve", "plan_approve"] as const)(
    "reports expired for a stale %s gate",
    async (kind) => {
      const onDecision = jest.fn()
      jest.mocked(resolveCallbackBinding).mockResolvedValue(binding(kind, { decision: "approve" }))
      jest.mocked(applyToolApprovalCallback).mockReturnValue({ granted: false, resolved: false })
      jest.mocked(applyPlanApprovalCallback).mockReturnValue({ approved: true, resolved: false })
      await getBus().dispatchConnectorCallback(event(), { onDecision })
      expect(onDecision).toHaveBeenCalledTimes(1)
      expect(onDecision).toHaveBeenCalledWith({ status: "expired" })
    }
  )

  it.each([true, false])("reports the plan approval action (approved=%s)", async (approved) => {
    const onDecision = jest.fn()
    jest.mocked(resolveCallbackBinding).mockResolvedValue(
      binding("plan_approve", {
        runId: "run",
        requestId: "request",
        decision: approved ? "approve" : "reject",
      })
    )
    jest.mocked(applyPlanApprovalCallback).mockReturnValue({ approved, resolved: true })
    await getBus().dispatchConnectorCallback(event(), { onDecision })
    expect(onDecision).toHaveBeenCalledTimes(1)
    expect(onDecision).toHaveBeenCalledWith({
      status: "accepted",
      kind: "plan_approve",
      action: approved ? "approve" : "cancel",
    })
  })

  it.each(["wf_approve", "wf_cancel", "skill_invoke"] as const)(
    "reports %s before invoking its long-running handler",
    async (kind) => {
      const entered = deferred()
      const finish = deferred()
      const onDecision = jest.fn()
      const action = kind === "wf_cancel" ? "cancel" : "approve"
      jest.mocked(resolveCallbackBinding).mockResolvedValue(binding(kind, { skillId: "skill" }))
      const handler = async () => {
        entered.resolve()
        await finish.promise
        return undefined as never
      }
      jest.mocked(handleWorkflowApprovalCallback).mockImplementation(handler)
      jest.mocked(runBuiltInSkill).mockImplementation(handler)
      const dispatch = getBus().dispatchConnectorCallback(event(), { onDecision })
      await entered.promise
      expect(onDecision).toHaveBeenCalledTimes(1)
      expect(onDecision).toHaveBeenCalledWith({ status: "accepted", kind, action })
      expect(onDecision.mock.invocationCallOrder[0]).toBeLessThan(
        jest.mocked(kind === "skill_invoke" ? runBuiltInSkill : handleWorkflowApprovalCallback).mock
          .invocationCallOrder[0]
      )
      finish.resolve()
      await dispatch
      expect(onDecision).toHaveBeenCalledTimes(1)
    }
  )

  it("reports run control admission without awaiting execution", async () => {
    const onDecision = jest.fn()
    await getBus().dispatchConnectorCallback(
      event({
        surfaceId: "",
        payload: { runId: "run", action: "pause", revision: 1 },
      }),
      { onDecision }
    )
    expect(onDecision).toHaveBeenCalledTimes(1)
    expect(onDecision).toHaveBeenCalledWith({
      status: "accepted",
      kind: "run_control",
      action: "pause",
    })
  })

  it("does not accept an issue callback refused by sender policy", async () => {
    const onDecision = jest.fn()
    jest.mocked(resolveCallbackBinding).mockResolvedValue(binding("issue_action"))
    await getBus().dispatchConnectorCallback(event(), { onDecision })
    expect(onDecision).toHaveBeenCalledTimes(1)
    expect(onDecision).toHaveBeenCalledWith({ status: "denied", reason: "policy-unavailable" })
  })

  it.each(["issue_action", "notification_action"] as const)(
    "acknowledges %s routing before its handler completes",
    async (kind) => {
      const entered = deferred()
      const finish = deferred()
      const onDecision = jest.fn()
      jest.mocked(resolveCallbackBinding).mockResolvedValue(binding(kind))
      jest.mocked(getAdapterInstance).mockResolvedValue({
        id: "lark-bot",
        type: "lark",
        displayName: "Test bot",
        enabled: true,
        transportMode: "gateway",
        settings: {},
        credentialsRef: { keyringService: "test", accounts: [] },
        trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
        defaultMode: "auto",
        mediaModelPolicy: "local_extract_only",
        createdAt: 1,
        updatedAt: 1,
      })
      jest.mocked(handleIssueActionCallback).mockImplementationOnce(async () => {
        entered.resolve()
        await finish.promise
        return { kind: "run_refused", reason: "business-rule" }
      })
      jest.mocked(handleNotificationActionCallback).mockImplementationOnce(async () => {
        entered.resolve()
        await finish.promise
        return false
      })
      const dispatch = getBus().dispatchConnectorCallback(event(), { onDecision })
      await entered.promise
      try {
        expect(onDecision).toHaveBeenCalledTimes(1)
        expect(onDecision).toHaveBeenCalledWith({ status: "accepted", kind, action: "approve" })
        const handler =
          kind === "issue_action" ? handleIssueActionCallback : handleNotificationActionCallback
        expect(onDecision.mock.invocationCallOrder[0]).toBeLessThan(
          jest.mocked(handler).mock.invocationCallOrder[0]
        )
      } finally {
        finish.resolve()
        await dispatch
      }
      // Eventual business results do not turn a routing receipt into a second response.
      expect(onDecision).toHaveBeenCalledTimes(1)
    }
  )

  it("accepts a resolved ask_user select operation", async () => {
    const onDecision = jest.fn()
    jest.mocked(resolveCallbackBinding).mockResolvedValue(binding("ask_user"))
    jest
      .mocked(applyAskUserCallback)
      .mockResolvedValueOnce({ handled: true, resolved: true, op: "select" })
    await getBus().dispatchConnectorCallback(event(), { onDecision })
    expect(onDecision).toHaveBeenCalledTimes(1)
    expect(onDecision).toHaveBeenCalledWith({
      status: "accepted",
      kind: "ask_user",
      action: "select",
    })
  })

  it("acknowledges a stored toggle before card presentation completes", async () => {
    const entered = deferred()
    const finish = deferred()
    const onDecision = jest.fn()
    jest.mocked(resolveCallbackBinding).mockResolvedValue(binding("ask_user", { op: "toggle" }))
    jest.mocked(applyAskUserCallback).mockImplementationOnce(async ({ onToggleApplied }) => {
      onToggleApplied?.()
      entered.resolve()
      await finish.promise
      return { handled: true, resolved: false, op: "toggle" }
    })
    const dispatch = getBus().dispatchConnectorCallback(event(), { onDecision })
    await entered.promise
    try {
      expect(onDecision).toHaveBeenCalledWith({
        status: "accepted",
        kind: "ask_user",
        action: "toggle",
      })
    } finally {
      finish.resolve()
      await dispatch
    }
    expect(onDecision).toHaveBeenCalledTimes(1)
  })

  it("reports a bound toggle on a settled prompt as expired, never accepted", async () => {
    const onDecision = jest.fn()
    jest.mocked(resolveCallbackBinding).mockResolvedValue(binding("ask_user", { op: "toggle" }))
    jest.mocked(applyAskUserCallback).mockImplementationOnce(async ({ deps }) => {
      await deps!.audit!({
        adapterId: "lark-bot",
        at: 1,
        kind: "ask_user.answered",
        fields: { op: "toggle", resolved: false, stale: true },
      })
      return { handled: true, resolved: false, op: "toggle" }
    })
    await getBus().dispatchConnectorCallback(event(), { onDecision })
    expect(onDecision).toHaveBeenCalledTimes(1)
    expect(onDecision).toHaveBeenCalledWith({ status: "expired" })
  })

  it("reports a toggle with an unknown option as failed", async () => {
    const onDecision = jest.fn()
    jest.mocked(resolveCallbackBinding).mockResolvedValue(binding("ask_user", { op: "toggle" }))
    jest
      .mocked(applyAskUserCallback)
      .mockResolvedValueOnce({ handled: true, resolved: false, op: "toggle" })
    await getBus().dispatchConnectorCallback(event(), { onDecision })
    expect(onDecision).toHaveBeenCalledTimes(1)
    expect(onDecision).toHaveBeenCalledWith({ status: "failed" })
  })

  it("acknowledges a resolved question before its answer audit finishes", async () => {
    const auditStarted = deferred()
    const finishAudit = deferred()
    const onDecision = jest.fn()
    jest.mocked(resolveCallbackBinding).mockResolvedValue(binding("ask_user"))
    jest.mocked(appendAudit).mockImplementation(async (entry) => {
      if (entry.kind === "ask_user.answered") {
        auditStarted.resolve()
        await finishAudit.promise
      }
      return undefined as never
    })
    jest.mocked(applyAskUserCallback).mockImplementationOnce(async ({ deps }) => {
      await deps!.audit!({
        adapterId: "lark-bot",
        at: 1,
        kind: "ask_user.answered",
        fields: { resolved: true, op: "select" },
      })
      return { handled: true, resolved: true, op: "select" }
    })
    const dispatch = getBus().dispatchConnectorCallback(event(), { onDecision })
    await auditStarted.promise
    try {
      expect(onDecision).toHaveBeenCalledWith({
        status: "accepted",
        kind: "ask_user",
        action: "select",
      })
    } finally {
      finishAudit.resolve()
      await dispatch
    }
    expect(onDecision).toHaveBeenCalledTimes(1)
  })

  it.each([
    {
      kind: "callback.forbidden",
      reason: "actor_forbidden",
      fields: {},
      expected: { status: "denied", reason: "actor_forbidden" },
    },
    {
      kind: "ask_user.answered",
      reason: undefined,
      fields: { stale: true },
      expected: { status: "expired" },
    },
  ] as const)("observes authoritative ask_user $kind outcomes", async (outcome) => {
    const onDecision = jest.fn()
    jest.mocked(resolveCallbackBinding).mockResolvedValue(binding("ask_user"))
    jest.mocked(applyAskUserCallback).mockImplementationOnce(async ({ deps }) => {
      await deps!.audit!({
        adapterId: "lark-bot",
        at: 1,
        kind: outcome.kind,
        reason: outcome.reason,
        fields: outcome.fields,
      })
      return { handled: true, resolved: false, op: "toggle" }
    })
    await getBus().dispatchConnectorCallback(event(), { onDecision })
    expect(onDecision).toHaveBeenCalledTimes(1)
    expect(onDecision).toHaveBeenCalledWith(outcome.expected)
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: outcome.kind,
        fields: outcome.fields,
      })
    )
  })
})
