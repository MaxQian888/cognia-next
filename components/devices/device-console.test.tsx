import { render, screen } from "@testing-library/react"

import { TooltipProvider } from "@/components/ui/tooltip"

import type { DeviceRow } from "@/lib/devices/types"
import { useDeviceConsoleStore } from "@/stores/devices/device-console-store"

import { DeviceConsole } from "./device-console"

let rows: DeviceRow[] = []
let needsAttention = 0
let hostUnreachable = false
const refresh = jest.fn(async () => {})

jest.mock("@/hooks/devices/use-device-rows", () => ({
  useDeviceRows: () => ({
    rows,
    summary: { total: rows.length, online: rows.length, needsAttention },
    loading: false,
    hostUnreachable,
    refresh,
  }),
}))

jest.mock("@/hooks/devices/use-device-grant-actions", () => ({
  useDeviceGrantActions: () => ({}),
}))

let searchParams = new URLSearchParams()
/**
 * `var`, not `let`: `jest.mock` factories are hoisted above this file's body,
 * and `components/ui/tooltip` pulls in `lib/tauri`, which calls `isTauri()` at
 * module-init time. A `let` would still be in its temporal dead zone at that
 * point and reading it throws; `var` is hoisted as `undefined`, so the `??`
 * defaults below apply until `beforeEach` sets a real value.
 */
// eslint-disable-next-line no-var -- hoisting is the point; see above.
var platform: { tauri: boolean; capacitor: boolean; webCompanion: boolean } | undefined
// Spread the real module: `detect` also exports `isNativeMobile`,
// `detectPlatform` and friends that the imported tree calls at load time, and
// replacing the whole module wholesale removes them.
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: () => platform?.tauri ?? true,
  isCapacitor: () => platform?.capacitor ?? false,
}))
jest.mock("@/lib/platform/web-companion", () => ({
  hasWebCompanionTarget: () => platform?.webCompanion ?? false,
}))

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
  platform = { tauri: true, capacitor: false, webCompanion: false }
  hostUnreachable = false
  needsAttention = 0
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

  /**
   * `standalone: "explain"` in `lib/runtime/surface-contract.ts` is a convention
   * each surface implements for itself — `resolveSurfaceAvailability` has no
   * generic branch for it, so an unimplemented "explain" is a silent lie.
   * See `standaloneDevicesRequiresHost`.
   */
  it("says which half is missing when nothing is paired and there is no host", () => {
    platform = { tauri: false, capacitor: false, webCompanion: false }
    rows = [LOCAL]
    renderConsole()
    expect(screen.getByTestId("devices-requires-host")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Pair with a host/ })).toHaveAttribute("href", "/pair")
  })

  it("keeps showing this machine rather than swapping the console out", () => {
    platform = { tauri: false, capacitor: false, webCompanion: false }
    rows = [LOCAL]
    renderConsole()
    expect(screen.getByTestId("detail")).toHaveTextContent("local")
    expect(screen.getByTestId("device-list-pane")).toBeInTheDocument()
  })

  it("stays quiet on a desktop host", () => {
    renderConsole()
    expect(screen.queryByTestId("devices-requires-host")).not.toBeInTheDocument()
  })

  it("stays quiet on a phone paired to a host", () => {
    platform = { tauri: false, capacitor: true, webCompanion: false }
    renderConsole()
    expect(screen.queryByTestId("devices-requires-host")).not.toBeInTheDocument()
  })

  it("stays quiet in a browser pointed at a companion", () => {
    platform = { tauri: false, capacitor: false, webCompanion: true }
    renderConsole()
    expect(screen.queryByTestId("devices-requires-host")).not.toBeInTheDocument()
  })

  it("renders the rail and the header", () => {
    renderConsole()
    expect(screen.getByTestId("device-list-pane")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Devices" })).toBeInTheDocument()
  })

  /**
   * `summarizeDeviceRows` has always returned this count and nothing rendered
   * it, so a revoked phone or a host stuck in `versionMismatch` could only be
   * found by opening every row in turn.
   */
  it("surfaces the attention count in the header", () => {
    needsAttention = 2
    renderConsole()
    expect(screen.getByTestId("devices-attention-count")).toHaveTextContent("2 need attention")
  })

  it("hides the attention badge when nothing needs attention", () => {
    renderConsole()
    expect(screen.queryByTestId("devices-attention-count")).not.toBeInTheDocument()
  })
})
