const beginBundleTurn = jest.fn()
const settleBundleTurn = jest.fn()
const abortBundleTurn = jest.fn()
const getBundleTurn = jest.fn()

jest.mock("./client", () => ({
  beginWorkspaceBundleTurn: (...args: unknown[]) => beginBundleTurn(...args),
  settleWorkspaceBundleTurn: (...args: unknown[]) => settleBundleTurn(...args),
  abortWorkspaceBundleTurn: (...args: unknown[]) => abortBundleTurn(...args),
  getWorkspaceBundleTurn: (...args: unknown[]) => getBundleTurn(...args),
  isWorkspaceBusyRefusal: (error: unknown) =>
    /pipeline workspace is already active/i.test(
      error instanceof Error ? error.message : String(error)
    ),
}))

// Only the minting is stubbed. The bind/close registry stays real, because the
// fact under test is that the scope is reachable by turn id from a settle path
// that never held the lease object.
const openScope = jest.fn()
jest.mock("./user-action", () => {
  const actual = jest.requireActual("./user-action")
  return { ...actual, openWorkspaceApprovalScope: () => openScope() }
})

const releaseTurn = jest.fn()
const abortIfUndriven = jest.fn()
jest.mock("./abandoned-turns", () => ({
  releaseOpenBundleTurn: (...args: unknown[]) => releaseTurn(...args),
  abortBundleTurnIfUndriven: (...args: unknown[]) => abortIfUndriven(...args),
}))

import { boundApprovalScopeTurnIds, closeApprovalScopeForTurn } from "./user-action"
import { createHash } from "node:crypto"
import { __setReconcileReadWaitForTests, openWorkspaceBundleTurnLease } from "./run-lease"

describe("openWorkspaceBundleTurnLease", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    beginBundleTurn.mockResolvedValue(null)
    settleBundleTurn.mockResolvedValue({ resources: [] })
    abortBundleTurn.mockResolvedValue({ resources: [] })
    // A native host approves itself, which is what every other test here wants.
    openScope.mockResolvedValue(null)
  })

  afterEach(() => {
    for (const turnId of boundApprovalScopeTurnIds()) closeApprovalScopeForTurn(turnId)
  })

  it("leases every physical workspace in a bundle and preserves its logical aliases", async () => {
    beginBundleTurn.mockResolvedValue({
      bundleTurnId: "bundle-turn-1",
      bundleId: "bundle-1",
      primaryLogicalRootId: "app",
      primaryAlias: "/aliases/app",
      additionalAliases: ["/aliases/app-tests", "/aliases/docs"],
      runs: [
        {
          workspaceId: "workspace-app",
          logicalRootIds: ["app", "app-tests"],
          run: { runId: "turn-1", executionRoot: "/physical/app" },
        },
        {
          workspaceId: "workspace-docs",
          logicalRootIds: ["docs"],
          run: { runId: "turn-1:docs", executionRoot: "/physical/docs" },
        },
      ],
    })
    settleBundleTurn.mockResolvedValue({
      resources: [
        { runId: "turn-1", path: "src/a.ts" },
        { runId: "turn-1:docs", path: "guide.md" },
      ],
    })
    const input = {
      taskId: "task-1",
      sessionId: "session-1",
      runId: "turn-1",
      agentId: "built-in",
      agentKind: "in-app",
      workspaceRoot: "/aliases/app",
    }

    const lease = await openWorkspaceBundleTurnLease(
      {
        bundleId: "bundle-1",
        leases: [
          {
            bundleId: "bundle-1",
            workspaceId: "workspace-app",
            logicalRootId: "app",
            role: "primary",
            aliasPath: "/aliases/app",
          },
          {
            bundleId: "bundle-1",
            workspaceId: "workspace-app",
            logicalRootId: "app-tests",
            role: "additional",
            aliasPath: "/aliases/app-tests",
          },
          {
            bundleId: "bundle-1",
            workspaceId: "workspace-docs",
            logicalRootId: "docs",
            role: "additional",
            aliasPath: "/aliases/docs",
          },
        ],
      },
      "app",
      input
    )

    expect(beginBundleTurn).toHaveBeenCalledTimes(1)
    expect(beginBundleTurn).toHaveBeenCalledWith("bundle-1", {
      primaryLogicalRootId: "app",
      run: input,
    })
    expect(lease).toMatchObject({
      bundleId: "bundle-1",
      primaryAlias: "/aliases/app",
      additionalAliases: ["/aliases/app-tests", "/aliases/docs"],
    })
    expect(lease?.runs).toHaveLength(2)

    await lease?.settle("ready")
    expect(settleBundleTurn).toHaveBeenCalledWith("bundle-turn-1", "ready")
  })

  it("fails closed when the host cannot open the complete persisted bundle turn", async () => {
    beginBundleTurn.mockResolvedValueOnce(null)

    const lease = await openWorkspaceBundleTurnLease(
      {
        bundleId: "bundle-1",
        leases: [
          {
            bundleId: "bundle-1",
            workspaceId: "workspace-app",
            logicalRootId: "app",
            role: "primary",
            aliasPath: "/aliases/app",
          },
          {
            bundleId: "bundle-1",
            workspaceId: "workspace-docs",
            logicalRootId: "docs",
            role: "additional",
            aliasPath: "/aliases/docs",
          },
        ],
      },
      "app",
      {
        taskId: "task-1",
        sessionId: "session-1",
        runId: "turn-1",
        agentId: "built-in",
        agentKind: "in-app",
        workspaceRoot: "/aliases/app",
      }
    )

    expect(lease).toBeNull()
    expect(settleBundleTurn).not.toHaveBeenCalled()
  })

  it("aborts the complete persisted bundle turn", async () => {
    beginBundleTurn.mockResolvedValueOnce({
      bundleTurnId: "bundle-turn-1",
      bundleId: "bundle-1",
      primaryLogicalRootId: "app",
      primaryAlias: "/aliases/app",
      additionalAliases: [],
      runs: [
        {
          workspaceId: "workspace-app",
          logicalRootIds: ["app"],
          run: { runId: "turn-1", executionRoot: "/physical/app" },
        },
      ],
    })

    const lease = await openWorkspaceBundleTurnLease({ bundleId: "bundle-1", leases: [] }, "app", {
      taskId: "task-1",
      sessionId: "session-1",
      runId: "turn-1",
      agentId: "built-in",
      agentKind: "in-app",
      workspaceRoot: "/aliases/app",
    })

    await lease?.abort()
    expect(abortBundleTurn).toHaveBeenCalledWith("bundle-turn-1")
  })
})

