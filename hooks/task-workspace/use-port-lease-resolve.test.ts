/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"
import { usePortLeaseResolve } from "./use-port-lease-resolve"
import { hasHostRuntime } from "@/lib/platform/capabilities"
import {
  ensureWorkspacePortLease,
  ensureSubjectPortLease,
  resolveWorkspacePortLease,
  resolveWorkspacePortLeaseEnsure,
} from "@/lib/task-workspace/client"
import type { WorkspacePortLease } from "@/lib/task-workspace/types"

jest.mock("@/lib/platform/capabilities", () => ({ hasHostRuntime: jest.fn() }))
jest.mock("@/lib/task-workspace/client", () => ({
  resolveWorkspacePortLease: jest.fn(),
  ensureWorkspacePortLease: jest.fn(),
  ensureSubjectPortLease: jest.fn(),
  resolveWorkspacePortLeaseEnsure: jest.fn(),
}))

const lease: WorkspacePortLease = {
  leaseId: "lease-1",
  namespaceKey: "host-loopback",
  subjectKind: "project-root",
  subjectKey: "root:/repo",
  canonicalRoot: "/repo",
  registryWorkspaceId: null,
  basePort: 41000,
  portCount: 10,
  createdAt: 1,
  updatedAt: 1,
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(hasHostRuntime).mockReturnValue(true)
  jest.mocked(resolveWorkspacePortLease).mockResolvedValue(null)
})

afterEach(() => {
  expect(ensureWorkspacePortLease).not.toHaveBeenCalled()
  expect(ensureSubjectPortLease).not.toHaveBeenCalled()
  expect(resolveWorkspacePortLeaseEnsure).not.toHaveBeenCalled()
})

it("resolves unique roots read-only, preserving assigned and unassigned results", async () => {
  jest
    .mocked(resolveWorkspacePortLease)
    .mockImplementation(async (path) => (path === "/repo" ? lease : null))
  const { result, rerender } = renderHook(({ roots }) => usePortLeaseResolve(roots), {
    initialProps: { roots: ["/repo", "/other", "/repo"] },
  })
  expect(result.current["/repo"].loading).toBe(true)
  await waitFor(() => expect(result.current["/repo"].lease).toEqual(lease))
  expect(result.current["/other"]).toEqual({
    lease: null,
    loading: false,
    error: null,
    inert: false,
  })
  expect(resolveWorkspacePortLease).toHaveBeenCalledTimes(2)
  expect(resolveWorkspacePortLease).toHaveBeenCalledWith("/repo")
  rerender({ roots: ["/repo", "/other", "/repo"] })
  expect(resolveWorkspacePortLease).toHaveBeenCalledTimes(2)
})

it("is explicitly inert without a desktop or connected host", () => {
  jest.mocked(hasHostRuntime).mockReturnValue(false)
  const { result } = renderHook(() => usePortLeaseResolve(["/repo"]))
  expect(result.current["/repo"]).toEqual({ lease: null, loading: false, error: null, inert: true })
  expect(resolveWorkspacePortLease).not.toHaveBeenCalled()
})

it("preserves host errors instead of claiming no lease exists", async () => {
  jest.mocked(resolveWorkspacePortLease).mockRejectedValueOnce(new Error("Host denied /repo"))
  const { result } = renderHook(() => usePortLeaseResolve(["/repo"]))
  await waitFor(() => expect(result.current["/repo"].error).toBe("Host denied /repo"))
  expect(result.current["/repo"].loading).toBe(false)
})

it("never displays a previous root's lease after the root changes", async () => {
  let finishOld!: (lease: WorkspacePortLease) => void
  jest.mocked(resolveWorkspacePortLease).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOld = resolve
      })
  )
  const { result, rerender } = renderHook(({ root }) => usePortLeaseResolve([root]), {
    initialProps: { root: "/repo" },
  })
  rerender({ root: "/other" })
  await waitFor(() => expect(result.current["/other"].loading).toBe(false))
  await act(async () => {
    finishOld(lease)
  })
  expect(result.current["/repo"]).toBeUndefined()
  expect(result.current["/other"].lease).toBeNull()
})
