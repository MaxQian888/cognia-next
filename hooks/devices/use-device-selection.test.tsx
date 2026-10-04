import { act, renderHook } from "@testing-library/react"

import type { DeviceRow } from "@/lib/devices/types"
import { useDeviceConsoleStore } from "@/stores/devices/device-console-store"

import { useDeviceSelection } from "./use-device-selection"

let searchParams = new URLSearchParams()
const replace = jest.fn((href: string, _options?: unknown) => {
  // Behave like the router: the next render reads the new query.
  searchParams = new URLSearchParams(href.split("?")[1] ?? "")
})
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: (href: string, options: unknown) => replace(href, options) }),
  usePathname: () => "/devices",
  useSearchParams: () => searchParams,
}))

function row(ref: string, overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    ref,
    kind: "paired-device",
    label: ref,
    isSelf: false,
    adminState: "active",
    reachability: "online",
    liveness: { online: true, lastSeenAt: 1, source: "request" },
    capabilities: [],
    capabilityReportMissing: false,
    grants: [],
    placement: { provides: [], activeUnits: 0, maxUnits: Number.POSITIVE_INFINITY },
    runtime: {
      sandbox: { support: "unsupported", connections: [] },
      shellTiers: [],
      workspaces: { support: "unsupported" },
      isRoutingTarget: false,
    },
    ...overrides,
  }
}

const LOCAL = row("local", { kind: "local", isSelf: true })
const PHONE = row("device:a")
const TABLET = row("device:b")

const initial = useDeviceConsoleStore.getState()

beforeEach(() => {
  useDeviceConsoleStore.setState(initial, true)
  searchParams = new URLSearchParams()
  replace.mockClear()
})

function setup(props: Parameters<typeof useDeviceSelection>[0]) {
  return renderHook(
    (current: Parameters<typeof useDeviceSelection>[0]) => useDeviceSelection(current),
    { initialProps: props }
  )
}

describe("useDeviceSelection", () => {
  it("falls back to this machine and leaves the URL alone", () => {
    const { result } = setup({ rows: [LOCAL, PHONE], loading: false })
    expect(result.current.selectedRef).toBe("local")
    expect(replace).not.toHaveBeenCalled()
  })

  it("applies a deep link and tells the caller, so a phone can open the drawer", () => {
    searchParams = new URLSearchParams("device=device:a")
    const onDeepLink = jest.fn()
    const { result } = setup({ rows: [LOCAL, PHONE], loading: false, onDeepLink })
    expect(result.current.selectedRef).toBe("device:a")
    expect(onDeepLink).toHaveBeenCalledWith("device:a")
  })

  /**
   * The regression this hook exists for: the link used to be re-applied on
   * every render where it differed from the selection, so with `?device=A` in
   * the URL a click on B snapped straight back to A.
   */
  it("does not snap a user's choice back to the link it arrived with", () => {
    searchParams = new URLSearchParams("device=device:a")
    const { result, rerender } = setup({ rows: [LOCAL, PHONE, TABLET], loading: false })
    act(() => result.current.select("device:b"))
    rerender({ rows: [LOCAL, PHONE, TABLET], loading: false })
    // A poll hands a fresh array with the same devices.
    rerender({ rows: [LOCAL, PHONE, TABLET].map((entry) => ({ ...entry })), loading: false })
    expect(result.current.selectedRef).toBe("device:b")
  })

  it("mirrors a choice into the URL without a history entry", () => {
    searchParams = new URLSearchParams("addHost=1")
    const { result } = setup({ rows: [LOCAL, PHONE], loading: false })
    act(() => result.current.select("device:a"))
    expect(replace).toHaveBeenCalledWith("/devices?addHost=1&device=device%3Aa", {
      scroll: false,
    })
  })

  it("waits for a linked device that arrives with the first host read", () => {
    searchParams = new URLSearchParams("device=worker:w")
    const { result, rerender } = setup({ rows: [LOCAL], loading: true })
    // Not painted over with this machine while the rows are still loading.
    expect(result.current.selectedRef).toBeNull()
    expect(result.current.missingDeepLink).toBeNull()

    rerender({ rows: [LOCAL, row("worker:w", { kind: "worker" })], loading: false })
    expect(result.current.selectedRef).toBe("worker:w")
  })

  it("says so when a link names a device this fleet does not have", () => {
    searchParams = new URLSearchParams("device=device:gone")
    const { result } = setup({ rows: [LOCAL, PHONE], loading: false })
    expect(result.current.missingDeepLink).toBe("device:gone")
    expect(result.current.selectedRef).toBe("local")

    act(() => result.current.dismissMissingDeepLink())
    expect(replace).toHaveBeenLastCalledWith("/devices", { scroll: false })
  })

  it("falls back to this machine when the selected device leaves the list", () => {
    const { result, rerender } = setup({ rows: [LOCAL, PHONE], loading: false })
    act(() => result.current.select("device:a"))
    rerender({ rows: [LOCAL], loading: false })
    expect(result.current.selectedRef).toBe("local")
  })

  it("waits when there are no rows at all", () => {
    searchParams = new URLSearchParams("device=device:not-yet")
    const { result } = setup({ rows: [], loading: false })
    expect(result.current.selected).toBeNull()
    expect(result.current.missingDeepLink).toBeNull()
  })
})