/**
 * The chat controller takes the alias and run id off the lease and drops the
 * handle: a chat turn settles from the status edge, nowhere near the send call.
 * So `settle`/`abort` — the only closures that closed the scope — were never
 * called, and every managed chat turn on a companion left a 15-minute step-up
 * token covering every workspace write command.
 */
describe("the turn's approval scope", () => {
  const bundle = { bundleId: "bundle-1", leases: [] }
  const input = {
    taskId: "task-1",
    sessionId: "session-1",
    runId: "turn-1",
    agentId: "built-in",
    agentKind: "in-app",
    workspaceRoot: "/aliases/app",
  }

  function openedTurn() {
    return {
      bundleTurnId: "bundle-turn-1",
      bundleId: "bundle-1",
      primaryLogicalRootId: "app",
      primaryAlias: "/aliases/app",
      additionalAliases: [],
      runs: [
        {
          workspaceId: "workspace-app",
          logicalRootIds: ["app"],
          run: { runId: "turn-1", executionRoot: "/physical/app" },
        },
      ],
    }
  }

  let close: jest.Mock

  beforeEach(() => {
    close = jest.fn()
    openScope.mockResolvedValue({ close })
  })

  afterEach(() => {
    closeApprovalScopeForTurn("bundle-turn-1")
  })

  it("is reachable by turn id, so any settle path can close it", async () => {
    beginBundleTurn.mockResolvedValue(openedTurn())

    await openWorkspaceBundleTurnLease(bundle, "app", input)

    expect(boundApprovalScopeTurnIds()).toEqual(["bundle-turn-1"])
    expect(close).not.toHaveBeenCalled()
  })

  it("is closed once, by whichever path ends the turn first", async () => {
    beginBundleTurn.mockResolvedValue(openedTurn())
    const lease = await openWorkspaceBundleTurnLease(bundle, "app", input)

    // The connector path still settles through the lease it holds.
    await lease?.settle("ready")

    expect(close).toHaveBeenCalledTimes(1)
    expect(boundApprovalScopeTurnIds()).toEqual([])
  })

  it("does not outlive a turn the host opened without the primary root", async () => {
    beginBundleTurn.mockResolvedValue({ ...openedTurn(), runs: [] })

    await expect(openWorkspaceBundleTurnLease(bundle, "app", input)).resolves.toBeNull()

    expect(abortBundleTurn).toHaveBeenCalledWith("bundle-turn-1")
    expect(close).toHaveBeenCalledTimes(1)
    expect(boundApprovalScopeTurnIds()).toEqual([])
  })

  it("closes the scope when the turn is aborted rather than settled", async () => {
    beginBundleTurn.mockResolvedValue(openedTurn())
    const lease = await openWorkspaceBundleTurnLease(bundle, "app", input)

    await lease?.abort()

    expect(close).toHaveBeenCalledTimes(1)
  })
})

