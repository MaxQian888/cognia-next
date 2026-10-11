/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { __resetApprovalRegistryForTesting } from "@/lib/connectors/hitl/approval-registry"
import { createUnattendedPark } from "@/lib/claude/unattended-park"
import { createExecutionRun } from "@/lib/db/execution-runs"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { installExecutionRunControlHandlers } from "./control-handlers"
import { createRunInterrupt } from "./run-control"
import {
  RUN_APPROVAL_DETAIL_MAX_CHARS,
  RUN_APPROVAL_PAGE_SIZE_MAX,
  RunApprovalListRequestError,
  listRunApprovals,
  parseRunApprovalListRequest,
  respondRunApproval,
} from "./run-approvals"

jest.mock("@/lib/companion/host-event-publisher", () => ({
  publishHostEvent: jest.fn(async () => undefined),
}))

const NOW = 1_700_000_000_000

async function seedRun(id: string, kind: "bot" | "agent-turn", sessionId?: string) {
  await createExecutionRun({
    id,
    kind,
    sourceId: id,
    ...(sessionId ? { sessionId } : {}),
    title: kind === "bot" ? "Bot: Release notes" : "Scheduled task: Digest",
    status: "running",
    currentRevision: 0,
    startedAt: NOW,
    updatedAt: NOW,
  })
}

