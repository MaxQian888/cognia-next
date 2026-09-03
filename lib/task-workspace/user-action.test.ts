/**
 * The approval seam. Four shapes matter, and three of them were broken before
 * this module existed: a companion issuing a write with no lease, a companion
 * that cannot obtain one, and a refusal the caller could not tell apart from
 * any other error.
 */

const callMock = jest.fn()
const issueLeaseMock = jest.fn()
const snapshotMock = jest.fn()

jest.mock("@/lib/tauri", () => ({
  transport: { call: (...args: unknown[]) => callMock(...args) },
}))
jest.mock("@/lib/tauri/admin-lease", () => ({
  issueHostAdminLease: (...args: unknown[]) => issueLeaseMock(...args),
}))
jest.mock("@/lib/runtime/runtime-snapshot-store", () => ({
  getRuntimeSnapshot: () => snapshotMock(),
}))

import {
  applyWorkspaceApproval,
  approvalAwareTransport,
  getWorkspaceOperationAvailability,
  openWorkspaceApprovalScope,
  runWorkspaceUserAction,
  WORKSPACE_TURN_COMMANDS,
  WorkspaceOperationUnavailableError,
} from "./user-action"

/** A paired companion whose host publishes everything and granted everything. */
function companionSnapshot(overrides: { operations?: string[]; grants?: string[] } = {}) {
  return {
    target: { id: "mobile-companion", kind: "companion", platform: "mobile", hostKind: "desktop" },
    vaultState: "unlocked",
    connectionState: "online",
    host: {
      compatible: true,
      operations: overrides.operations ?? [
        "task_workspace_managed_delete",
        "host_admin_lease_issue",
      ],
      grants: overrides.grants ?? ["workspace.write", "host.admin"],
    },
  }
}

/** A native execution host (Tauri desktop, or the headless brain): no client target. */
const NATIVE_HOST_SNAPSHOT = {
  target: null,
  vaultState: "unlocked",
  connectionState: "online",
}

beforeEach(() => {
  jest.clearAllMocks()
  issueLeaseMock.mockResolvedValue({ token: "lease-token", operations: [], expiresAt: 0 })
  snapshotMock.mockReturnValue(companionSnapshot())
})

describe("runWorkspaceUserAction", () => {
  it("runs a native-host action without minting a lease", async () => {
    snapshotMock.mockReturnValue(NATIVE_HOST_SNAPSHOT)
    const op = jest.fn().mockResolvedValue("done")

    await expect(runWorkspaceUserAction("task_workspace_managed_delete", op)).resolves.toBe("done")

    expect(op).toHaveBeenCalledTimes(1)
    expect(issueLeaseMock).not.toHaveBeenCalled()
  })

  it("treats the headless brain as a native host, not as a client needing a lease", async () => {
    // `isTauri()` is false here, which is exactly why routing on it was wrong:
    // the headless brain would have gone looking for a host to approve itself.
    snapshotMock.mockReturnValue(NATIVE_HOST_SNAPSHOT)
    const op = jest.fn().mockResolvedValue("done")

    await runWorkspaceUserAction("task_workspace_managed_delete", op)

    expect(op).toHaveBeenCalledTimes(1)
    expect(issueLeaseMock).not.toHaveBeenCalled()
  })

  it("mints a 120s lease bound to the exact command on a companion", async () => {
    const op = jest.fn().mockResolvedValue("done")

    await runWorkspaceUserAction("task_workspace_managed_delete", op)

    expect(issueLeaseMock).toHaveBeenCalledWith(["task_workspace_managed_delete"], 120)
  })

  it("refuses before the call when the device cannot obtain host.admin", async () => {
    snapshotMock.mockReturnValue(companionSnapshot({ grants: ["workspace.write"] }))
    const op = jest.fn()

    await expect(
      runWorkspaceUserAction("task_workspace_managed_delete", op)
    ).rejects.toBeInstanceOf(WorkspaceOperationUnavailableError)

    // The point of refusing early: no round trip, and no lease request either.
    expect(op).not.toHaveBeenCalled()
    expect(issueLeaseMock).not.toHaveBeenCalled()
  })

  it("names the missing grant so the UI can say which one", async () => {
    snapshotMock.mockReturnValue(companionSnapshot({ grants: ["workspace.write"] }))

    const error = await runWorkspaceUserAction("task_workspace_managed_delete", jest.fn()).catch(
      (cause: unknown) => cause as WorkspaceOperationUnavailableError
    )

    expect(error.availability).toMatchObject({
      state: "requires-grant",
      requiredGrant: "host.admin",
    })
  })

  it("releases the lease when the operation throws, so it cannot be reused", async () => {
    const boom = new Error("host refused")
    await expect(
      runWorkspaceUserAction("task_workspace_managed_delete", () => Promise.reject(boom))
    ).rejects.toBe(boom)

    // A stranded lease would be picked up by the next call of the same name.
    expect(applyWorkspaceApproval("task_workspace_managed_delete", { a: 1 })).toEqual({ a: 1 })
  })
})