/**
 * These callers settle through the lease, not through `settleTaskWorkspaceTurn`,
 * so a failure here never reaches `forgetOpenBundleTurn`: the scheduler, the
 * connector AI loop, agent execution and the team registry controller all kept
 * claiming a turn they could no longer end, and the conversation was refused
 * for good.
 */
describe("a lease settle that does not land", () => {
  const bundle = { bundleId: "bundle-1", leases: [] }
  const input = {
    taskId: "task-1",
    sessionId: "session-1",
    runId: "turn-1",
    agentId: "built-in",
    agentKind: "in-app",
    workspaceRoot: "/aliases/app",
  }

  beforeEach(() => {
    // Per-describe: these mocks are module-level and a `mockRejectedValue` set
    // by one test otherwise leaks into the next.
    jest.clearAllMocks()
    releaseTurn.mockReset()
    openScope.mockResolvedValue(null)
    settleBundleTurn.mockResolvedValue({ resources: [] })
    abortBundleTurn.mockResolvedValue({ resources: [] })
    beginBundleTurn.mockResolvedValue({
      bundleTurnId: "bundle-turn-1",
      bundleId: "bundle-1",
      primaryLogicalRootId: "app",
      primaryAlias: "/aliases/app",
      additionalAliases: [],
      runs: [
        {
          workspaceId: "workspace-app",
          logicalRootIds: ["app"],
          run: { runId: "turn-1", executionRoot: "/physical/app" },
        },
      ],
    })
  })

  afterEach(() => {
    for (const turnId of boundApprovalScopeTurnIds()) closeApprovalScopeForTurn(turnId)
  })

  it("hands the turn to the reclaim path and still reports the failure", async () => {
    settleBundleTurn.mockRejectedValue(new Error("host unreachable"))
    const lease = await openWorkspaceBundleTurnLease(bundle, "app", input)

    await expect(lease?.settle("ready")).rejects.toThrow("host unreachable")

    expect(releaseTurn).toHaveBeenCalledWith("bundle-turn-1")
  })

  it("does the same for an abort that cannot land", async () => {
    abortBundleTurn.mockRejectedValue(new Error("host unreachable"))
    const lease = await openWorkspaceBundleTurnLease(bundle, "app", input)

    await expect(lease?.abort()).rejects.toThrow("host unreachable")

    expect(releaseTurn).toHaveBeenCalledWith("bundle-turn-1")
  })

  // A turn that ended cleanly is forgotten by `settleWorkspaceBundleTurn`, not
  // released: releasing it would leave a record for a later send to re-poll.
  it("releases nothing when the settle lands", async () => {
    const lease = await openWorkspaceBundleTurnLease(bundle, "app", input)

    await lease?.settle("ready")

    expect(releaseTurn).not.toHaveBeenCalled()
  })
})

