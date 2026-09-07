import type { ApprovalRequest, PendingApproval } from "@cognia/agent-config-types"
import { SharedApprovalBridge } from "./shared-approval-bridge"

const local: PendingApproval = {
  sessionId: "local",
  requestId: "request",
  toolUseID: "tool",
  toolName: "Read",
  input: { password: "hidden" },
}
function harness(initial: Partial<ApprovalRequest> = {}) {
  let current = true
  let now = 100
  let row: ApprovalRequest = {
    id: "approval",
    sessionId: "shared",
    runId: "run",
    action: "Read",
    risk: "ordinary",
    requestedByUserId: "user",
    status: "pending",
    createdAt: 1,
    expiresAt: 1000,
    revision: 1,
    ...initial,
  }
  const client = {
    createSessionApproval: jest.fn(async () => row),
    listSessionApprovals: jest.fn(async () => [row]),
    resolveSessionApproval: jest.fn(async (_org, _session, _id, input) => {
      row = { ...row, status: input.status, revision: row.revision + 1 }
      return row
    }),
  }
  const deliver = jest.fn().mockResolvedValue(undefined)
  const verifyExecution = jest.fn().mockResolvedValue(undefined)
  const bridge = new SharedApprovalBridge({
    client,
    orgId: "org",
    sessionId: "shared",
    runId: "run",
    isCurrent: () => current,
    verifyExecution,
    deliver,
    now: () => now,
  })
  return {
    bridge,
    client,
    deliver,
    verifyExecution,
    update: (next: Partial<ApprovalRequest>) => {
      row = { ...row, ...next }
    },
    expire: () => {
      now = 1001
    },
    revoke: () => {
      current = false
    },
  }
}

it("creates a durable server approval from a live tool waiter without leaking raw input", async () => {
  const h = harness()
  await h.bridge.sync([local])
  await h.bridge.sync([local])
  expect(h.client.createSessionApproval).toHaveBeenCalledTimes(1)
  expect(h.client.createSessionApproval).toHaveBeenCalledWith("org", "shared", {
    runId: "run",
    action: "Read",
    risk: "ordinary",
    expiresAt: 600100,
    operationId: "tool-approval:run:request",
  })
  expect(JSON.stringify(h.client.createSessionApproval.mock.calls)).not.toContain("hidden")
  expect(h.deliver).not.toHaveBeenCalled()
})

it("remote high-risk approval is delivered once to the existing waiter", async () => {
  const h = harness({ status: "approved" })
  const approval = { ...local, toolName: "Bash", title: "Run build" }
  await h.bridge.sync([approval])
  await h.bridge.sync([approval])
  expect(h.client.createSessionApproval).toHaveBeenCalledWith(
    "org",
    "shared",
    expect.objectContaining({ risk: "high", action: "Run build" })
  )
  expect(h.deliver).toHaveBeenCalledTimes(1)
  expect(h.deliver).toHaveBeenCalledWith(approval, "allow")
})

it.each(["expired", "cancelled", "denied"] as const)(
  "denies terminal %s approvals without restarting tools",
  async (status) => {
    const h = harness({ status })
    await h.bridge.sync([local])
    expect(h.deliver).toHaveBeenCalledWith(local, "deny")
  }
)

it("treats an expired pending or previously approved decision as a denial", async () => {
  const h = harness({ status: "approved" })
  h.expire()
  await h.bridge.sync([local])
  expect(h.deliver).toHaveBeenCalledWith(local, "deny")
  expect(await h.bridge.authorize(local, "allow")).toBe("deny")
  expect(h.verifyExecution).not.toHaveBeenCalled()
})

