import { act, renderHook, waitFor } from "@testing-library/react"

jest.mock("@/lib/filespace/grants-client", () => ({
  ...jest.requireActual("@/lib/filespace/grants-client"),
  getFileShareStatus: jest.fn(),
  listLiveGrants: jest.fn(),
}))

import { getFileShareStatus, listLiveGrants } from "@/lib/filespace/grants-client"
import { __resetRoutingForTests, setActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import type { Transport } from "@/lib/tauri/transport-types"
import type { FileShareStatus, LiveGrantView } from "@/types/filespace/live"

import { useLiveFileShare } from "./use-live-file-share"

const statusMock = getFileShareStatus as jest.Mock
const grantsMock = listLiveGrants as jest.Mock

const status = { active: true, accountId: "a" } as FileShareStatus
const grant = (id: string) => ({ grant: { id }, credentials: [] }) as unknown as LiveGrantView

beforeEach(() => {
  jest.clearAllMocks()
  statusMock.mockResolvedValue(status)
  grantsMock.mockResolvedValue([grant("g1")])
})

describe("useLiveFileShare", () => {
  it("reads the status and one conversation's grants from its host", async () => {
    const { result } = renderHook(() => useLiveFileShare({ sessionId: "s1", hostId: "local" }))
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.status).toBe(status)
    expect(result.current.grants.map((view) => view.grant.id)).toEqual(["g1"])
    expect(statusMock).toHaveBeenCalledWith({ hostId: "local" })
    expect(grantsMock).toHaveBeenCalledWith({ sessionId: "s1" }, { hostId: "local" })
  })

  it("lists every grant through a given transport", async () => {
    const transport = { call: jest.fn() } as unknown as Transport
    const { result } = renderHook(() => useLiveFileShare({ transport }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(grantsMock).toHaveBeenCalledWith({}, { transport })
  })

  it("reports the host's refusal as a code", async () => {
    statusMock.mockRejectedValue({ code: "file_share_unavailable", message: "x", retryable: false })
    const { result } = renderHook(() => useLiveFileShare({ sessionId: "s1" }))
    await waitFor(() => expect(result.current.error).toBe("file_share_unavailable"))
    expect(result.current.errorMessage).toBe("x")
    expect(result.current.status).toBeNull()
  })

  it("keeps the last answer on screen while a reload runs", async () => {
    const { result } = renderHook(() => useLiveFileShare({ sessionId: "s1" }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    let resolve!: (value: LiveGrantView[]) => void
    grantsMock.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    act(() => result.current.reload())
    expect(result.current.loading).toBe(true)
    expect(result.current.grants).toHaveLength(1)
    await act(async () => resolve([grant("g1"), grant("g2")]))
    expect(result.current.grants).toHaveLength(2)
    expect(result.current.loading).toBe(false)
  })

  it("drops another conversation's answer instead of showing it", async () => {
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) => useLiveFileShare({ sessionId }),
      { initialProps: { sessionId: "s1" } }
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    grantsMock.mockReturnValueOnce(new Promise(() => {}))
    rerender({ sessionId: "s2" })
    expect(result.current.grants).toEqual([])
    expect(result.current.loading).toBe(true)
  })

  it("reads again when the routed transport reaches another Host", async () => {
    const transport = { call: jest.fn() } as unknown as Transport
    const { result } = renderHook(() => useLiveFileShare({ transport }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    grantsMock.mockReturnValueOnce(new Promise(() => {}))
    act(() => {
      setActiveRemoteTransport({ call: jest.fn() } as unknown as Transport)
    })
    // The other Host's shares are not shown while its own read runs.
    expect(result.current.grants).toEqual([])
    expect(statusMock).toHaveBeenCalledTimes(2)
    __resetRoutingForTests()
  })

  it("reads nothing while disabled", () => {
    const { result } = renderHook(() => useLiveFileShare({ enabled: false }))
    expect(result.current.loading).toBe(false)
    expect(statusMock).not.toHaveBeenCalled()
  })
})
