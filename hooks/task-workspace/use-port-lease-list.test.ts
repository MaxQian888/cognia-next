/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"
import { usePortLeaseList } from "./use-port-lease-list"
import {
  listWorkspacePortLeases,
  ensureWorkspacePortLease,
  ensureSubjectPortLease,
  resolveWorkspacePortLeaseEnsure,
} from "@/lib/task-workspace/client"

jest.mock("@/lib/task-workspace/client", () => ({
  listWorkspacePortLeases: jest.fn(),
  ensureWorkspacePortLease: jest.fn(),
  ensureSubjectPortLease: jest.fn(),
  resolveWorkspacePortLeaseEnsure: jest.fn(),
}))
let mockHasHost = true
jest.mock("@/lib/platform/capabilities", () => ({ hasHostRuntime: () => mockHasHost }))
const list = jest.mocked(listWorkspacePortLeases)

beforeEach(() => {
  jest.clearAllMocks()
  mockHasHost = true
  list.mockReset().mockResolvedValue({ leases: [], diagnostics: [] })
})

it("reads and refreshes without issuing any allocating command", async () => {
  const { result } = renderHook(() => usePortLeaseList())
  await waitFor(() => expect(result.current.status).toBe("ready"))
  await act(() => result.current.refresh())
  expect(list).toHaveBeenCalledTimes(2)
  expect(ensureWorkspacePortLease).not.toHaveBeenCalled()
  expect(ensureSubjectPortLease).not.toHaveBeenCalled()
  expect(resolveWorkspacePortLeaseEnsure).not.toHaveBeenCalled()
})

it("is explicitly inert without a host", async () => {
  mockHasHost = false
  const { result } = renderHook(() => usePortLeaseList())
  await act(() => result.current.refresh())
  expect(result.current.status).toBe("inert")
  expect(list).not.toHaveBeenCalled()
})

it("preserves verbatim errors and recovers on refresh", async () => {
  list.mockRejectedValueOnce(new Error("host inventory failed"))
  const { result } = renderHook(() => usePortLeaseList())
  await waitFor(() => expect(result.current.error).toBe("host inventory failed"))
  await act(() => result.current.refresh())
  expect(result.current.status).toBe("ready")
  expect(result.current.error).toBeNull()
})

it("ignores stale requests and refreshes only when enabled", async () => {
  let resolveOld!: (value: { leases: []; diagnostics: [] }) => void
  list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve
      })
  )
  const { result, rerender } = renderHook(
    ({ enabled, refreshKey }) => usePortLeaseList({ enabled, refreshKey }),
    {
      initialProps: { enabled: false, refreshKey: 0 },
    }
  )
  expect(list).not.toHaveBeenCalled()
  rerender({ enabled: true, refreshKey: 0 })
  expect(result.current.status).toBe("loading")
  list.mockRejectedValueOnce(new Error("newer request failed"))
  rerender({ enabled: true, refreshKey: 1 })
  await waitFor(() => expect(result.current.error).toBe("newer request failed"))
  await act(async () => resolveOld({ leases: [], diagnostics: [] }))
  expect(result.current.error).toBe("newer request failed")
})
