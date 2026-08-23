import {
  APPROVAL_PENDING_PUSH_CHANNEL,
  APPROVAL_REQUEST_CHANNEL,
  APPROVAL_RESOLVED_CHANNEL,
  APPROVAL_RESPOND_COMMAND,
  installApprovalNotificationActions,
  notifyApprovalRequested,
  notifyApprovalResolved,
} from "./approval-notify"
import {
  getPendingApproval,
  registerPendingApproval,
  __resetApprovalRegistryForTesting,
  type PendingApproval,
} from "./approval-registry"
import {
  dispatchNotificationCommand,
  __resetNotificationCommandsForTesting,
} from "@/lib/notifications/action-registry"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  __resetHostEventPublisherForTests,
  setHostEventPublisher,
} from "@/lib/companion/host-event-publisher"

const entry: PendingApproval = {
  approvalId: "apr_run_x_n_gate",
  runId: "run_x",
  workflowId: "wf_x",
  stepId: "n_gate",
  title: "Deploy?",
  message: "Release v9",
  requestedAt: 1_000,
  timeoutAt: 2_000,
}

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await __resetApprovalRegistryForTesting()
  __resetHostEventPublisherForTests()
})
afterEach(async () => {
  await __resetApprovalRegistryForTesting()
  __resetNotificationCommandsForTesting()
})
afterAll(dbFixture.dispose)

describe("notifyApprovalRequested", () => {
  it("posts a directed notification with approve/reject actions", async () => {
    const notify = jest.fn(async () => "n1")
    await notifyApprovalRequested(entry, { notify })
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "workflow",
        directed: true,
        dedupeKey: entry.approvalId,
        title: expect.stringContaining("Deploy?"),
        href: "/workflows/wf_x/runs/run_x",
        actions: [
          expect.objectContaining({
            command: APPROVAL_RESPOND_COMMAND,
            args: { approvalId: entry.approvalId, decision: "approved" },
          }),
          expect.objectContaining({
            args: { approvalId: entry.approvalId, decision: "rejected" },
          }),
        ],
      })
    )
  })

  it("fans the full entry to WS and ids-only to the push channel (Tauri)", async () => {
    const notify = jest.fn(async () => "n1")
    const emit = jest.fn(async (_event: string, _payload: unknown) => undefined)
    await notifyApprovalRequested(entry, { notify, emit })
    expect(emit).toHaveBeenCalledWith(APPROVAL_REQUEST_CHANNEL, entry)
    expect(emit).toHaveBeenCalledWith(APPROVAL_PENDING_PUSH_CHANNEL, {
      approvalId: entry.approvalId,
      runId: entry.runId,
      workflowId: entry.workflowId,
    })
    // PII posture: the push payload never carries the title/message.
    const pushPayload = emit.mock.calls.find(([ch]) => ch === APPROVAL_PENDING_PUSH_CHANNEL)?.[1]
    expect(JSON.stringify(pushPayload)).not.toContain("Deploy?")
  })

  it("fans out through the host event seam without a platform gate", async () => {
    const emit = jest.fn(async () => undefined)
    setHostEventPublisher(emit)
    const notify = jest.fn(async () => "n1")
    await notifyApprovalRequested(entry, { notify })
    expect(emit).toHaveBeenCalledWith(APPROVAL_REQUEST_CHANNEL, entry)
    expect(emit).toHaveBeenCalledWith(APPROVAL_PENDING_PUSH_CHANNEL, {
      approvalId: entry.approvalId,
      runId: entry.runId,
      workflowId: entry.workflowId,
    })
  })

  it("never throws when either delivery surface fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    const emit = jest.fn(async () => {
      throw new Error("bus down")
    })
    const notify = jest.fn(async () => {
      throw new Error("center down")
    })
    await expect(notifyApprovalRequested(entry, { notify, emit })).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})

describe("notifyApprovalResolved", () => {
  it("emits the resolved frame with the decision", async () => {
    const emit = jest.fn(async () => undefined)
    await notifyApprovalResolved(entry, "approved", { emit })
    expect(emit).toHaveBeenCalledWith(APPROVAL_RESOLVED_CHANNEL, {
      approvalId: entry.approvalId,
      runId: entry.runId,
      workflowId: entry.workflowId,
      decision: "approved",
    })
  })
})

describe("installApprovalNotificationActions", () => {
  it("resolves the registry from a notification action click", async () => {
    const off = installApprovalNotificationActions()
    await registerPendingApproval(entry)
    await dispatchNotificationCommand({
      notificationId: "n1",
      command: APPROVAL_RESPOND_COMMAND,
      args: { approvalId: entry.approvalId, decision: "approved" },
    })
    await expect(getPendingApproval(entry.approvalId)).resolves.toBeUndefined()
    off()
  })

  it("ignores malformed action args", async () => {
    const off = installApprovalNotificationActions()
    await dispatchNotificationCommand({
      notificationId: "n1",
      command: APPROVAL_RESPOND_COMMAND,
      args: { approvalId: 42, decision: "maybe" },
    })
    off()
  })
})
/** @jest-environment jsdom */
import "fake-indexeddb/auto"
