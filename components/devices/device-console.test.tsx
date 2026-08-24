import { render, screen } from "@testing-library/react"

import { TooltipProvider } from "@/components/ui/tooltip"

import type { DeviceRow } from "@/lib/devices/types"
import { useDeviceConsoleStore } from "@/stores/devices/device-console-store"

import { DeviceConsole } from "./device-console"

let rows: DeviceRow[] = []
let hostUnreachable = false
const refresh = jest.fn(async () => {})

jest.mock("@/hooks/devices/use-device-rows", () => ({
  useDeviceRows: () => ({
    rows,
    summary: { total: rows.length, online: rows.length, needsAttention: 0 },
    loading: false,
    hostUnreachable,
    refresh,
  }),
}))

jest.mock("@/hooks/devices/use-device-grant-actions", () => ({
  useDeviceGrantActions: () => ({}),
}))

let searchParams = new URLSearchParams()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => searchParams,
}))

jest.mock("./device-detail", () => ({
  DeviceDetail: ({ row }: { row: DeviceRow | null }) => (
    <div data-testid="detail">{row?.ref ?? "none"}</div>
  ),
}))

function row(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    ref: "device:a",
    kind: "paired-device",
    label: "Phone",
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

const LOCAL = row({ ref: "local", kind: "local", label: "This Mac", isSelf: true })

/**
 * `TooltipProvider` is mounted once in `app/layout.tsx` in production, so the
 * header's action tooltips have an ancestor there but not here.
 */
function renderConsole() {
  return render(
    <TooltipProvider>
      <DeviceConsole />
    </TooltipProvider>
  )
}

const initial = useDeviceConsoleStore.getState()

beforeEach(() => {
  useDeviceConsoleStore.setState(initial, true)
  rows = [LOCAL, row()]
  searchParams = new URLSearchParams()
  hostUnreachable = false
  jest.clearAllMocks()
})

describe("DeviceConsole", () => {
  /**
   * This machine is the one row that is always present and always safe to
   * show. Reopening pinned to a phone that has since been revoked would leave
   * the pane empty with no explanation.
   */
  it("selects this machine when nothing is selected", () => {
    renderConsole()
    expect(screen.getByTestId("detail")).toHaveTextContent("local")
  })

  it("falls back to this machine when the selected device disappears", () => {
    useDeviceConsoleStore.getState().select("device:a")
    const { rerender } = renderConsole()
    expect(screen.getByTestId("detail")).toHaveTextContent("device:a")

    rows = [LOCAL]
    rerender(
      <TooltipProvider>
        <DeviceConsole />
      </TooltipProvider>
    )
    expect(screen.getByTestId("detail")).toHaveTextContent("local")
  })

  it("keeps a valid selection alone", () => {
    useDeviceConsoleStore.getState().select("device:a")
    renderConsole()
    expect(screen.getByTestId("detail")).toHaveTextContent("device:a")
  })

  /**
   * The deep link is what ⌘K and the Settings entry points hand us; landing on
   * the previous selection instead would silently ignore what was asked for.
   */
  it("honours a ?device= deep link over the stored selection", () => {
    useDeviceConsoleStore.getState().select("local")
    searchParams = new URLSearchParams("device=device:a")
    renderConsole()
    expect(screen.getByTestId("detail")).toHaveTextContent("device:a")
  })

  it("waits rather than stomping a deep link for a device that has not loaded", () => {
    searchParams = new URLSearchParams("device=device:not-yet")
    rows = []
    renderConsole()
    expect(screen.getByTestId("detail")).toHaveTextContent("none")
  })

  it("reports how much of the fleet is online", () => {
    renderConsole()
    expect(screen.getByText("2 of 2 online")).toBeInTheDocument()
  })

  /**
   * Without the host, lifecycle state and the raw capability sets come from
   * the local mirror, so `partial` grants and CLI-side suspensions cannot be
   * detected. Stated rather than swallowed.
   */
  it("says when it is showing the local record only", () => {
    hostUnreachable = true
    renderConsole()
    expect(screen.getByTestId("device-host-unreachable")).toBeInTheDocument()
    expect(screen.getByText(/may still read as active/)).toBeInTheDocument()
  })

  it("stays quiet when the host answered", () => {
    renderConsole()
    expect(screen.queryByTestId("device-host-unreachable")).not.toBeInTheDocument()
  })

  it("renders the rail and the header", () => {
    renderConsole()
    expect(screen.getByTestId("device-list-pane")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Devices" })).toBeInTheDocument()
  })
})
