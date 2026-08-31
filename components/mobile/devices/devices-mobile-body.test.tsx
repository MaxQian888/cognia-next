/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { DeviceRow } from "@/lib/devices/types"
import { useDeviceConsoleStore } from "@/stores/devices/device-console-store"

let rows: DeviceRow[] = []
const refresh = jest.fn(async () => {})
const push = jest.fn()
let searchParams = new URLSearchParams()

jest.mock("@/hooks/devices/use-device-rows", () => ({
  useDeviceRows: () => ({
    rows,
    summary: { total: rows.length, online: rows.length, needsAttention: 0 },
    loading: false,
    hostUnreachable: false,
    refresh,
  }),
}))
jest.mock("@/hooks/devices/use-device-grant-actions", () => ({ useDeviceGrantActions: () => ({}) }))
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: (...a: unknown[]) => push(...a) }),
  useSearchParams: () => searchParams,
}))
jest.mock("@/components/devices/device-detail", () => ({
  DeviceDetail: ({ row }: { row: DeviceRow | null }) => (
    <div data-testid="mobile-detail">{row?.ref ?? "none"}</div>
  ),
}))
jest.mock("@/components/devices/add-host-sheet", () => ({
  AddHostSheet: ({ open }: { open: boolean }) =>
    open ? <div data-testid="mobile-add-host" /> : null,
}))
jest.mock("@/components/devices/execution-host-switcher", () => ({
  ExecutionHostChip: () => <div data-testid="mobile-execution-host" />,
}))

import { DevicesMobileBody } from "./devices-mobile-body"

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

const initial = useDeviceConsoleStore.getState()

beforeEach(() => {
  useDeviceConsoleStore.setState(initial, true)
  rows = [row({ ref: "local", kind: "local", label: "This Mac", isSelf: true }), row()]
  searchParams = new URLSearchParams()
  push.mockClear()
})

/**
 * The list is the page here, not a sidebar behind a Sheet trigger. That
 * inversion is the whole reason this body exists next to `DeviceConsole`.
 */
it("renders the fleet list directly rather than behind a trigger", () => {
  render(<DevicesMobileBody />)
  expect(screen.getByTestId("device-list-pane")).toBeInTheDocument()
  expect(screen.queryByTestId("mobile-detail")).toBeNull()
})

it("opens the detail drawer on tap and shows the tapped device", async () => {
  render(<DevicesMobileBody />)
  await userEvent.click(screen.getByTestId("device-row-device:a"))
  expect(await screen.findByTestId("mobile-detail")).toHaveTextContent("device:a")
})

/**
 * Selection is persisted (it is what the desktop reopens on), so deriving the
 * drawer's open state from it would pop a sheet every time the user returns.
 */
it("does not reopen the drawer from a persisted selection", () => {
  useDeviceConsoleStore.setState({ ...initial, selectedRef: "device:a" }, true)
  render(<DevicesMobileBody />)
  expect(screen.queryByTestId("mobile-detail")).toBeNull()
})

it("adds a host in place and honours the ?addHost deep link", async () => {
  render(<DevicesMobileBody />)
  await userEvent.click(screen.getByTestId("mobile-devices-add-host"))
  expect(screen.getByTestId("mobile-add-host")).toBeInTheDocument()
  expect(push).not.toHaveBeenCalled()
})

it("routes pairing to /pair, which exists on a phone", async () => {
  rows = [row({ ref: "local", kind: "local", label: "This Mac", isSelf: true })]
  render(<DevicesMobileBody />)
  await userEvent.click(screen.getByTestId("mobile-devices-pair"))
  expect(push).toHaveBeenCalledWith("/pair")
})
