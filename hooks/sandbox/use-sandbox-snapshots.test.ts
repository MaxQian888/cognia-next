/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"
import { useSandboxSnapshots } from "./use-sandbox-snapshots"
import {
  sandboxSnapshotCreate,
  sandboxSnapshotFork,
  sandboxSnapshotList,
  sandboxSnapshotRestore,
} from "@/lib/sandbox/snapshots"

jest.mock("@/lib/sandbox/snapshots", () => ({
  sandboxSnapshotCreate: jest.fn(),
  sandboxSnapshotDelete: jest.fn(),
  sandboxSnapshotFork: jest.fn(),
  sandboxSnapshotList: jest.fn(),
  sandboxSnapshotPin: jest.fn(),
  sandboxSnapshotRestore: jest.fn(),
}))
beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(sandboxSnapshotList).mockResolvedValue([])
})

it.each([
  ["snapshot_busy", "busy"],
  ["snapshot_budget_exceeded", "budget"],
] as const)("shows %s without rendering raw error text", async (code, expected) => {
  jest.mocked(sandboxSnapshotCreate).mockRejectedValue(new Error(code))
  const { result } = renderHook(() => useSandboxSnapshots("p"))
  await waitFor(() => expect(result.current.loading).toBe(false))
  await act(() =>
    result.current.create({
      workspaceId: "w",
      provider: "local",
      containerId: "c",
      exclusions: ["ignored/private"],
    })
  )
  expect(result.current.error).toBe(expected)
  expect(result.current.busy).toBe(false)
  expect(sandboxSnapshotCreate).toHaveBeenCalledWith({
    projectId: "p",
    workspaceId: "w",
    provider: "local",
    containerId: "c",
    exclusions: ["ignored/private"],
  })
})

it("gives forks fresh identities and passes the explicit restore target to the Host", async () => {
  const fork = { workspace: { executionRoot: "/fork" }, restoredInPlace: false }
  jest.mocked(sandboxSnapshotFork).mockResolvedValue(fork as never)
  jest.mocked(sandboxSnapshotRestore).mockResolvedValue({ ...fork, restoredInPlace: true } as never)
  const { result } = renderHook(() => useSandboxSnapshots("p"))
  await waitFor(() => expect(result.current.loading).toBe(false))
  await act(() => result.current.fork("snapshot"))
  await act(() => result.current.restore("snapshot", "archived"))
  const first = jest.mocked(sandboxSnapshotFork).mock.calls[0][0]
  const second = jest.mocked(sandboxSnapshotRestore).mock.calls[0][0]
  expect(first.taskId).not.toBe(second.taskId)
  expect(second.workspaceId).toBe("archived")
  expect(result.current.forked?.restoredInPlace).toBe(true)
})
