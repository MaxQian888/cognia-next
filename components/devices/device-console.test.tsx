import { standaloneDevicesRequiresHost } from "@/lib/runtime/surface-contract"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TooltipProvider } from "@/components/ui/tooltip"

import type { DeviceRow } from "@/lib/devices/types"
import { useDeviceConsoleStore } from "@/stores/devices/device-console-store"
import { accountSyncEnabled } from "@/lib/account-sync/feature-flag"
import { useAccountSyncStore } from "@/stores/account-sync/account-sync-store"

import { DeviceConsole } from "./device-console"

let rows: DeviceRow[] = []
let needsAttention = 0
let loading = false
let hostUnreachable = false
const refresh = jest.fn(async () => {})

jest.mock("@/lib/account-sync/feature-flag", () => ({ accountSyncEnabled: jest.fn(() => false) }))
jest.mock("@/hooks/devices/use-device-rows", () => ({
  useDeviceRows: () => ({
    rows,
    summary: { total: rows.length, online: rows.length, needsAttention },
    loading,
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
  // `hasHostRuntime()` resolves the host PROFILE, which reads the platform, so
  // this mock has to answer consistently with the flags above. A partial mock
  // left `detectPlatform` undefined and the profile resolver threw.
  detectPlatform: () =>
    (platform?.tauri ?? true) ? "tauri" : (platform?.capacitor ?? false) ? "mobile" : "web",
}))
jest.mock("@/lib/platform/web-companion", () => ({
  hasWebCompanionTarget: () => platform?.webCompanion ?? false,
}))

const push = jest.fn()
const replace = jest.fn((href: string, _options?: unknown) => {
  searchParams = new URLSearchParams(href.split("?")[1] ?? "")
})
jest.mock("next/navigation", () => ({
  useRouter: () => ({
    push: (...args: unknown[]) => push(...args),
    replace: (href: string, options: unknown) => replace(href, options),
  }),
  usePathname: () => "/devices",
  useSearchParams: () => searchParams,
}))

jest.mock("./add-host-sheet", () => ({
  AddHostSheet: ({ open, initialBaseUrl }: { open: boolean; initialBaseUrl?: string }) =>
    open ? <div data-testid="add-host-sheet" data-seeded={initialBaseUrl ?? ""} /> : null,
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
  push.mockClear()
  platform = { tauri: true, capacitor: false, webCompanion: false }
  hostUnreachable = false
  needsAttention = 0
  loading = false
  jest.clearAllMocks()
})

describe("DeviceConsole", () => {
  it("uses a settings-width list and preserves the selected device when toggled", () => {
    useDeviceConsoleStore.getState().select("device:a")
    renderConsole()
    const detail = screen.getByTestId("detail")
    const header = screen.getByTestId("feature-shell-devices-header")
    expect(header.closest('[data-testid="feature-shell-devices-center"]')).not.toBeNull()
    expect(header).not.toContainElement(screen.getByTestId("device-list-pane"))
    expect(screen.getByTestId("device-list-pane").closest("aside")).toHaveStyle({
      minWidth: "15rem",
    })
    fireEvent.click(screen.getByRole("button", { name: "Hide Device list" }))
    expect(screen.getByTestId("device-list-pane").closest("aside")).toHaveAttribute("inert")
    fireEvent.click(screen.getByRole("button", { name: "Open Device list" }))
    expect(screen.getByTestId("detail")).toBe(detail)
    expect(detail).toHaveTextContent("device:a")
  })

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

  /**
   * The regression: the link used to be re-applied whenever it differed from
   * the selection, so with `?device=A` in the URL a click on B snapped back.
   */
  it("lets the user leave the device a deep link opened", async () => {
    rows = [LOCAL, row(), row({ ref: "device:b", label: "Tablet" })]
    searchParams = new URLSearchParams("device=device:a")
    const { rerender } = renderConsole()
    expect(screen.getByTestId("detail")).toHaveTextContent("device:a")

    await userEvent.click(screen.getByTestId("device-row-device:b"))
    rerender(
      <TooltipProvider>
        <DeviceConsole />
      </TooltipProvider>
    )
    expect(screen.getByTestId("detail")).toHaveTextContent("device:b")
    expect(replace).toHaveBeenLastCalledWith("/devices?device=device%3Ab", { scroll: false })
  })

  it("explains a link to a device that is no longer here", () => {
    searchParams = new URLSearchParams("device=device:gone")
    renderConsole()
    expect(screen.getByTestId("device-link-missing")).toHaveTextContent("device:gone")
    expect(screen.getByTestId("detail")).toHaveTextContent("local")
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
  it("says when it is showing the local record only, in the list it qualifies", () => {
    hostUnreachable = true
    renderConsole()
    expect(screen.getByTestId("device-list-pane")).toContainElement(
      screen.getByTestId("device-host-unreachable")
    )
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
    const alert = screen.getByTestId("devices-requires-host")
    expect(alert).toBeInTheDocument()
    expect(alert).toHaveAttribute("data-reason", standaloneDevicesRequiresHost.reason)
    expect(screen.getByRole("link", { name: /pair/i })).toHaveAttribute(
      "href",
      standaloneDevicesRequiresHost.remedy
    )
    expect(screen.getByRole("link", { name: /Pair with a host/ })).toHaveAttribute("href", "/pair")
    // The fleet's empty state, so it sits in the list under the one row.
    expect(screen.getByTestId("device-list-pane")).toContainElement(alert)
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

  it("filters the list to what the attention badge counted", async () => {
    needsAttention = 1
    useDeviceConsoleStore.getState().setKindFilter("worker")
    renderConsole()
    await userEvent.click(screen.getByTestId("devices-attention-count"))
    expect(useDeviceConsoleStore.getState()).toMatchObject({
      attentionOnly: true,
      kindFilter: "all",
    })
  })

  it("hides the attention badge when nothing needs attention", () => {
    renderConsole()
    expect(screen.queryByTestId("devices-attention-count")).not.toBeInTheDocument()
  })

  /**
   * The action used to push `/settings?section=remote-hosts`, and that section
   * was `profiles: ["desktop"]`, so on a phone or in a browser the button
   * delivered a settings empty state. Adding a host is the one thing a
   * standalone client can do to stop being standalone, so it happens here.
   */
  it("opens the add-host sheet in place instead of routing to Settings", async () => {
    renderConsole()
    expect(screen.queryByTestId("add-host-sheet")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Add a host" }))
    expect(screen.getByTestId("add-host-sheet")).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })

  it("starts a new SSH host in the editor that owns them", async () => {
    renderConsole()
    await userEvent.click(screen.getByRole("button", { name: "Add SSH host" }))
    expect(push).toHaveBeenCalledWith("/settings?section=terminal&terminalPanel=ssh&sshHost=new")
  })

  it("says it is refreshing until the read settles", async () => {
    let settle!: () => void
    refresh.mockImplementationOnce(() => new Promise<void>((resolve) => (settle = resolve)))
    renderConsole()
    await userEvent.click(screen.getByTestId("devices-refresh"))
    expect(screen.getByTestId("devices-refresh")).toBeDisabled()
    expect(screen.getByTestId("devices-refresh")).toHaveAccessibleName("Refreshing…")
    settle()
    await screen.findByRole("button", { name: "Refresh" })
  })

  it("opens the sheet from a ?addHost deep link and seeds the base URL", () => {
    searchParams = new URLSearchParams("addHost=1&baseUrl=https%3A%2F%2Fbox.example%3A27890")
    renderConsole()
    expect(screen.getByTestId("add-host-sheet")).toHaveAttribute(
      "data-seeded",
      "https://box.example:27890"
    )
  })

  /**
   * Pairing a phone is a native Settings flow on the desktop, but `/pair` is
   * the route that actually exists everywhere else.
   */
  it.each([
    [{ tauri: true, capacitor: false, webCompanion: false }, "/settings?section=companion"],
    [{ tauri: false, capacitor: true, webCompanion: false }, "/pair"],
    [{ tauri: false, capacitor: false, webCompanion: true }, "/pair"],
  ])("routes pairing to the entry point that exists on this shell", async (flags, href) => {
    platform = flags
    renderConsole()
    await userEvent.click(screen.getByRole("button", { name: "Pair a device" }))
    expect(push).toHaveBeenCalledWith(href)
  })
})

it("labels the browser's execution Host and opens its capability detail", async () => {
  const companion = row({
    ref: "companion:paired-host",
    kind: "remote-host",
    label: "Paired server",
  })
  companion.runtime.isRoutingTarget = true
  rows = [LOCAL, companion]
  renderConsole()
  await userEvent.click(screen.getByRole("button", { name: "Execution host: Paired server" }))
  expect(screen.getByTestId("detail")).toHaveTextContent("companion:paired-host")
  expect(
    screen.queryByRole("button", { name: "Execution host: This machine" })
  ).not.toBeInTheDocument()
})

it("shows the sync approval notice only when the build has account sync and a device waits", () => {
  useAccountSyncStore.setState({ incoming: [{ requestId: "req_1" }] as never })
  const { unmount } = renderConsole()
  expect(screen.queryByTestId("sync-approval-fleet-notice")).not.toBeInTheDocument()
  unmount()
  jest.mocked(accountSyncEnabled).mockReturnValue(true)
  renderConsole()
  expect(screen.getByTestId("sync-approval-fleet-notice")).toBeInTheDocument()
  useAccountSyncStore.getState().reset()
  jest.mocked(accountSyncEnabled).mockReturnValue(false)
})