describe("a begin whose answer was lost", () => {
  const bundle = { bundleId: "bundle-1", leases: [] }
  const input = {
    taskId: "task:connector:s1",
    sessionId: "session-1",
    runId: "run:connector:s1:t1",
    executionRunId: "run:connector:s1:t1",
    turnId: "connector-turn-1",
    attemptId: "a1",
    agentId: "lark",
    agentKind: "connector",
    workspaceRoot: "/aliases/app",
  }
  const suffix = (workspaceId: string) =>
    createHash("sha256").update(workspaceId).digest("hex").slice(0, 12)

  /** A turn as the host stores it for `request`, scoped per workspace. */
  function hostTurn(
    request: { taskId: string; runId: string } = input,
    over: Record<string, unknown> = {}
  ) {
    return {
      bundleTurnId: "connector-turn-1",
      bundleId: "bundle-1",
      primaryLogicalRootId: "app",
      settledAt: null,
      runs: ["workspace-app", "workspace-docs"].map((workspaceId) => ({
        workspaceId,
        logicalRootIds: [workspaceId],
        run: {
          taskId: `${request.taskId}:${suffix(workspaceId)}`,
          runId: `${request.runId}:${suffix(workspaceId)}`,
          turnId: "connector-turn-1",
          agentId: "lark",
          agentKind: "connector",
          executionRunId: "run:connector:s1:t1",
          attemptId: "a1",
        },
      })),
      ...over,
    }
  }

  let close: jest.Mock
  let restoreWait: () => void

  beforeEach(() => {
    jest.clearAllMocks()
    close = jest.fn()
    openScope.mockResolvedValue({ close })
    abortIfUndriven.mockResolvedValue(true)
    beginBundleTurn.mockRejectedValue(new Error("companion request dropped"))
    restoreWait = __setReconcileReadWaitForTests(async () => undefined)
  })

  afterEach(() => restoreWait())

  it("aborts this request's committed turn, before closing the approval scope", async () => {
    getBundleTurn.mockResolvedValue(hostTurn())
    abortIfUndriven.mockImplementation(async () => {
      expect(close).not.toHaveBeenCalled()
      return true
    })

    await expect(openWorkspaceBundleTurnLease(bundle, "app", input)).rejects.toThrow(
      "companion request dropped"
    )

    expect(getBundleTurn).toHaveBeenCalledWith("connector-turn-1")
    expect(abortIfUndriven).toHaveBeenCalledWith("connector-turn-1")
    expect(close).toHaveBeenCalledTimes(1)
  })

  // The reported repro: the id is held by a different task/run's live turn.
  it("never aborts a turn that holds the same id for another task or run", async () => {
    getBundleTurn.mockResolvedValue(
      hostTurn({ taskId: "task:connector:other", runId: "run:connector:other:t1" })
    )

    await expect(openWorkspaceBundleTurnLease(bundle, "app", input)).rejects.toThrow()

    expect(abortIfUndriven).not.toHaveBeenCalled()
  })

  it("does not even look when the host refused on identity", async () => {
    beginBundleTurn.mockRejectedValueOnce(
      new Error("bundleTurnId is already owned by another workspace bundle: connector-turn-1")
    )
    getBundleTurn.mockResolvedValue(hostTurn())

    await expect(openWorkspaceBundleTurnLease(bundle, "app", input)).rejects.toThrow()

    expect(getBundleTurn).not.toHaveBeenCalled()
    expect(abortIfUndriven).not.toHaveBeenCalled()
  })

  it.each([
    ["missing", null],
    ["settled", hostTurn(input, { settledAt: 5 })],
    ["on another bundle", hostTurn(input, { bundleId: "bundle-2" })],
    ["on another primary root", hostTurn(input, { primaryLogicalRootId: "docs" })],
  ])("leaves a turn alone when it is %s", async (_label, found) => {
    getBundleTurn.mockResolvedValue(found)
    await expect(openWorkspaceBundleTurnLease(bundle, "app", input)).rejects.toThrow()
    expect(abortIfUndriven).not.toHaveBeenCalled()
  })

  it("leaves a turn alone when another attempt or agent owns it", async () => {
    const other = hostTurn()
    other.runs[1].run.attemptId = "a2"
    getBundleTurn.mockResolvedValue(other)
    await expect(openWorkspaceBundleTurnLease(bundle, "app", input)).rejects.toThrow()
    expect(abortIfUndriven).not.toHaveBeenCalled()
  })

  it("retries the read-back, then gives up without aborting anything", async () => {
    getBundleTurn.mockRejectedValue(new Error("host unreachable"))

    await expect(openWorkspaceBundleTurnLease(bundle, "app", input)).rejects.toThrow(
      "companion request dropped"
    )

    expect(getBundleTurn).toHaveBeenCalledTimes(3)
    expect(abortIfUndriven).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("still reports the begin failure when the cleanup itself fails", async () => {
    getBundleTurn.mockResolvedValue(hostTurn())
    abortIfUndriven.mockRejectedValue(new Error("abort refused"))

    await expect(openWorkspaceBundleTurnLease(bundle, "app", input)).rejects.toThrow(
      "companion request dropped"
    )
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("does not reconcile a busy refusal or a begin without a caller turn id", async () => {
    beginBundleTurn.mockRejectedValueOnce(new Error("pipeline workspace is already active"))
    await expect(openWorkspaceBundleTurnLease(bundle, "app", input)).rejects.toThrow()
    const { turnId: _omitted, ...withoutTurnId } = input
    await expect(openWorkspaceBundleTurnLease(bundle, "app", withoutTurnId)).rejects.toThrow()

    expect(getBundleTurn).not.toHaveBeenCalled()
  })
})