describe("approvalAwareTransport", () => {
  it("attaches the pending lease to the outbound call", async () => {
    callMock.mockResolvedValue(undefined)

    await runWorkspaceUserAction("task_workspace_managed_delete", () =>
      approvalAwareTransport.call("task_workspace_managed_delete", { workspaceId: "w1" })
    )

    expect(callMock).toHaveBeenCalledWith("task_workspace_managed_delete", {
      workspaceId: "w1",
      adminLease: "lease-token",
    })
  })

  it("passes a read through untouched", async () => {
    callMock.mockResolvedValue([])

    await approvalAwareTransport.call("task_workspace_environment_list", { rootDir: "/repo" })

    expect(callMock).toHaveBeenCalledWith("task_workspace_environment_list", { rootDir: "/repo" })
  })

  it("only spends the lease on the command it was minted for", async () => {
    callMock.mockResolvedValue(undefined)

    await runWorkspaceUserAction("task_workspace_managed_delete", async () => {
      await approvalAwareTransport.call("task_workspace_managed_archive", { workspaceId: "w1" })
    })

    expect(callMock).toHaveBeenCalledWith("task_workspace_managed_archive", { workspaceId: "w1" })
  })
})

describe("getWorkspaceOperationAvailability", () => {
  it("reports available when the host publishes the command and the grants are held", () => {
    expect(getWorkspaceOperationAvailability("task_workspace_managed_delete")).toEqual({
      state: "available",
      reason: "local-host",
    })
  })

  it("reports unsupported when the host does not publish the command", () => {
    snapshotMock.mockReturnValue(companionSnapshot({ operations: ["host_admin_lease_issue"] }))

    expect(getWorkspaceOperationAvailability("task_workspace_managed_delete").state).toBe(
      "unsupported"
    )
  })
})

describe("openWorkspaceApprovalScope", () => {
  /** The turn commands, plus the lease minter, all published and granted. */
  function turnCapableSnapshot() {
    return companionSnapshot({
      operations: [...WORKSPACE_TURN_COMMANDS, "host_admin_lease_issue"],
    })
  }

  beforeEach(() => {
    issueLeaseMock.mockResolvedValue({
      token: "turn-lease",
      operations: [...WORKSPACE_TURN_COMMANDS],
      expiresAt: Date.now() + 15 * 60 * 1000,
    })
  })

  // The defect: every task-workspace call a managed turn makes is
  // `approval: "interactive"`, and the send path wrapped none of them, so the
  // host refused with "a current device-bound approval lease is required".
  it("covers every call of the turn with one lease, not one lease per call", async () => {
    snapshotMock.mockReturnValue(turnCapableSnapshot())
    const scope = await openWorkspaceApprovalScope()

    await approvalAwareTransport.call("task_workspace_bundle_turn_begin", { bundleId: "b1" })
    await approvalAwareTransport.call("task_workspace_record_tool_event", { taskId: "t1" })
    await approvalAwareTransport.call("task_workspace_bundle_turn_settle", { turnId: "u1" })

    expect(issueLeaseMock).toHaveBeenCalledTimes(1)
    for (const [, args] of callMock.mock.calls) {
      expect(args).toMatchObject({ adminLease: "turn-lease" })
    }
    scope?.close()
  })

  it("stops covering anything once the turn settles", async () => {
    snapshotMock.mockReturnValue(turnCapableSnapshot())
    const scope = await openWorkspaceApprovalScope()
    scope?.close()

    await approvalAwareTransport.call("task_workspace_record_tool_event", { taskId: "t1" })

    expect(callMock).toHaveBeenCalledWith("task_workspace_record_tool_event", { taskId: "t1" })
  })

  it("re-mints rather than letting a long turn outlive its lease", async () => {
    snapshotMock.mockReturnValue(turnCapableSnapshot())
    issueLeaseMock.mockResolvedValueOnce({
      token: "about-to-expire",
      operations: [...WORKSPACE_TURN_COMMANDS],
      expiresAt: Date.now() + 1_000,
    })
    const scope = await openWorkspaceApprovalScope()

    await approvalAwareTransport.call("task_workspace_record_tool_event", { taskId: "t1" })

    expect(issueLeaseMock).toHaveBeenCalledTimes(2)
    expect(callMock).toHaveBeenCalledWith("task_workspace_record_tool_event", {
      taskId: "t1",
      adminLease: "turn-lease",
    })
    scope?.close()
  })

  it("approves nothing on a shell that IS the execution host", async () => {
    snapshotMock.mockReturnValue(NATIVE_HOST_SNAPSHOT)

    await expect(openWorkspaceApprovalScope()).resolves.toBeNull()
    expect(issueLeaseMock).not.toHaveBeenCalled()
  })

  it("names the missing grant instead of letting the host refuse the turn", async () => {
    snapshotMock.mockReturnValue(
      companionSnapshot({
        operations: [...WORKSPACE_TURN_COMMANDS, "host_admin_lease_issue"],
        grants: ["workspace.write"],
      })
    )

    await expect(openWorkspaceApprovalScope()).rejects.toThrow(WorkspaceOperationUnavailableError)
    expect(issueLeaseMock).not.toHaveBeenCalled()
  })

  it("lets a one-shot lease win over the standing scope", async () => {
    snapshotMock.mockReturnValue(turnCapableSnapshot())
    const scope = await openWorkspaceApprovalScope()
    issueLeaseMock.mockResolvedValueOnce({
      token: "one-shot",
      operations: ["task_workspace_record_tool_event"],
      expiresAt: Date.now() + 120_000,
    })

    await runWorkspaceUserAction("task_workspace_record_tool_event", () =>
      approvalAwareTransport.call("task_workspace_record_tool_event", { taskId: "t1" })
    )

    expect(callMock).toHaveBeenCalledWith("task_workspace_record_tool_event", {
      taskId: "t1",
      adminLease: "one-shot",
    })
    scope?.close()
  })
})
