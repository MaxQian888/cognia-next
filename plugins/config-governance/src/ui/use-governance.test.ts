/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

import { setActiveRuntime } from "../runtime/active"
import type { GovernanceRuntime, RuntimeStatus } from "../runtime/runtime"
import {
  useActiveRuntime,
  useGovernanceData,
  useRuntimeStatus,
  useWorkspaces,
} from "./use-governance"

function runtime(overrides: Record<string, unknown> = {}) {
  const listeners = new Set<() => void>()
  let status: RuntimeStatus = { revision: 0 }
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getStatus: () => status,
    bump: () => {
      status = { revision: status.revision + 1 }
      for (const listener of listeners) listener()
    },
    workspaces: jest.fn(async () => [{ id: "w", name: "Repo", roots: [] }]),
    defaultWorkspace: jest.fn(async () => "w"),
    findings: jest.fn(async () => []),
    modelChangedSince: jest.fn(async () => "old"),
    store: {
      latestRun: jest.fn(async () => undefined),
      keptFindings: jest.fn(async () => new Set(["k"])),
      checks: jest.fn(async () => ({
        derivedAt: 0,
        checks: [{ id: "C" }],
        notCheckable: 0,
        rejected: 0,
      })),
      adherence: jest.fn(async () => ({ ranAt: 0, sessions: 0, results: [{ checkId: "C" }] })),
      rules: jest.fn(async () => []),
      appliedChanges: jest.fn(async () => [
        { id: "a", workspaceId: "w" },
        { id: "b", workspaceId: "other" },
      ]),
      evalRecords: jest.fn(async () => [{ id: "e", workspaceId: null }]),
      history: jest.fn(async () => []),
      falseMatches: jest.fn(async () => new Set()),
    },
    ...overrides,
  } as unknown as GovernanceRuntime & { bump(): void; store: Record<string, jest.Mock> }
}

afterEach(() => act(() => setActiveRuntime(null)))

describe("use-governance", () => {
  it("follows the active runtime and its status", () => {
    const rt = runtime()
    const active = renderHook(() => useActiveRuntime())
    expect(active.result.current).toBeNull()
    act(() => setActiveRuntime(rt))
    expect(active.result.current).toBe(rt)
    const status = renderHook(() => useRuntimeStatus(rt))
    act(() => rt.bump())
    expect(status.result.current.revision).toBe(1)
    expect(renderHook(() => useRuntimeStatus(null)).result.current).toEqual({ revision: 0 })
  })

  it("loads one workspace's data and reloads on a new revision", async () => {
    const rt = runtime()
    const { result, rerender } = renderHook(
      ({ revision }) => useGovernanceData(rt, "w", revision),
      { initialProps: { revision: 0 } }
    )
    await waitFor(() => expect(result.current.status).toBe("ready"))
    if (result.current.status !== "ready") throw new Error("not ready")
    expect(result.current.data.applied.map((change) => change.id)).toEqual(["a"])
    expect(result.current.data.evals).toEqual([])
    expect(result.current.data.results.get("C")).toEqual({ checkId: "C" })
    expect(result.current.data.checksById.has("C")).toBe(true)
    expect(result.current.data.modelChangedFrom).toBe("old")
    rerender({ revision: 1 })
    await waitFor(() => expect(rt.store.latestRun).toHaveBeenCalledTimes(2))
  })

  it("reports a load failure and waits for a workspace", async () => {
    const rt = runtime({
      findings: jest.fn(async () => {
        throw new Error("broken")
      }),
    })
    const { result } = renderHook(() => useGovernanceData(rt, null, 0))
    await waitFor(() => expect(result.current).toEqual({ status: "error", message: "broken" }))
    const waiting = renderHook(() => useGovernanceData(rt, undefined, 0))
    expect(waiting.result.current.status).toBe("loading")
  })

  it("lists workspaces and picks the preferred one if it still exists", async () => {
    const { result } = renderHook(() => useWorkspaces(runtime()))
    await waitFor(() => expect(result.current.initial).toBe("w"))
    expect(result.current.workspaces).toHaveLength(1)
    const gone = renderHook(() =>
      useWorkspaces(runtime({ defaultWorkspace: jest.fn(async () => "deleted") }))
    )
    await waitFor(() => expect(gone.result.current.initial).toBeNull())
    const failing = renderHook(() =>
      useWorkspaces(
        runtime({
          workspaces: jest.fn(async () => {
            throw new Error("x")
          }),
        })
      )
    )
    await waitFor(() => expect(failing.result.current.initial).toBeNull())
  })
})
