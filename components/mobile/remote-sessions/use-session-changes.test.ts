/** @jest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react"

import { useSessionChanges } from "./use-session-changes"
import type { PatchSet, TaskRun, TaskWorkspace } from "@/lib/task-workspace/types"

const listTaskWorkspaces = jest.fn()
const listTaskRuns = jest.fn()
const getTaskPatchSet = jest.fn()
const readTaskResourceDiff = jest.fn()

jest.mock("@/lib/task-workspace/client", () => ({
  listTaskWorkspaces: (...args: unknown[]) => listTaskWorkspaces(...args),
  listTaskRuns: (...args: unknown[]) => listTaskRuns(...args),
  getTaskPatchSet: (...args: unknown[]) => getTaskPatchSet(...args),
  readTaskResourceDiff: (...args: unknown[]) => readTaskResourceDiff(...args),
}))

function workspace(taskId: string): TaskWorkspace {
  return {
    taskId,
    sessionId: "s1",
    workspaceRoot: "/w",
    state: "ready",
    revision: 1,
    createdAt: 1,
    expiresAt: 2,
    pinned: false,
  }
}

function taskRun(runId: string, createdAt: number, state: TaskRun["state"] = "ready"): TaskRun {
  return {
    runId,
    taskId: "task:1",
    parentRunId: null,
    agentId: "a",
    agentKind: "claude",
    executionRoot: "/w",
    isolationKind: "shadow",
    isolationRef: null,
    workspaceId: null,
    base: { kind: "workingState" },
    workspaceKey: null,
    executionRunId: null,
    traceId: null,
    turnId: null,
    attemptId: null,
    providerAttemptId: null,
    surface: null,
    trackingPolicy: { generatedOutputRoots: [], autoDetect: true },
    baselineRevision: 0,
    state,
    createdAt,
    settledAt: null,
  }
}

function patchSet(runId: string, paths: Array<{ path: string; hunks: number }>): PatchSet {
  return {
    patchId: `patch:${runId}`,
    taskId: "task:1",
    runId,
    state: "ready",
    baseRevision: 0,
    appliedRevision: null,
    reversible: true,
    createdAt: 5,
    files: paths.map(({ path, hunks }) => ({
      path,
      oldPath: null,
      kind: "modified" as const,
      resourceKind: "file" as const,
      beforeHash: "b",
      afterHash: "a",
      beforeMode: null,
      afterMode: null,
      binary: false,
      hunks: Array.from({ length: hunks }, (_, index) => ({
        id: `hunk:${index}`,
        header: "@@ -1 +1 @@",
        forwardPatchHash: "f",
        inversePatchHash: "i",
        additions: 1,
        deletions: 0,
      })),
    })),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  listTaskWorkspaces.mockResolvedValue([workspace("task:1")])
  listTaskRuns.mockResolvedValue([taskRun("run:1", 10)])
  getTaskPatchSet.mockResolvedValue(patchSet("run:1", [{ path: "src/a.ts", hunks: 1 }]))
  readTaskResourceDiff.mockResolvedValue("@@ -1 +1 @@\n-a\n+b\n")
})

describe("useSessionChanges", () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it("reports untracked when the host kept no workspace for the session", async () => {
    listTaskWorkspaces.mockResolvedValue([])
    const { result } = renderHook(() => useSessionChanges("s1"))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.untracked).toBe(true)
    expect(result.current.runs).toEqual([])
    expect(getTaskPatchSet).not.toHaveBeenCalled()
  })

  it("merges runs across every workspace of the session, newest first", async () => {
    listTaskWorkspaces.mockResolvedValue([workspace("task:1"), workspace("task:2")])
    listTaskRuns.mockImplementation(async (taskId: string) =>
      taskId === "task:1" ? [taskRun("run:old", 10)] : [taskRun("run:new", 99)]
    )
    const { result } = renderHook(() => useSessionChanges("s1"))
    await waitFor(() => expect(result.current.runs).toHaveLength(2))
    expect(result.current.runs.map((run) => run.runId)).toEqual(["run:new", "run:old"])
    // Newest is selected, so the default view is the latest turn.
    expect(result.current.selectedRunId).toBe("run:new")
  })

  it("projects the selected run's patch set", async () => {
    const { result } = renderHook(() => useSessionChanges("s1"))
    await waitFor(() => expect(result.current.changes).toBeDefined())
    expect(result.current.changes?.files).toEqual([
      expect.objectContaining({ path: "src/a.ts", availability: "available" }),
    ])
    expect(result.current.untracked).toBe(false)
  })

  it("leaves changes undefined when a run settled without a patch set", async () => {
    // A run that touched nothing has no patch row at all. "No changes" and
    // "not tracked" must stay distinguishable for the surface.
    getTaskPatchSet.mockResolvedValue(null)
    const { result } = renderHook(() => useSessionChanges("s1"))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.changes).toBeUndefined()
    expect(result.current.untracked).toBe(false)
  })

  it("switches the patch set when another run is selected", async () => {
    listTaskRuns.mockResolvedValue([taskRun("run:1", 10), taskRun("run:2", 20)])
    getTaskPatchSet.mockImplementation(async (runId: string) =>
      patchSet(runId, [{ path: `${runId}.ts`, hunks: 1 }])
    )
    const { result } = renderHook(() => useSessionChanges("s1"))
    await waitFor(() => expect(result.current.changes?.runId).toBe("run:2"))
    act(() => result.current.selectRun("run:1"))
    await waitFor(() => expect(result.current.changes?.runId).toBe("run:1"))
    expect(result.current.changes?.files[0].path).toBe("run:1.ts")
  })

  it("discards an in-flight diff after another run is selected", async () => {
    listTaskRuns.mockResolvedValue([taskRun("run:old", 20), taskRun("run:new", 10)])
    getTaskPatchSet.mockImplementation(async (runId: string) =>
      patchSet(runId, [{ path: "src/a.ts", hunks: 1 }])
    )
    let resolveOldDiff!: (value: string) => void
    readTaskResourceDiff.mockImplementation(
      async (runId: string) =>
        runId === "run:old"
          ? new Promise<string>((resolve) => {
              resolveOldDiff = resolve
            })
          : "new run diff"
    )

    const { result } = renderHook(() => useSessionChanges("s1"))
    await waitFor(() => expect(result.current.changes?.runId).toBe("run:old"))
    act(() => result.current.loadDiff("src/a.ts"))
    await waitFor(() => expect(result.current.diffs["src/a.ts"]?.status).toBe("loading"))

    act(() => result.current.selectRun("run:new"))
    await waitFor(() => expect(result.current.changes?.runId).toBe("run:new"))
    await act(async () => resolveOldDiff("old run diff"))

    expect(result.current.diffs["src/a.ts"]).toBeUndefined()
  })

  it("loads a file body on demand and never before", async () => {
    const { result } = renderHook(() => useSessionChanges("s1"))
    await waitFor(() => expect(result.current.changes).toBeDefined())
    expect(readTaskResourceDiff).not.toHaveBeenCalled()

    act(() => result.current.loadDiff("src/a.ts"))
    await waitFor(() =>
      expect(result.current.diffs["src/a.ts"]).toEqual({
        status: "loaded",
        text: "@@ -1 +1 @@\n-a\n+b\n",
      })
    )
    expect(readTaskResourceDiff).toHaveBeenCalledWith("run:1", "src/a.ts", false)
  })

  it("never requests a sensitive path, even though the ledger stored hunks for it", async () => {
    getTaskPatchSet.mockResolvedValue(patchSet("run:1", [{ path: "app/.env", hunks: 2 }]))
    const { result } = renderHook(() => useSessionChanges("s1"))
    await waitFor(() => expect(result.current.changes).toBeDefined())
    expect(result.current.changes?.files[0].availability).toBe("sensitive")

    act(() => result.current.loadDiff("app/.env"))
    expect(readTaskResourceDiff).not.toHaveBeenCalled()
    expect(result.current.diffs["app/.env"]).toBeUndefined()
  })

  it("never requests a file the ledger stored no hunks for", async () => {
    getTaskPatchSet.mockResolvedValue(patchSet("run:1", [{ path: "src/new.ts", hunks: 0 }]))
    const { result } = renderHook(() => useSessionChanges("s1"))
    await waitFor(() => expect(result.current.changes).toBeDefined())
    act(() => result.current.loadDiff("src/new.ts"))
    expect(readTaskResourceDiff).not.toHaveBeenCalled()
  })

  it("distinguishes an empty body from a loaded one", async () => {
    // The host answers "" rather than an error when it has no stored hunks.
    // Rendering that as a diff would read as "this file is unchanged".
    readTaskResourceDiff.mockResolvedValue("   \n")
    const { result } = renderHook(() => useSessionChanges("s1"))
    await waitFor(() => expect(result.current.changes).toBeDefined())
    act(() => result.current.loadDiff("src/a.ts"))
    await waitFor(() => expect(result.current.diffs["src/a.ts"]).toEqual({ status: "empty" }))
  })

  it("surfaces a body failure against the file that failed", async () => {
    readTaskResourceDiff.mockRejectedValue(new Error("forbidden"))
    const { result } = renderHook(() => useSessionChanges("s1"))
    await waitFor(() => expect(result.current.changes).toBeDefined())
    act(() => result.current.loadDiff("src/a.ts"))
    await waitFor(() =>
      expect(result.current.diffs["src/a.ts"]).toEqual({ status: "error", message: "forbidden" })
    )
  })

  it("does not re-request a body it already holds", async () => {
    const { result } = renderHook(() => useSessionChanges("s1"))
    await waitFor(() => expect(result.current.changes).toBeDefined())
    act(() => result.current.loadDiff("src/a.ts"))
    await waitFor(() => expect(result.current.diffs["src/a.ts"]?.status).toBe("loaded"))
    act(() => result.current.loadDiff("src/a.ts"))
    expect(readTaskResourceDiff).toHaveBeenCalledTimes(1)
  })

  it("allows a retry after a failed body, unlike a successful one", async () => {
    readTaskResourceDiff.mockRejectedValueOnce(new Error("timeout"))
    const { result } = renderHook(() => useSessionChanges("s1"))
    await waitFor(() => expect(result.current.changes).toBeDefined())
    act(() => result.current.loadDiff("src/a.ts"))
    await waitFor(() => expect(result.current.diffs["src/a.ts"]?.status).toBe("error"))
    act(() => result.current.loadDiff("src/a.ts"))
    await waitFor(() => expect(result.current.diffs["src/a.ts"]?.status).toBe("loaded"))
    expect(readTaskResourceDiff).toHaveBeenCalledTimes(2)
  })

  it("surfaces a listing failure instead of reporting an untracked session", async () => {
    listTaskWorkspaces.mockRejectedValue(new Error("not paired"))
    const { result } = renderHook(() => useSessionChanges("s1"))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe("not paired")
    expect(result.current.untracked).toBe(false)
  })

  it("keeps the still-running state of a run so the surface can say so", async () => {
    listTaskRuns.mockResolvedValue([taskRun("run:1", 10, "running")])
    getTaskPatchSet.mockResolvedValue(null)
    const { result } = renderHook(() => useSessionChanges("s1"))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.runs[0].state).toBe("running")
    expect(result.current.changes).toBeUndefined()
  })

  it("refreshes the selected patch after a running task settles", async () => {
    jest.useFakeTimers()
    listTaskRuns
      .mockResolvedValueOnce([taskRun("run:1", 10, "running")])
      .mockResolvedValueOnce([taskRun("run:1", 10, "ready")])
    getTaskPatchSet
      .mockResolvedValueOnce(null)
      .mockResolvedValue(patchSet("run:1", [{ path: "src/settled.ts", hunks: 1 }]))

    const { result } = renderHook(() => useSessionChanges("s1"))
    await waitFor(() => expect(result.current.runs[0]?.state).toBe("running"))
    expect(result.current.changes).toBeUndefined()

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_500)
    })

    await waitFor(() => expect(result.current.runs[0]?.state).toBe("ready"))
    await waitFor(() => expect(result.current.changes?.runId).toBe("run:1"))
    expect(result.current.changes?.files[0].path).toBe("src/settled.ts")
  })
})
