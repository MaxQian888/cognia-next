/**
 * @jest-environment jsdom
 */

import { act, renderHook, waitFor } from "@testing-library/react"

import { useLanScan } from "./use-lan-scan"
import type { DiscoveredServer } from "@/lib/connectivity/lan-scanner"
import type { MdnsPermissionOutcome } from "@/lib/connectivity/mdns-permission"

function server(overrides: Partial<DiscoveredServer> = {}): DiscoveredServer {
  return {
    id: overrides.id ?? `${overrides.ip ?? "192.168.1.5"}:${overrides.port ?? 7890}`,
    ip: "192.168.1.5",
    port: 7890,
    baseUrl: "https://192.168.1.5:7890",
    source: "probe",
    discoveredAt: 0,
    ...overrides,
  }
}

function scanStub(hits: DiscoveredServer[] = [], rejectsWith?: Error) {
  return jest.fn(async ({ onFound }: { onFound: (s: DiscoveredServer) => void }) => {
    if (rejectsWith) throw rejectsWith
    for (const h of hits) onFound(h)
    return hits
  })
}

describe("useLanScan", () => {
  it("seeds the list from history as `history` source", () => {
    const history = [server({ id: "10.0.0.1:7890", ip: "10.0.0.1", source: "paired" })]
    const { result } = renderHook(() =>
      useLanScan({ history, scan: scanStub() as never, enabled: false })
    )
    expect(result.current.servers).toHaveLength(1)
    expect(result.current.servers[0].source).toBe("history")
  })

  it("auto-scans on mount and surfaces hits, then settles scanning", async () => {
    const scan = scanStub([server({ id: "192.168.1.9:7890", ip: "192.168.1.9" })])
    const { result } = renderHook(() => useLanScan({ scan: scan as never }))
    await waitFor(() => expect(scan).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(result.current.servers).toHaveLength(1))
    await waitFor(() => expect(result.current.scanning).toBe(false))
  })

  it("rescan re-invokes the scan", async () => {
    const scan = scanStub()
    const { result } = renderHook(() => useLanScan({ scan: scan as never }))
    await waitFor(() => expect(scan).toHaveBeenCalledTimes(1))
    act(() => result.current.rescan())
    await waitFor(() => expect(scan).toHaveBeenCalledTimes(2))
  })

  it("does not scan while disabled, scans once enabled", async () => {
    const scan = scanStub()
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useLanScan({ scan: scan as never, enabled }),
      { initialProps: { enabled: false } }
    )
    expect(scan).not.toHaveBeenCalled()
    expect(result.current.scanning).toBe(false)
    rerender({ enabled: true })
    await waitFor(() => expect(scan).toHaveBeenCalledTimes(1))
  })

  it("requestPermission=denied blocks the scan and flags permissionDenied", async () => {
    const scan = scanStub()
    const requestPermission = jest.fn(
      async (): Promise<MdnsPermissionOutcome> => ({ kind: "denied" })
    )
    const { result } = renderHook(() =>
      useLanScan({ scan: scan as never, requestPermission: requestPermission as never })
    )
    await waitFor(() => expect(result.current.permissionDenied).toBe(true))
    expect(result.current.permission).toBe("denied")
    expect(scan).not.toHaveBeenCalled()
  })

  it("flags permissionDenied when the scan throws a permission error", async () => {
    const scan = scanStub([], new Error("Local network permission denied"))
    const { result } = renderHook(() => useLanScan({ scan: scan as never }))
    await waitFor(() => expect(result.current.permissionDenied).toBe(true))
  })

  it("resetOnRun clears the list at the start of each run", async () => {
    const scan = scanStub([server({ id: "192.168.1.9:7890", ip: "192.168.1.9" })])
    const { result } = renderHook(() => useLanScan({ scan: scan as never, resetOnRun: true }))
    await waitFor(() => expect(result.current.servers).toHaveLength(1))
    act(() => result.current.rescan())
    await waitFor(() => expect(scan).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.servers).toHaveLength(1))
  })
})