it("routes local allow-always through server permission checks and consumes it only once", async () => {
  const h = harness()
  expect(await h.bridge.authorize(local, "allow_always")).toBe("allow")
  expect(h.client.resolveSessionApproval).toHaveBeenCalledWith("org", "shared", "approval", {
    status: "approved",
    baseRevision: 1,
  })
  expect(h.verifyExecution).toHaveBeenCalledTimes(1)
  expect(await h.bridge.authorize(local, "allow")).toBeNull()
  await h.bridge.sync([local])
  expect(h.deliver).not.toHaveBeenCalled()
})

it("keeps permission refusals pending and never invokes the runtime", async () => {
  const h = harness()
  h.client.resolveSessionApproval.mockRejectedValueOnce(new Error("forbidden"))
  await expect(h.bridge.authorize(local, "allow")).rejects.toThrow("forbidden")
  expect(h.verifyExecution).not.toHaveBeenCalled()
  expect(h.deliver).not.toHaveBeenCalled()
})

it("rechecks the current execution lease before allowing a tool", async () => {
  const h = harness({ status: "approved" })
  h.verifyExecution.mockRejectedValueOnce(new Error("lease expired"))
  await expect(h.bridge.authorize(local, "allow")).rejects.toThrow("lease expired")
  h.revoke()
  await expect(h.bridge.sync([local])).rejects.toThrow("unavailable")
})

it("local denial remains one-shot and does not call the execution allow gate", async () => {
  const h = harness()
  expect(await h.bridge.authorize(local, "deny")).toBe("deny")
  expect(h.client.resolveSessionApproval.mock.calls[0][3]).toEqual({
    status: "denied",
    baseRevision: 1,
  })
  expect(h.verifyExecution).not.toHaveBeenCalled()
})

it("never automatically retries an uncertain delivery", async () => {
  const h = harness({ status: "approved" })
  h.deliver.mockImplementationOnce(async (approval, decision) => {
    await h.bridge.authorize(approval, decision)
    throw new Error("unknown delivery outcome")
  })
  await expect(h.bridge.sync([local])).rejects.toThrow("unknown delivery")
  await h.bridge.sync([local])
  expect(h.deliver).toHaveBeenCalledTimes(1)
})

it("retries failed creation with the same idempotent operation", async () => {
  const h = harness()
  h.client.createSessionApproval.mockRejectedValueOnce(new Error("offline"))
  await expect(h.bridge.sync([local])).rejects.toThrow("offline")
  await h.bridge.sync([local])
  expect(h.client.createSessionApproval.mock.calls[0]).toEqual(
    h.client.createSessionApproval.mock.calls[1]
  )
})

it("ignores interrupted waiters and refuses to authorize one directly", async () => {
  const h = harness()
  await h.bridge.sync([{ ...local, status: "interrupted" }])
  expect(h.client.listSessionApprovals).not.toHaveBeenCalled()
  await expect(h.bridge.authorize({ ...local, status: "interrupted" }, "allow")).rejects.toThrow(
    "cannot be replayed"
  )
})

it("fails closed on missing or foreign-run approval records", async () => {
  const h = harness()
  h.client.listSessionApprovals.mockResolvedValue([])
  await h.bridge.sync([local])
  expect(h.deliver).not.toHaveBeenCalled()
  await expect(h.bridge.authorize(local, "allow")).rejects.toThrow("unavailable")
})

it("retries pre-delivery failures before any tool decision is consumed", async () => {
  const h = harness({ status: "approved" })
  h.deliver.mockRejectedValueOnce(new Error("permission service unavailable"))
  await expect(h.bridge.sync([local])).rejects.toThrow("permission service unavailable")
  await h.bridge.sync([local])
  expect(h.deliver).toHaveBeenCalledTimes(2)
})

it("rejects an account switch after reading an approval before resolving it", async () => {
  const h = harness()
  h.client.listSessionApprovals.mockImplementationOnce(async () => {
    h.revoke()
    return []
  })
  await expect(h.bridge.authorize(local, "allow")).rejects.toThrow("lease is unavailable")
  expect(h.client.resolveSessionApproval).not.toHaveBeenCalled()
})
