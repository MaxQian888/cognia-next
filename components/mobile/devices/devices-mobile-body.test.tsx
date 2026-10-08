/**
 * @jest-environment jsdom
 */
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { DeviceRow } from "@/lib/devices/types"
import { useDeviceConsoleStore } from "@/stores/devices/device-console-store"

let rows: DeviceRow[] = []
let needsAttention = 0
let hostUnreachable = false
const refresh = jest.fn(async () => {})
const push = jest.fn()
let searchParams = new URLSearchParams()
const replace = jest.fn((href: string, _options?: unknown) => {
  searchParams = new URLSearchParams(href.split("?")[1] ?? "")
})

jest.mock("@/hooks/devices/use-device-rows", () => ({
  useDeviceRows: () => ({
    rows,
    summary: { total: rows.length, online: rows.length, needsAttention },
    loading: false,
    hostUnreachable,
    refresh,
  }),
}))
jest.mock("@/hooks/devices/use-device-grant-actions", () => ({ useDeviceGrantActions: () => ({}) }))
jest.mock("next/navigation", () => ({
  useRouter: () => ({
    push: (...a: unknown[]) => push(...a),
    replace: (href: string, options: unknown) => replace(href, options),
  }),
  usePathname: () => "/devices",
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
let syncIncoming: unknown[] = []
jest.mock("@/stores/account-sync/account-sync-store", () => ({
  useAccountSyncStore: (selector: (state: { incoming: unknown[] }) => unknown) =>
    selector({ incoming: syncIncoming }),
}))
let syncEnabled = false
jest.mock("@/lib/account-sync/feature-flag", () => ({ accountSyncEnabled: () => syncEnabled }))
jest.mock("@/components/account/sync/sync-approval-fleet-notice", () => ({
  SyncApprovalFleetNotice: () => <div data-testid="sync-approval-fleet-notice" />,
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
  needsAttention = 0
  hostUnreachable = false
  syncIncoming = []
  syncEnabled = false
  push.mockClear()
  replace.mockClear()
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

it("gives the screen a way back to the hub that opened it", () => {
  render(<DevicesMobileBody />)
  expect(screen.getByTestId("mobile-back-button")).toBeInTheDocument()
})

/**
 * A full-screen page pushed over the list, not a 72vh drawer: the record gets
 * the whole screen, and the list underneath is kept but taken out of reach.
 */
it("pushes the tapped device's page over the list", async () => {
  render(<DevicesMobileBody />)
  await userEvent.click(screen.getByTestId("device-row-device:a"))
  expect(await screen.findByTestId("mobile-detail")).toHaveTextContent("device:a")
  expect(screen.getByTestId("mobile-device-detail-page")).toBeInTheDocument()
  expect(screen.queryByTestId("responsive-detail-drawer")).toBeNull()
  // Still mounted (scroll, search and filters survive), but inert while covered.
  expect(screen.getByTestId("mobile-devices-list-screen")).toHaveAttribute("inert")
})

it("returns to the list from the page's back button", async () => {
  render(<DevicesMobileBody />)
  await userEvent.click(screen.getByTestId("device-row-device:a"))
  await userEvent.click(await screen.findByTestId("mobile-device-detail-back"))
  expect(screen.queryByTestId("mobile-device-detail-page")).toBeNull()
  expect(screen.getByTestId("mobile-devices-list-screen")).not.toHaveAttribute("inert")
})

/**
 * The page owns a history entry, so the system back (Android's button, the
 * browser's) pops the page instead of leaving `/devices`.
 */
it("closes the page on a history pop, as the system back does", async () => {
  render(<DevicesMobileBody />)
  await userEvent.click(screen.getByTestId("device-row-device:a"))
  expect(await screen.findByTestId("mobile-device-detail-page")).toBeInTheDocument()
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate"))
  })
  expect(screen.queryByTestId("mobile-device-detail-page")).toBeNull()
})

/**
 * Selection is persisted (it is what the desktop reopens on), so deriving the
 * page's open state from it would push it every time the user returns.
 */
it("does not reopen the page from a persisted selection", () => {
  useDeviceConsoleStore.setState({ ...initial, selectedRef: "device:a" }, true)
  render(<DevicesMobileBody />)
  expect(screen.queryByTestId("mobile-detail")).toBeNull()
})

it("adds a host in place from the header's grow menu", async () => {
  const user = userEvent.setup()
  render(<DevicesMobileBody />)
  await user.click(screen.getByTestId("mobile-devices-add"))
  await user.click(screen.getByTestId("mobile-devices-add-host"))
  expect(screen.getByTestId("mobile-add-host")).toBeInTheDocument()
  expect(push).not.toHaveBeenCalled()
})

it("honours the ?addHost deep link", () => {
  searchParams = new URLSearchParams("addHost=1")
  render(<DevicesMobileBody />)
  expect(screen.getByTestId("mobile-add-host")).toBeInTheDocument()
})

/**
 * Pairing used to vanish from this screen once a second device existed, so a
 * phone with one pairing could not start another from the device console.
 */
it("keeps pairing reachable however large the fleet is", async () => {
  const user = userEvent.setup()
  rows = [...rows, row({ ref: "device:b", label: "Tablet" })]
  render(<DevicesMobileBody />)
  await user.click(screen.getByTestId("mobile-devices-add"))
  await user.click(screen.getByTestId("mobile-devices-pair"))
  expect(push).toHaveBeenCalledWith("/pair")
})

/** The desktop offers SSH hosts from its header; the phone's grow menu does too. */
it("offers adding an SSH host from the grow menu", async () => {
  const user = userEvent.setup()
  render(<DevicesMobileBody />)
  await user.click(screen.getByTestId("mobile-devices-add"))
  await user.click(screen.getByTestId("mobile-devices-add-ssh-host"))
  expect(push).toHaveBeenCalledWith(expect.stringContaining("/settings"))
})

/** ⌘K and Settings hand a device over as a link; it used to open a list. */
it("opens the linked device's page from a ?device= link", async () => {
  searchParams = new URLSearchParams("device=device:a")
  render(<DevicesMobileBody />)
  expect(await screen.findByTestId("mobile-detail")).toHaveTextContent("device:a")
})

it("mirrors a tapped device into the URL", async () => {
  render(<DevicesMobileBody />)
  await userEvent.click(screen.getByTestId("device-row-device:a"))
  expect(replace).toHaveBeenCalledWith("/devices?device=device%3Aa", { scroll: false })
})

it("states the fleet notices the desktop states", () => {
  hostUnreachable = true
  render(<DevicesMobileBody />)
  expect(screen.getByTestId("device-host-unreachable")).toBeInTheDocument()
})

it("states a waiting sync approval, as the desktop rail does", () => {
  syncIncoming = [{ id: "incoming-1" }]
  syncEnabled = true
  render(<DevicesMobileBody />)
  expect(screen.getByTestId("sync-approval-fleet-notice")).toBeInTheDocument()
})

it("says nothing about sync approvals in a build without account sync", () => {
  syncIncoming = [{ id: "incoming-1" }]
  syncEnabled = false
  render(<DevicesMobileBody />)
  expect(screen.queryByTestId("sync-approval-fleet-notice")).toBeNull()
})

it("turns the attention count into the filter for what it counted", async () => {
  needsAttention = 1
  render(<DevicesMobileBody />)
  await userEvent.click(screen.getByTestId("mobile-devices-attention-count"))
  expect(useDeviceConsoleStore.getState().attentionOnly).toBe(true)
})