describe("run approvals", () => {
  let dispose: (() => void) | undefined

  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    __resetApprovalRegistryForTesting()
    dispose = installExecutionRunControlHandlers().dispose
  })
  afterEach(() => dispose?.())

  it("lists pending tool and Bot approvals with their run, oldest first", async () => {
    await seedRun("bot-run", "bot")
    await seedRun("turn-run", "agent-turn", "s1")
    await createRunInterrupt({
      id: "b1",
      runId: "bot-run",
      type: "bot_approval",
      status: "pending",
      title: "Publish release notes",
      approvalMessage: "Post to #releases?",
      approvalRisk: "medium",
      approvalDetail: { channel: "#releases" },
      createdAt: NOW + 2,
      expiresAt: Date.now() + 60_000,
    })
    await createRunInterrupt({
      id: "t1",
      runId: "turn-run",
      type: "tool_approval",
      status: "pending",
      title: "Approve im_send (outbound message)",
      toolName: "im_send",
      permissionClass: "outbound",
      requestDigest: "req-1",
      createdAt: NOW + 1,
      expiresAt: Date.now() + 60_000,
    })
    // Neither another kind, an answered one, nor an expired one is listed.
    await createRunInterrupt({
      id: "w1",
      runId: "turn-run",
      type: "workflow_approval",
      status: "pending",
      title: "Workflow",
      createdAt: NOW,
      expiresAt: Date.now() + 60_000,
    })
    await createRunInterrupt({
      id: "old",
      runId: "turn-run",
      type: "tool_approval",
      status: "pending",
      title: "Stale",
      createdAt: NOW,
      expiresAt: 1,
    })

    const { items: approvals, nextPageToken } = await listRunApprovals()
    expect(nextPageToken).toBeUndefined()
    expect(approvals.map((a) => a.interruptId)).toEqual(["t1", "b1"])
    expect(approvals[0]).toEqual({
      interruptId: "t1",
      runId: "turn-run",
      type: "tool_approval",
      title: "Approve im_send (outbound message)",
      runTitle: "Scheduled task: Digest",
      runKind: "agent-turn",
      toolName: "im_send",
      permissionClass: "outbound",
      createdAt: NOW + 1,
      expiresAt: expect.any(Number),
    })
    expect(approvals[1]).toMatchObject({
      type: "bot_approval",
      message: "Post to #releases?",
      risk: "medium",
      detail: { channel: "#releases" },
    })
  })

  it("keeps an oversized Bot proposal off the phone", async () => {
    await seedRun("bot-run", "bot")
    await createRunInterrupt({
      id: "b1",
      runId: "bot-run",
      type: "bot_approval",
      status: "pending",
      title: "Publish",
      approvalDetail: { body: "x".repeat(RUN_APPROVAL_DETAIL_MAX_CHARS) },
      createdAt: NOW,
      expiresAt: Date.now() + 60_000,
    })
    const [approval] = (await listRunApprovals()).items
    expect(approval).not.toHaveProperty("detail")
    expect(approval?.detailTruncated).toBe(true)
  })

  it("pages by token, oldest first, and ends without a token", async () => {
    await seedRun("bot-run", "bot")
    for (let i = 0; i < 5; i++) {
      await createRunInterrupt({
        id: `b${i}`,
        runId: "bot-run",
        type: "bot_approval",
        status: "pending",
        title: `Step ${i}`,
        createdAt: NOW + i,
        expiresAt: Date.now() + 60_000,
      })
    }
    const first = await listRunApprovals({ pageSize: 2 })
    expect(first.items.map((a) => a.interruptId)).toEqual(["b0", "b1"])
    expect(first.nextPageToken).toEqual(expect.any(String))
    const second = await listRunApprovals({ pageSize: 2, pageToken: first.nextPageToken })
    expect(second.items.map((a) => a.interruptId)).toEqual(["b2", "b3"])
    const last = await listRunApprovals({ pageSize: 2, pageToken: second.nextPageToken })
    expect(last.items.map((a) => a.interruptId)).toEqual(["b4"])
    expect(last).not.toHaveProperty("nextPageToken")
  })

  it("refuses a page size out of range and a token it never issued", () => {
    expect(parseRunApprovalListRequest({})).toEqual({ pageSize: 50, offset: 0 })
    expect(() => parseRunApprovalListRequest({ pageSize: 0 })).toThrow(RunApprovalListRequestError)
    expect(() => parseRunApprovalListRequest({ pageSize: RUN_APPROVAL_PAGE_SIZE_MAX + 1 })).toThrow(
      RunApprovalListRequestError
    )
    expect(() => parseRunApprovalListRequest({ pageToken: "o2" })).toThrow(
      "pageToken is not a token this host issued"
    )
    expect(() => parseRunApprovalListRequest({ pageToken: "ra:-1" })).toThrow(
      RunApprovalListRequestError
    )
  })

  it("refuses a malformed answer before reading anything", async () => {
    await expect(respondRunApproval({ decision: "approve", callerDeviceId: "d" })).resolves.toEqual(
      { ok: false, reason: "invalid-payload", field: "interruptId" }
    )
    await expect(
      respondRunApproval({ interruptId: "i", decision: "maybe", callerDeviceId: "d" })
    ).resolves.toEqual({ ok: false, reason: "invalid-payload", field: "decision" })
    await expect(respondRunApproval({ interruptId: "i", decision: "deny" })).resolves.toEqual({
      ok: false,
      reason: "invalid-payload",
      field: "callerDeviceId",
    })
  })

  it("answers only pending approvals of the two kinds it serves", async () => {
    await seedRun("turn-run", "agent-turn", "s1")
    await createRunInterrupt({
      id: "w1",
      runId: "turn-run",
      type: "workflow_approval",
      status: "pending",
      title: "Workflow",
      createdAt: NOW,
      expiresAt: Date.now() + 60_000,
    })
    const execute = jest.fn()
    await expect(
      respondRunApproval(
        { interruptId: "w1", decision: "approve", callerDeviceId: "phone-1" },
        { execute }
      )
    ).resolves.toEqual({ ok: false, reason: "gone" })
    await expect(
      respondRunApproval(
        { interruptId: "missing", decision: "approve", callerDeviceId: "phone-1" },
        { execute }
      )
    ).resolves.toEqual({ ok: false, reason: "gone" })
    expect(execute).not.toHaveBeenCalled()
  })

  it("approves a Bot step through the control gate as the calling device", async () => {
    await seedRun("bot-run", "bot")
    await createRunInterrupt({
      id: "b1",
      runId: "bot-run",
      type: "bot_approval",
      status: "pending",
      title: "Publish",
      createdAt: NOW,
      expiresAt: Date.now() + 60_000,
    })
    const announceResolved = jest.fn(async () => undefined)
    await expect(
      respondRunApproval(
        { interruptId: "b1", decision: "approve", callerDeviceId: "phone-1", deviceName: "Pixel" },
        { announceResolved }
      )
    ).resolves.toEqual({ ok: true, status: "approved" })
    const row = await getDb().executionRunInterrupts.get("b1")
    expect(row).toMatchObject({
      status: "approved",
      resolvedBy: { remoteUserId: "phone-1", displayName: "Pixel" },
    })
    expect(announceResolved).toHaveBeenCalledWith({
      interruptId: "b1",
      runId: "bot-run",
      status: "approved",
    })
    // A second answer finds nothing to answer.
    await expect(
      respondRunApproval({ interruptId: "b1", decision: "deny", callerDeviceId: "phone-1" })
    ).resolves.toEqual({ ok: false, reason: "gone" })
  })

  it("wakes a parked unattended turn with the phone's approval", async () => {
    const park = createUnattendedPark({
      origin: "scheduler",
      sessionId: "s1",
      label: "Scheduled task: Digest",
    })
    const parked = park.park({
      type: "permission_request",
      sessionId: "s1",
      requestId: "req-1",
      toolUseID: "tu-1",
      toolName: "im_send",
      input: {},
      permissionClass: "outbound",
    })
    let approval: Awaited<ReturnType<typeof listRunApprovals>>["items"][number] | undefined
    for (let i = 0; i < 50 && !approval; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      approval = (await listRunApprovals()).items[0]
    }
    expect(approval).toMatchObject({
      type: "tool_approval",
      runTitle: "Scheduled task: Digest",
      permissionClass: "outbound",
    })

    await expect(
      respondRunApproval({
        interruptId: approval!.interruptId,
        decision: "approve",
        callerDeviceId: "phone-1",
      })
    ).resolves.toEqual({ ok: true, status: "approved" })
    await expect(parked).resolves.toEqual({ kind: "approved", decision: { decision: "allow" } })
    expect((await getDb().executionRunInterrupts.get(approval!.interruptId))?.status).toBe(
      "approved"
    )
    await park.finish("completed")
    expect((await getDb().executionRuns.get(park.runId()!))?.status).toBe("completed")
  })
})
