import { act, renderHook, waitFor } from "@testing-library/react"
import { useBestOfNRun } from "./use-best-of-n-run"
import { canManageBestOfNRuns, refreshBestOfNRun } from "@/lib/best-of-n/projection"

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => undefined }))
jest.mock("@/lib/best-of-n/projection", () => ({
  canManageBestOfNRuns: jest.fn(),
  getBestOfNRun: jest.fn(),
  refreshBestOfNRun: jest.fn(),
}))

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(refreshBestOfNRun).mockResolvedValue({} as never)
})
it("keeps paired devices on their synced projection without querying the Host", async () => {
  jest.mocked(canManageBestOfNRuns).mockReturnValue(false)
  const { result } = renderHook(() => useBestOfNRun("group"))
  await act(() => result.current.refresh())
  expect(refreshBestOfNRun).not.toHaveBeenCalled()
})
it("polls the Host and exposes failed refreshes without discarding the projection", async () => {
  jest.mocked(canManageBestOfNRuns).mockReturnValue(true)
  jest.mocked(refreshBestOfNRun).mockRejectedValueOnce(new Error("offline"))
  const { result, unmount } = renderHook(() => useBestOfNRun("group"))
  await waitFor(() => expect(result.current.failed).toBe(true))
  await act(() => result.current.refresh())
  expect(result.current.failed).toBe(false)
  unmount()
})
